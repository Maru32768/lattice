mod badge;
mod browser;
mod location;
mod renderer;
mod update;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use lattice_core::chain::{self, ChainEntry, LlmChain, ProviderKind};
use lattice_core::chat::{self, ChatMessage, ChatThread, Scope};
use lattice_core::embed::{self, EmbeddingProvider, LocalE5};
use lattice_core::feeds::{self, FeedRow};
use lattice_core::fetch::client;
use lattice_core::ingest::{self, ImportSummary};
use lattice_core::ir::PROSE_KINDS;
use lattice_core::job_status::{self, JobOverview};
use lattice_core::jobs::{self, LLM_JOBS, LOCAL_JOBS, NET_JOBS, Providers};
use lattice_core::search::{self, SearchResult};
use lattice_core::segments::{self, Unit};
use lattice_core::srs::Grade;
use lattice_core::store::JobRow;
use lattice_core::store::{ArticleFilter, ArticleRow, ArticleSort, ArticleView, SegmentRow, Store, TagCount};
use lattice_core::url_norm::normalize;
use lattice_core::{backup, classify, export, favicons, images, instructions, markdown, pdf, quiz, r2, render, summarize, translate};
use tauri::{Emitter, Manager, State, Webview};
use tokio::sync::{Notify, Semaphore};

use browser::{Browser, lock};
use lattice_core::msg;
use location::{Kind, Location};

/// Interactive (page overlay) LLM calls in flight at once; jobs run separately.
const OVERLAY_LLM_CONCURRENCY: usize = 3;
/// Chat questions in flight at once; also outside the job queue so they never wait behind it.
const CHAT_LLM_CONCURRENCY: usize = 2;
const OVERLAY_MAX_SNIPPETS: usize = 24;
const OVERLAY_MAX_SNIPPET_BYTES: usize = 20_000;
/// Parallel fetchers for bulk import (at most one per host: see `Store::claim_next_job`).
const NET_WORKERS: usize = 4;

struct App {
    store: Arc<Store>,
    providers: Arc<Providers<LlmChain, LocalE5>>,
    wake_llm: Arc<Notify>,
    wake_local: Arc<Notify>,
    wake_net: Vec<Arc<Notify>>,
    wake_render: Arc<Notify>,
    overlay_llm: Semaphore,
    chat_llm: Semaphore,
    db_path: String,
    data_dir: PathBuf,
    /// The folder `pick_data_dir` returned, waiting for `set_data_dir`.
    picked_dir: Mutex<Option<PathBuf>>,
}

fn err(e: impl ToString) -> String {
    e.to_string()
}

// Commands that touch the store are async or `command(async)`: sync commands run on the main
// (UI) thread, and waiting there for the store lock held by a background job freezes the window.

#[tauri::command]
async fn save_url(app: State<'_, App>, url: String) -> Result<i64, String> {
    let id = ingest::save_url(&app.store, &app.providers.http, &url).await?;
    if render::enqueue_if_auto(&app.store, id)? {
        app.wake_render.notify_one();
    }
    indexed(&app, id)
}

/// 「描画して取り込み直す」: loads the page in the hidden renderer and stores its DOM.
#[tauri::command(async)]
fn render_article(app: State<'_, App>, id: i64) -> Result<(), String> {
    render::enqueue(&app.store, id)?;
    app.wake_render.notify_one();
    Ok(())
}

#[tauri::command(async)]
fn get_auto_render(app: State<'_, App>) -> Result<bool, String> {
    render::auto_enabled(&app.store)
}

#[tauri::command(async)]
fn set_auto_render(app: State<'_, App>, on: bool) -> Result<(), String> {
    render::set_auto(&app.store, on)
}

/// The display language (G51), chosen in the UI; the backend reads it for native dialog titles.
const UI_LANGUAGE: &str = "ui_language";

/// `None` until the UI first stores the language it detected.
#[tauri::command(async)]
fn get_ui_language(app: State<'_, App>) -> Result<Option<String>, String> {
    app.store.setting(UI_LANGUAGE).map_err(err)
}

#[tauri::command(async)]
fn set_ui_language(app: State<'_, App>, lang: String) -> Result<(), String> {
    if !matches!(lang.as_str(), "ja" | "en") {
        return Err(format!("unknown language {lang:?}"));
    }
    app.store.set_setting(UI_LANGUAGE, Some(&lang)).map_err(err)
}

/// A native dialog's title in the display language.
fn ui_text(app: &App, ja: &'static str, en: &'static str) -> &'static str {
    if app.store.setting(UI_LANGUAGE).ok().flatten().as_deref() == Some("en") { en } else { ja }
}

/// Index every saved article; it is local and free, unlike translation.
fn indexed(app: &App, id: i64) -> Result<i64, String> {
    embed::enqueue(&app.store, id, app.providers.embedder.model_id())?;
    app.wake_local.notify_one();
    app.wake_net.iter().for_each(|w| w.notify_one()); // extraction has queued its images job
    classify::enqueue_if_auto(&app.store, id)?;
    app.wake_llm.notify_one();
    Ok(id)
}

/// "Index に追加" in the in-app browser: stores the page as rendered (JS-built pages have no
/// content in their server HTML), or fetches it from the server if the page does not answer.
#[tauri::command]
async fn save_page(app: State<'_, App>, browser: State<'_, Browser>, handle: tauri::AppHandle, tab: u32) -> Result<i64, String> {
    let id = match browser::snapshot(&handle, &browser, tab).await {
        // The overlay answers with nothing for a PDF the webview shows: the server sends the file.
        Some((url, html)) if !html.is_empty() => ingest::save_rendered(&app.store, &url, html)?,
        _ => {
            let wv = handle.get_webview(&browser::label(tab)).ok_or("the browser is not open")?;
            log::info!("no DOM snapshot from the page; fetching from the server");
            ingest::save_url(&app.store, &app.providers.http, wv.url().map_err(err)?.as_str()).await?
        }
    };
    indexed(&app, id)
}

/// Re-runs extraction on the stored snapshot (no network).
#[tauri::command(async)]
fn reextract_article(app: State<'_, App>, id: i64) -> Result<i64, String> {
    let id = ingest::reextract(&app.store, id)?;
    indexed(&app, id)
}

/// Bulk import: any text containing URLs (list, bookmarks HTML, CSV, JSON). Fetching happens
/// in the background; failures are recorded per article and never stop the rest.
#[tauri::command(async)]
fn import_urls(app: State<'_, App>, text: String) -> Result<ImportSummary, String> {
    let summary = ingest::enqueue_urls(&app.store, &ingest::extract_urls(&text))?;
    app.wake_net.iter().for_each(|w| w.notify_one());
    Ok(summary)
}

/// Markdown pasted into the import screen; the same text again opens the article it made.
#[tauri::command(async)]
fn import_markdown(app: State<'_, App>, text: String) -> Result<i64, String> {
    let id = markdown::import(&app.store, &text, None, None)?;
    indexed(&app, id)
}

/// Picks the file here rather than taking a path from the webview: relative images are read
/// only from the folder of a file the user chose. `None` when the dialog is cancelled.
#[tauri::command]
async fn import_markdown_file(app: State<'_, App>, handle: tauri::AppHandle) -> Result<Option<i64>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = handle.dialog().file().set_title(ui_text(&app, "Markdown を取り込む", "Import Markdown")).add_filter("Markdown", &["md", "markdown"]);
    if let Some(w) = handle.get_window("main") {
        dialog = dialog.set_parent(&w);
    }
    dialog.pick_file(move |p| {
        let _ = tx.send(p);
    });
    let Some(picked) = rx.await.map_err(err)? else { return Ok(None) };
    let path = picked.into_path().map_err(err)?;
    if std::fs::metadata(&path).map_err(err)?.len() > markdown::MAX_FILE_BYTES {
        return Err(msg!("file.tooLarge", max = markdown::MAX_FILE_BYTES / 1024 / 1024));
    }
    let text = String::from_utf8(std::fs::read(&path).map_err(err)?).map_err(|_| msg!("file.notUtf8"))?;
    let name = path.file_stem().map(|s| s.to_string_lossy().into_owned());
    let id = markdown::import(&app.store, &text, name.as_deref(), path.parent())?;
    indexed(&app, id).map(Some)
}

/// A paper's PDF, picked here like `import_markdown_file`. `None` when the dialog is cancelled.
#[tauri::command]
async fn import_pdf_file(app: State<'_, App>, handle: tauri::AppHandle) -> Result<Option<i64>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = handle.dialog().file().set_title(ui_text(&app, "PDF を取り込む", "Import a PDF")).add_filter("PDF", &["pdf"]);
    if let Some(w) = handle.get_window("main") {
        dialog = dialog.set_parent(&w);
    }
    dialog.pick_file(move |p| {
        let _ = tx.send(p);
    });
    let Some(picked) = rx.await.map_err(err)? else { return Ok(None) };
    let path = picked.into_path().map_err(err)?;
    if std::fs::metadata(&path).map_err(err)?.len() > pdf::MAX_BYTES as u64 {
        return Err(msg!("file.tooLarge", max = pdf::MAX_BYTES / 1024 / 1024));
    }
    let bytes = std::fs::read(&path).map_err(err)?;
    let name = path.file_stem().map(|s| s.to_string_lossy().into_owned());
    // Parsing a paper takes a moment of CPU; keep it off the async runtime's threads.
    let store = app.store.clone();
    let id = tokio::task::spawn_blocking(move || pdf::import(&store, &bytes, name.as_deref())).await.map_err(err)??;
    indexed(&app, id).map(Some)
}

/// The stored image of an image block as a `data:` URL, or `None` (the Reader then shows a link).
#[tauri::command(async)]
fn article_image(app: State<'_, App>, block_id: i64) -> Result<Option<String>, String> {
    images::data_url(&app.store, block_id)
}

/// A site's stored icon as a `data:` URL, or `None` (the UI shows its initial). Queues a
/// background fetch when there is none yet or it is a week old; `favicon-changed` follows.
#[tauri::command(async)]
fn favicon(app: State<'_, App>, domain: String) -> Result<Option<String>, String> {
    let (icon, queued) = favicons::get(&app.store, &domain)?;
    if queued {
        app.wake_net.iter().for_each(|w| w.notify_one());
    }
    Ok(icon)
}

#[tauri::command(async)]
fn get_image_settings(app: State<'_, App>) -> Result<images::ImageSettings, String> {
    images::settings(&app.store)
}

/// Switching saving on also queues the articles whose images were never tried.
#[tauri::command(async)]
fn set_image_settings(app: State<'_, App>, settings: images::ImageSettings) -> Result<(), String> {
    images::set_settings(&app.store, settings)?;
    if images::enqueue_missing(&app.store)? > 0 {
        app.wake_net.iter().for_each(|w| w.notify_one());
    }
    Ok(())
}

#[tauri::command(async)]
fn list_articles(app: State<'_, App>, filter: ArticleFilter, sort: Option<ArticleSort>) -> Result<Vec<ArticleRow>, String> {
    app.store.list_articles_sorted(&filter, sort.unwrap_or_default()).map_err(err)
}

#[tauri::command(async)]
fn list_genres(app: State<'_, App>) -> Result<Vec<TagCount>, String> {
    classify::list_genres(&app.store)
}

/// Renaming to an existing genre merges into it.
#[tauri::command(async)]
fn rename_genre(app: State<'_, App>, from: String, to: String) -> Result<(), String> {
    classify::rename_genre(&app.store, &from, &to)
}

#[tauri::command(async)]
fn delete_genre(app: State<'_, App>, name: String) -> Result<(), String> {
    classify::delete_genre(&app.store, &name)
}

/// Manual choice; an empty name clears it.
#[tauri::command(async)]
fn set_genre(app: State<'_, App>, id: i64, name: String) -> Result<(), String> {
    classify::set_genre(&app.store, id, &name)
}

/// Manual choice (1-5), pinned against auto runs; `None` clears it.
#[tauri::command(async)]
fn set_difficulty(app: State<'_, App>, id: i64, level: Option<i64>) -> Result<(), String> {
    classify::set_difficulty(&app.store, id, level)
}

#[tauri::command(async)]
fn classify_article(app: State<'_, App>, id: i64) -> Result<(), String> {
    classify::enqueue_manual(&app.store, id)?;
    app.wake_llm.notify_one();
    Ok(())
}

#[tauri::command(async)]
fn classify_unclassified(app: State<'_, App>) -> Result<usize, String> {
    let n = classify::enqueue_unclassified(&app.store)?;
    app.wake_llm.notify_one();
    Ok(n)
}

#[tauri::command(async)]
fn get_auto_classify(app: State<'_, App>) -> Result<bool, String> {
    classify::auto_enabled(&app.store)
}

#[tauri::command(async)]
fn set_auto_classify(app: State<'_, App>, on: bool) -> Result<(), String> {
    classify::set_auto(&app.store, on)
}

#[tauri::command(async)]
fn get_translate_keep_terms(app: State<'_, App>) -> Result<bool, String> {
    translate::keep_terms(&app.store)
}

#[tauri::command(async)]
fn set_translate_keep_terms(app: State<'_, App>, on: bool) -> Result<(), String> {
    translate::set_keep_terms(&app.store, on)
}

#[tauri::command(async)]
fn get_translate_instructions(app: State<'_, App>) -> Result<String, String> {
    translate::instructions(&app.store)
}

#[tauri::command(async)]
fn set_translate_instructions(app: State<'_, App>, text: String) -> Result<(), String> {
    translate::set_instructions(&app.store, &text)
}

#[tauri::command(async)]
fn get_custom_instructions(app: State<'_, App>) -> Result<instructions::Settings, String> {
    instructions::load(&app.store)
}

#[tauri::command(async)]
fn set_custom_instructions(app: State<'_, App>, settings: instructions::Settings) -> Result<(), String> {
    instructions::save(&app.store, &settings)
}

/// The built-in prompt the instructions extend (current term mode, English to Japanese).
#[tauri::command(async)]
fn get_translation_prompt(app: State<'_, App>) -> Result<String, String> {
    let target = translate::target(&app.store)?;
    Ok(segments::translation_prompt(&segments::Target { instructions: String::new(), ..target }))
}

#[tauri::command(async)]
fn list_feeds(app: State<'_, App>) -> Result<Vec<FeedRow>, String> {
    feeds::list(&app.store)
}

/// The URL itself if it is a feed, else the feeds its page links (or a common feed path).
#[tauri::command]
async fn discover_feeds(app: State<'_, App>, url: String) -> Result<Vec<feeds::Candidate>, String> {
    feeds::discover(&app.providers.http, &url).await
}

/// Subscribes and fetches right away; a new URL that is not a readable feed is not kept.
#[tauri::command]
async fn add_feed(app: State<'_, App>, url: String) -> Result<i64, String> {
    let (id, created) = feeds::add(&app.store, &url)?;
    match feeds::refresh(&app.store, &app.providers.http, id).await {
        Err(e) if created => {
            feeds::remove(&app.store, id)?;
            Err(e)
        }
        _ => {
            app.wake_net.iter().for_each(|w| w.notify_one());
            Ok(id)
        }
    }
}

#[tauri::command(async)]
fn remove_feed(app: State<'_, App>, id: i64) -> Result<(), String> {
    feeds::remove(&app.store, id)
}

/// `None` or blank goes back to the feed's own title.
#[tauri::command(async)]
fn rename_feed(app: State<'_, App>, id: i64, name: Option<String>) -> Result<(), String> {
    feeds::rename(&app.store, id, name.as_deref())
}

/// Image bytes picked by the user (checked and typed by content), or `None` for the site's favicon.
#[tauri::command(async)]
fn set_feed_icon(app: State<'_, App>, id: i64, bytes: Option<Vec<u8>>) -> Result<(), String> {
    feeds::set_icon(&app.store, id, bytes.as_deref())
}

/// The user's icon for a feed as a `data:` URL, or `None` (the UI then shows the site's favicon).
#[tauri::command(async)]
fn feed_icon(app: State<'_, App>, id: i64) -> Result<Option<String>, String> {
    feeds::icon(&app.store, id)
}

#[tauri::command]
async fn refresh_feeds(app: State<'_, App>) -> Result<usize, String> {
    let n = feeds::refresh_all(&app.store, &app.providers.http).await;
    app.wake_net.iter().for_each(|w| w.notify_one());
    Ok(n)
}

#[tauri::command(async)]
fn list_tags(app: State<'_, App>) -> Result<Vec<TagCount>, String> {
    app.store.list_tags().map_err(err)
}

#[tauri::command(async)]
fn set_favorite(app: State<'_, App>, id: i64, favorite: bool) -> Result<(), String> {
    app.store.set_favorite(id, favorite).map_err(err)
}

#[tauri::command(async)]
fn add_tag(app: State<'_, App>, id: i64, name: String) -> Result<(), String> {
    app.store.add_tag(id, &name).map_err(err)
}

#[tauri::command(async)]
fn remove_tag(app: State<'_, App>, id: i64, name: String) -> Result<(), String> {
    app.store.remove_tag(id, &name).map_err(err)
}

#[tauri::command(async)]
fn get_article(app: State<'_, App>, id: i64) -> Result<Option<ArticleView>, String> {
    let mut view = app.store.get_article(id, &translate::article_target(&app.store, id)?.key()).map_err(err)?;
    if let Some(v) = view.as_mut() {
        summarize::mark_stale(&app.store, v)?;
    }
    Ok(view)
}

/// Removes the article and everything derived from it (`Store::delete_article`).
#[tauri::command(async)]
fn delete_article(app: State<'_, App>, id: i64) -> Result<bool, String> {
    app.store.delete_article(id).map_err(err)
}

#[tauri::command(async)]
fn article_for_url(app: State<'_, App>, url: String) -> Result<Option<ArticleRow>, String> {
    let Ok(norm) = normalize(&url) else { return Ok(None) };
    match app.store.find_article_by_url(norm.as_str()).map_err(err)? {
        Some(id) => app.store.article_row(id).map_err(err),
        None => Ok(None),
    }
}

/// Translation for the page overlay: cached units where available, the LLM for the rest.
/// Snippets come from an untrusted page, so size and count are bounded. `target` is the
/// overlay's choice for the page ("en" for a Japanese page); anything else means Japanese.
#[tauri::command]
async fn overlay_translate(
    app: State<'_, App>,
    browser: State<'_, Browser>,
    webview: Webview,
    snippets: Vec<String>,
    target: Option<String>,
) -> Result<Vec<Option<Vec<Unit>>>, String> {
    browser::ensure_translation_allowed(&webview, &browser)?;
    if snippets.len() > OVERLAY_MAX_SNIPPETS || snippets.iter().any(|s| s.len() > OVERLAY_MAX_SNIPPET_BYTES) {
        return Err("request too large".into());
    }
    let to = translate::target(&app.store)?.for_source(target.as_deref() == Some("en"));
    let target = &to.key();
    let hashes: Vec<String> = snippets.iter().map(|s| segments::source_hash(s)).collect();
    let mut cached = app.store.cached_segments(&hashes, target).map_err(err)?;
    let mut misses: Vec<usize> = Vec::new();
    for (i, h) in hashes.iter().enumerate() {
        if !cached.contains_key(h) && !misses.iter().any(|&j| hashes[j] == *h) {
            misses.push(i);
        }
    }
    if !misses.is_empty() {
        let _permit = app.overlay_llm.acquire().await.map_err(err)?;
        let batch: Vec<String> = misses.iter().map(|&i| snippets[i].clone()).collect();
        let llm = &app.providers.llm;
        let t = segments::translate_snippets(llm, &batch, &to).await;
        let rows: Vec<SegmentRow> = misses
            .iter()
            .zip(&t.results)
            .filter_map(|(&i, r)| r.as_ref().map(|(u, o)| (hashes[i].as_str(), &u[..], o.provider.as_str(), o.model.as_deref())))
            .collect();
        app.store.insert_segments(target, segments::PROMPT_VERSION, &rows).map_err(err)?;
        for (&i, r) in misses.iter().zip(t.results) {
            if let Some((units, _)) = r {
                cached.insert(hashes[i].clone(), units);
            }
        }
        if let Some(e) = t.error {
            log::warn!("overlay translate: {e}");
        }
    }
    Ok(hashes.iter().map(|h| cached.get(h).cloned()).collect())
}

#[tauri::command(async)]
fn summarize_article(app: State<'_, App>, id: i64) -> Result<(), String> {
    summarize::enqueue(&app.store, id)?;
    app.wake_llm.notify_one();
    Ok(())
}

#[tauri::command(async)]
fn quiz_article(app: State<'_, App>, id: i64) -> Result<(), String> {
    quiz::enqueue(&app.store, id)?;
    app.wake_llm.notify_one();
    Ok(())
}

#[tauri::command(async)]
fn get_quiz(app: State<'_, App>, id: i64) -> Result<Option<quiz::QuizView>, String> {
    quiz::get(&app.store, id)
}

fn unix_now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

#[tauri::command(async)]
fn review_add(app: State<'_, App>, quiz_id: i64, answers: Vec<quiz::Answer>) -> Result<i64, String> {
    quiz::add(&app.store, quiz_id, &answers, unix_now())
}

#[tauri::command(async)]
fn review_grade(app: State<'_, App>, question_id: i64, grade: Grade) -> Result<(), String> {
    quiz::grade(&app.store, question_id, grade, unix_now())
}

#[tauri::command(async)]
fn review_remove_card(app: State<'_, App>, question_id: i64) -> Result<(), String> {
    quiz::remove_card(&app.store, question_id)
}

#[tauri::command(async)]
fn review_remove_article(app: State<'_, App>, article_id: i64) -> Result<(), String> {
    quiz::remove_article(&app.store, article_id)
}

#[tauri::command(async)]
fn review_queue(app: State<'_, App>) -> Result<Vec<quiz::ReviewItem>, String> {
    quiz::queue(&app.store, unix_now())
}

#[tauri::command(async)]
fn review_overview(app: State<'_, App>) -> Result<quiz::Overview, String> {
    quiz::overview(&app.store, unix_now())
}

#[tauri::command(async)]
fn get_review_settings(app: State<'_, App>) -> Result<quiz::Settings, String> {
    quiz::settings(&app.store)
}

#[tauri::command(async)]
fn set_review_settings(app: State<'_, App>, settings: quiz::Settings) -> Result<(), String> {
    quiz::set_settings(&app.store, &settings)
}

#[tauri::command(async)]
fn translate_article(app: State<'_, App>, id: i64, fresh: Option<bool>) -> Result<(), String> {
    let target = translate::article_target(&app.store, id)?;
    if fresh == Some(true) {
        translate::retranslate(&app.store, id, &target)?;
    } else {
        translate::enqueue(&app.store, id, &target)?;
    }
    app.wake_llm.notify_one();
    Ok(())
}

#[tauri::command]
async fn search_blocks(app: State<'_, App>, query: String, filter: Option<ArticleFilter>) -> Result<SearchResult, String> {
    let articles = app.store.article_ids(&filter.unwrap_or(ArticleFilter::All)).map_err(err)?;
    search::search(&app.store, &app.providers.embedder, &query, articles.as_deref(), &translate::target(&app.store)?, 30).await
}

#[tauri::command]
async fn chat_ask(app: State<'_, App>, thread_id: Option<i64>, question: String, scope: Scope) -> Result<ChatMessage, String> {
    let _permit = app.chat_llm.acquire().await.map_err(err)?;
    chat::ask(&app.store, &app.providers.llm, &app.providers.embedder, thread_id, &question, scope).await
}

#[tauri::command(async)]
fn chat_threads(app: State<'_, App>) -> Result<Vec<ChatThread>, String> {
    app.store.chat_threads().map_err(err)
}

#[tauri::command(async)]
fn chat_messages(app: State<'_, App>, thread_id: i64) -> Result<Vec<ChatMessage>, String> {
    app.store.chat_messages(thread_id).map_err(err)
}

#[tauri::command(async)]
fn chat_delete_thread(app: State<'_, App>, thread_id: i64) -> Result<(), String> {
    app.store.delete_chat_thread(thread_id).map_err(err)
}

#[tauri::command(async)]
fn get_chat_budget(app: State<'_, App>) -> Result<chat::Budget, String> {
    chat::budget(&app.store)
}

#[tauri::command(async)]
fn set_chat_budget(app: State<'_, App>, budget: chat::Budget) -> Result<(), String> {
    chat::set_budget(&app.store, budget)
}

#[tauri::command(async)]
fn set_read(app: State<'_, App>, id: i64, read: bool) -> Result<(), String> {
    app.store.set_read_status(id, read).map_err(err)
}

#[tauri::command]
fn db_path(app: State<'_, App>) -> String {
    app.db_path.clone()
}

#[derive(serde::Serialize)]
struct Settings {
    db_path: String,
    data_dir: String,
    location: Kind,
    /// Why the folder the user chose is not in use.
    location_warning: Option<String>,
    log_dir: String,
    backup_dir: String,
    backup_keep: u64,
}

#[tauri::command]
fn get_settings(app: State<'_, App>, loc: State<'_, Location>, handle: tauri::AppHandle) -> Result<Settings, String> {
    let log_dir = match loc.log_dir() {
        Some(d) => d,
        None => handle.path().app_log_dir().map_err(err)?,
    };
    Ok(Settings {
        db_path: app.db_path.clone(),
        data_dir: app.data_dir.display().to_string(),
        location: loc.kind,
        location_warning: loc.warning.clone(),
        log_dir: log_dir.display().to_string(),
        backup_dir: backup_dir(&app).display().to_string(),
        backup_keep: backup::keep_generations(&app.store)?,
    })
}

#[derive(serde::Serialize)]
struct PickedDir {
    path: String,
    /// It already holds a Lattice database, which `set_data_dir` can switch to instead of copying.
    has_data: bool,
}

/// Picks the new data folder with a native dialog (the webview never passes a path).
#[tauri::command]
async fn pick_data_dir(app: State<'_, App>, loc: State<'_, Location>, handle: tauri::AppHandle) -> Result<Option<PickedDir>, String> {
    use tauri_plugin_dialog::DialogExt;
    if loc.kind == Kind::Portable {
        return Err(msg!("location.portable"));
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = handle.dialog().file().set_title(ui_text(&app, "データの保存場所を選ぶ", "Choose where to keep the data")).set_directory(&app.data_dir);
    if let Some(w) = handle.get_window("main") {
        dialog = dialog.set_parent(&w);
    }
    dialog.pick_folder(move |p| {
        let _ = tx.send(p);
    });
    let Some(picked) = rx.await.map_err(err)? else { return Ok(None) };
    let path = picked.into_path().map_err(err)?;
    let canonical = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    location::check_target(&canonical(&app.data_dir), &canonical(&path))?;
    let has_data = path.join(location::DB_FILE).exists();
    *lock(&app.picked_dir) = Some(path.clone());
    Ok(Some(PickedDir { path: path.display().to_string(), has_data }))
}

/// Uses the picked folder from the next start: copies the data there (`copy`), or switches to the
/// Lattice data already in it. The current folder is left as it is.
#[tauri::command]
async fn set_data_dir(app: State<'_, App>, handle: tauri::AppHandle, copy: bool) -> Result<String, String> {
    let target = lock(&app.picked_dir).take().ok_or_else(|| msg!("location.pickAgain"))?;
    let has_data = target.join(location::DB_FILE).exists();
    if copy && has_data {
        return Err(msg!("location.hasData"));
    }
    if !copy && !has_data {
        return Err(msg!("location.noData"));
    }
    if copy {
        let (store, from, to) = (app.store.clone(), app.data_dir.clone(), target.clone());
        tauri::async_runtime::spawn_blocking(move || location::copy_data(&store, &from, &to)).await.map_err(err)??;
        log::info!("copied the data from {} to {}", app.data_dir.display(), target.display());
    }
    let default_dir = handle.path().app_data_dir().map_err(err)?;
    location::write_bootstrap(&default_dir, &target)
        .map_err(|e| msg!("location.recordFailed", path = default_dir.join(location::BOOTSTRAP_FILE).display().to_string(), error = e.to_string()))?;
    Ok(target.display().to_string())
}

#[tauri::command]
fn restart_app(handle: tauri::AppHandle) {
    handle.restart()
}

/// Fallback chain plus where each API key comes from ("stored" / "env"); never the keys.
#[derive(serde::Serialize)]
struct LlmSettings {
    chain: Vec<ChainEntry>,
    openai_key: Option<&'static str>,
    gemini_key: Option<&'static str>,
    anthropic_key: Option<&'static str>,
}

#[tauri::command(async)]
fn get_llm_settings(app: State<'_, App>) -> Result<LlmSettings, String> {
    let source = |k| chain::api_key(&app.store, k).map(|o| o.map(|(_, s)| s));
    Ok(LlmSettings {
        chain: chain::load_config(&app.store)?,
        openai_key: source(ProviderKind::Openai)?,
        gemini_key: source(ProviderKind::Gemini)?,
        anthropic_key: source(ProviderKind::Anthropic)?,
    })
}

#[tauri::command(async)]
fn set_llm_chain(app: State<'_, App>, chain: Vec<ChainEntry>) -> Result<(), String> {
    chain::save_config(&app.store, chain)?;
    app.providers.llm.set(chain::load(&app.store)?);
    Ok(())
}

#[tauri::command(async)]
fn set_api_key(app: State<'_, App>, kind: ProviderKind, key: Option<String>) -> Result<(), String> {
    chain::set_api_key(&app.store, kind, key.as_deref())?;
    app.providers.llm.set(chain::load(&app.store)?);
    Ok(())
}

fn backup_dir(app: &App) -> PathBuf {
    app.data_dir.join("backups")
}

/// Writes a consistent copy of the database to app_data/backups and prunes old generations.
#[tauri::command(async)]
fn backup_db(app: State<'_, App>) -> Result<backup::LocalBackup, String> {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(err)?.as_secs();
    backup::backup_local(&app.store, &backup_dir(&app), secs)
}

#[tauri::command(async)]
fn set_backup_keep(app: State<'_, App>, keep: u64) -> Result<(), String> {
    backup::set_keep_generations(&app.store, keep)
}

/// Wakes the runner for `job_type`, or every runner.
fn wake(app: &App, job_type: Option<&str>) {
    let is = |types: &[&str]| job_type.is_none_or(|t| types.contains(&t));
    if is(LLM_JOBS) {
        app.wake_llm.notify_one();
    }
    if is(LOCAL_JOBS) {
        app.wake_local.notify_one();
    }
    if is(NET_JOBS) {
        app.wake_net.iter().for_each(|w| w.notify_one());
    }
}

#[tauri::command(async)]
fn job_overview(app: State<'_, App>) -> Result<JobOverview, String> {
    job_status::overview(&app.store)
}

#[tauri::command(async)]
fn retry_job(app: State<'_, App>, id: i64) -> Result<bool, String> {
    let t = job_status::retry(&app.store, id)?;
    if let Some(t) = &t {
        wake(&app, Some(t));
    }
    Ok(t.is_some())
}

#[tauri::command(async)]
fn retry_failed_jobs(app: State<'_, App>, job_type: Option<String>) -> Result<usize, String> {
    let n = job_status::retry_failed(&app.store, job_type.as_deref())?;
    wake(&app, job_type.as_deref());
    Ok(n)
}

#[tauri::command(async)]
fn cancel_job(app: State<'_, App>, id: i64) -> Result<bool, String> {
    job_status::cancel(&app.store, id)
}

/// Writes <data>/exports/lattice-export-<UTC>.jsonl.gz and returns its path.
#[tauri::command(async)]
fn export_json(app: State<'_, App>) -> Result<String, String> {
    Ok(export::export_file(&app.store, &app.data_dir.join("exports"))?.display().to_string())
}

#[tauri::command(async)]
fn r2_status(app: State<'_, App>) -> Result<r2::R2Status, String> {
    r2::status(&app.store)
}

#[tauri::command(async)]
fn r2_save(app: State<'_, App>, settings: r2::R2Settings) -> Result<(), String> {
    r2::save(&app.store, settings)
}

#[tauri::command(async)]
fn r2_clear_secret(app: State<'_, App>) -> Result<(), String> {
    r2::clear_secret(&app.store)
}

#[tauri::command]
async fn r2_backup_now(app: State<'_, App>) -> Result<String, String> {
    r2::backup_now(&app.store, &r2::client(), app.db_path.as_ref(), &backup_dir(&app)).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Browser::default())
        .manage(badge::Badge::default())
        .setup(|app| {
            let loc = location::detect(&app.path().app_data_dir()?);
            // The log folder follows the data in portable mode, so the plugin is added here.
            let file_name = Some("lattice".to_string());
            let log_file = match loc.log_dir() {
                Some(path) => tauri_plugin_log::TargetKind::Folder { path, file_name },
                None => tauri_plugin_log::TargetKind::LogDir { file_name },
            };
            app.handle().plugin(
                tauri_plugin_log::Builder::new()
                    .clear_targets()
                    .level(log::LevelFilter::Info)
                    .target(tauri_plugin_log::Target::new(log_file))
                    .target(tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout))
                    .build(),
            )?;
            if let Some(w) = &loc.warning {
                log::warn!("{w}");
            }
            // Created here rather than from the config so a portable install can give it its own
            // WebView2 profile folder (tauri.conf.json has `create: false`).
            let conf = app.config().app.windows.iter().find(|w| w.label == "main").cloned().ok_or("no main window in tauri.conf.json")?;
            let mut main = tauri::WebviewWindowBuilder::from_config(app.handle(), &conf)?;
            if let Some(d) = loc.webview_dir() {
                main = main.data_directory(d);
            }
            main.build()?;

            let dir = loc.dir.clone();
            app.manage(loc);
            let path = dir.join(location::DB_FILE);
            let store = Arc::new(Store::open(&path)?);
            let llm = LlmChain::new(chain::load(&store)?);
            let providers = Arc::new(Providers { llm, embedder: LocalE5::new(dir.join("models")), http: client() });

            store.recover_running_jobs()?;
            store.enqueue_missing_embeddings(embed::JOB_TYPE, providers.embedder.model_id(), PROSE_KINDS)?;
            images::enqueue_missing(&store)?;
            classify::enqueue_missing(&store)?;

            let (wake_llm, wake_local) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
            let wake_net: Vec<Arc<Notify>> = (0..NET_WORKERS).map(|_| Arc::new(Notify::new())).collect();
            let wake_render = Arc::new(Notify::new());
            let runners = [(LLM_JOBS, wake_llm.clone()), (LOCAL_JOBS, wake_local.clone())].into_iter().chain(wake_net.iter().map(|w| (NET_JOBS, w.clone())));
            for (types, wake) in runners {
                let (handle, embedder_wake, llm_wake, render_wake) = (app.handle().clone(), wake_local.clone(), wake_llm.clone(), wake_render.clone());
                let on_change = move |job: &JobRow| {
                    let _ = match job.article_id {
                        Some(id) => handle.emit("article-changed", id),
                        // Favicon jobs are per domain, not per article.
                        None => match job.params.as_deref().and_then(|p| serde_json::from_str::<serde_json::Value>(p).ok()) {
                            Some(p) if job.job_type == favicons::JOB_TYPE => handle.emit("favicon-changed", p["domain"].as_str()),
                            _ => Ok(()),
                        },
                    };
                    if types == NET_JOBS {
                        embedder_wake.notify_one(); // a fetched article has just queued its embed job
                        llm_wake.notify_one(); // ... and maybe its classify job
                        render_wake.notify_one(); // ... and, if it came back thin, a render job
                    }
                };
                tauri::async_runtime::spawn(jobs::run_worker(store.clone(), providers.clone(), types, wake, on_change));
            }
            // Rendering is heavy and needs the webview, so it has its own single runner here.
            let (handle, embedder_wake, llm_wake, net_wake) = (app.handle().clone(), wake_local.clone(), wake_llm.clone(), wake_net.clone());
            let on_render = move |article_id: i64| {
                let _ = handle.emit("article-changed", article_id);
                embedder_wake.notify_one();
                llm_wake.notify_one();
                net_wake.iter().for_each(|w| w.notify_one()); // the stored rendering has queued its images job
            };
            let embed_model = providers.embedder.model_id().to_string();
            tauri::async_runtime::spawn(renderer::run(app.handle().clone(), store.clone(), embed_model, wake_render.clone(), on_render));

            tauri::async_runtime::spawn(r2::run_scheduler(store.clone(), path.clone(), dir.join("backups")));

            let (handle, fetchers) = (app.handle().clone(), wake_net.clone());
            tauri::async_runtime::spawn(feeds::poll_forever(store.clone(), providers.http.clone(), move |queued| {
                if queued > 0 {
                    fetchers.iter().for_each(|w| w.notify_one());
                }
                let _ = handle.emit("feeds-changed", queued);
            }));

            app.manage(App {
                store,
                providers,
                wake_llm,
                wake_local,
                wake_net,
                wake_render,
                overlay_llm: Semaphore::new(OVERLAY_LLM_CONCURRENCY),
                chat_llm: Semaphore::new(CHAT_LLM_CONCURRENCY),
                db_path: path.display().to_string(),
                data_dir: dir,
                picked_dir: Mutex::new(None),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            save_url,
            save_page,
            reextract_article,
            render_article,
            get_auto_render,
            get_ui_language,
            set_ui_language,
            set_auto_render,
            import_urls,
            import_markdown,
            import_markdown_file,
            import_pdf_file,
            article_image,
            favicon,
            get_image_settings,
            set_image_settings,
            list_articles,
            list_tags,
            list_genres,
            set_genre,
            rename_genre,
            delete_genre,
            set_difficulty,
            classify_article,
            classify_unclassified,
            get_auto_classify,
            set_auto_classify,
            get_translate_keep_terms,
            set_translate_keep_terms,
            get_translate_instructions,
            set_translate_instructions,
            get_translation_prompt,
            get_custom_instructions,
            set_custom_instructions,
            list_feeds,
            add_feed,
            discover_feeds,
            remove_feed,
            refresh_feeds,
            rename_feed,
            set_feed_icon,
            feed_icon,
            set_favorite,
            add_tag,
            remove_tag,
            get_article,
            delete_article,
            article_for_url,
            translate_article,
            summarize_article,
            quiz_article,
            get_quiz,
            review_add,
            review_grade,
            review_remove_card,
            review_remove_article,
            review_queue,
            review_overview,
            get_review_settings,
            set_review_settings,
            search_blocks,
            chat_ask,
            chat_threads,
            chat_messages,
            chat_delete_thread,
            get_chat_budget,
            set_chat_budget,
            set_read,
            db_path,
            get_settings,
            get_llm_settings,
            set_llm_chain,
            set_api_key,
            backup_db,
            set_backup_keep,
            r2_status,
            r2_save,
            r2_clear_secret,
            r2_backup_now,
            job_overview,
            retry_job,
            retry_failed_jobs,
            cancel_job,
            export_json,
            pick_data_dir,
            set_data_dir,
            restart_app,
            overlay_translate,
            badge::set_unread_badge,
            badge::get_taskbar_badge,
            badge::set_taskbar_badge,
            browser::browser_open,
            browser::browser_set_bounds,
            browser::browser_hide,
            browser::browser_close,
            browser::browser_capture,
            browser::browser_go,
            browser::browser_set_translation,
            browser::overlay_config,
            browser::overlay_snapshot,
            browser::overlay_history,
            browser::browser_set_keys,
            browser::overlay_key,
            update::update_info,
            update::update_check,
            update::update_install,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
