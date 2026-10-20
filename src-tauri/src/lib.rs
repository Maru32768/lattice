mod browser;
mod renderer;

use std::sync::Arc;

use lattice_core::chain::{self, ChainEntry, LlmChain, ProviderKind};
use lattice_core::embed::{self, EmbeddingProvider, LocalE5};
use lattice_core::fetch::client;
use lattice_core::ir::PROSE_KINDS;
use lattice_core::jobs::{self, LLM_JOBS, LOCAL_JOBS, NET_JOBS, Providers};
use lattice_core::search::{self, SearchResult};
use lattice_core::segments::{self, Unit};
use lattice_core::url_norm::normalize;
use lattice_core::store::{ArticleFilter, ArticleRow, ArticleSort, ArticleView, SegmentRow, Store, TagCount};
use lattice_core::ingest::{self, ImportSummary};
use lattice_core::chat::{self, ChatMessage, ChatThread, Scope};
use lattice_core::feeds::{self, FeedRow};
use lattice_core::job_status::{self, JobOverview};
use lattice_core::{backup, classify, export, images, r2, render, summarize, translate};
use tauri::{Emitter, Manager, State, Webview};
use tokio::sync::{Notify, Semaphore};

use browser::Browser;

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
async fn save_page(app: State<'_, App>, browser: State<'_, Browser>, handle: tauri::AppHandle) -> Result<i64, String> {
    let id = match browser::snapshot(&handle, &browser).await {
        Some((url, html)) => ingest::save_rendered(&app.store, &url, html)?,
        None => {
            let wv = handle.get_webview(browser::LABEL).ok_or("the browser is not open")?;
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

/// The stored image of an image block as a `data:` URL, or `None` (the Reader then shows a link).
#[tauri::command(async)]
fn article_image(app: State<'_, App>, block_id: i64) -> Result<Option<String>, String> {
    images::data_url(&app.store, block_id)
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
    app.store.get_article(id, &translate::article_target(&app.store, id)?.key()).map_err(err)
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
fn translate_article(app: State<'_, App>, id: i64) -> Result<(), String> {
    translate::enqueue(&app.store, id, &translate::article_target(&app.store, id)?)?;
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
    log_dir: String,
    backup_dir: String,
    backup_keep: u64,
}

#[tauri::command]
fn get_settings(app: State<'_, App>, handle: tauri::AppHandle) -> Result<Settings, String> {
    Ok(Settings {
        db_path: app.db_path.clone(),
        log_dir: handle.path().app_log_dir().map_err(err)?.display().to_string(),
        backup_dir: backup_dir(&handle)?.display().to_string(),
        backup_keep: backup::keep_generations(&app.store)?,
    })
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

fn backup_dir(handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(handle.path().app_data_dir().map_err(err)?.join("backups"))
}

/// Writes a consistent copy of the database to app_data/backups and prunes old generations.
#[tauri::command(async)]
fn backup_db(app: State<'_, App>, handle: tauri::AppHandle) -> Result<backup::LocalBackup, String> {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(err)?.as_secs();
    backup::backup_local(&app.store, &backup_dir(&handle)?, secs)
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

/// Writes app_data/exports/lattice-export-<UTC>.jsonl.gz and returns its path.
#[tauri::command(async)]
fn export_json(app: State<'_, App>, handle: tauri::AppHandle) -> Result<String, String> {
    let dir = handle.path().app_data_dir().map_err(err)?.join("exports");
    Ok(export::export_file(&app.store, &dir)?.display().to_string())
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
async fn r2_backup_now(app: State<'_, App>, handle: tauri::AppHandle) -> Result<String, String> {
    r2::backup_now(&app.store, &r2::client(), app.db_path.as_ref(), &backup_dir(&handle)?).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .clear_targets()
                .level(log::LevelFilter::Info)
                .target(tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: Some("lattice".into()) }))
                .target(tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout))
                .build(),
        )
        .manage(Browser::default())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let path = dir.join("lattice.db");
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
            let runners = [(LLM_JOBS, wake_llm.clone()), (LOCAL_JOBS, wake_local.clone())]
                .into_iter()
                .chain(wake_net.iter().map(|w| (NET_JOBS, w.clone())));
            for (types, wake) in runners {
                let (handle, embedder_wake, llm_wake, render_wake) = (app.handle().clone(), wake_local.clone(), wake_llm.clone(), wake_render.clone());
                let on_change = move |article_id: i64| {
                    let _ = handle.emit("article-changed", article_id);
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

            app.manage(App { store, providers, wake_llm, wake_local, wake_net, wake_render, overlay_llm: Semaphore::new(OVERLAY_LLM_CONCURRENCY), chat_llm: Semaphore::new(CHAT_LLM_CONCURRENCY), db_path: path.display().to_string() });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            save_url,
            save_page,
            reextract_article,
            render_article,
            get_auto_render,
            set_auto_render,
            import_urls,
            article_image,
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
            list_feeds,
            add_feed,
            discover_feeds,
            remove_feed,
            refresh_feeds,
            set_favorite,
            add_tag,
            remove_tag,
            get_article,
            article_for_url,
            translate_article,
            summarize_article,
            search_blocks,
            chat_ask,
            chat_threads,
            chat_messages,
            chat_delete_thread,
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
            overlay_translate,
            browser::browser_open,
            browser::browser_set_bounds,
            browser::browser_hide,
            browser::browser_go,
            browser::browser_set_translation,
            browser::overlay_config,
            browser::overlay_snapshot,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
