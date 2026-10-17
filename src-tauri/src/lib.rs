mod browser;

use std::sync::Arc;

use lattice_core::chain::{self, ChainEntry, LlmChain, ProviderKind};
use lattice_core::embed::{self, EmbeddingProvider, LocalE5};
use lattice_core::fetch::client;
use lattice_core::ir::PROSE_KINDS;
use lattice_core::jobs::{self, LLM_JOBS, LOCAL_JOBS, NET_JOBS, Providers};
use lattice_core::search::{self, SearchResult};
use lattice_core::segments::{self, Unit};
use lattice_core::url_norm::normalize;
use lattice_core::store::{ArticleFilter, ArticleRow, ArticleSort, ArticleView, Store, TagCount};
use lattice_core::ingest::{self, ImportSummary};
use lattice_core::chat::{self, ChatMessage, ChatThread, Scope};
use lattice_core::feeds::{self, FeedRow};
use lattice_core::{classify, r2, summarize, translate};
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
    indexed(&app, id)
}

/// Index every saved article; it is local and free, unlike translation.
fn indexed(app: &App, id: i64) -> Result<i64, String> {
    embed::enqueue(&app.store, id, app.providers.embedder.model_id())?;
    app.wake_local.notify_one();
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

#[tauri::command(async)]
fn list_articles(app: State<'_, App>, filter: ArticleFilter, sort: Option<ArticleSort>) -> Result<Vec<ArticleRow>, String> {
    app.store.list_articles_sorted(&filter, sort.unwrap_or_default()).map_err(err)
}

#[tauri::command(async)]
fn list_genres(app: State<'_, App>) -> Result<Vec<TagCount>, String> {
    classify::list_genres(&app.store)
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
fn list_feeds(app: State<'_, App>) -> Result<Vec<FeedRow>, String> {
    feeds::list(&app.store)
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
    app.store.get_article(id, &translate::target(&app.store)?).map_err(err)
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
/// Snippets come from an untrusted page, so size and count are bounded.
#[tauri::command]
async fn overlay_translate(
    app: State<'_, App>,
    browser: State<'_, Browser>,
    webview: Webview,
    snippets: Vec<String>,
) -> Result<Vec<Option<Vec<Unit>>>, String> {
    browser::ensure_translation_allowed(&webview, &browser)?;
    if snippets.len() > OVERLAY_MAX_SNIPPETS || snippets.iter().any(|s| s.len() > OVERLAY_MAX_SNIPPET_BYTES) {
        return Err("request too large".into());
    }
    let target = &translate::target(&app.store)?;
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
        let t = segments::translate_snippets(llm, &batch, translate::SOURCE_LANGUAGE, target).await;
        let rows: Vec<(&str, &[Unit])> =
            misses.iter().zip(&t.results).filter_map(|(&i, r)| r.as_deref().map(|u| (hashes[i].as_str(), u))).collect();
        use lattice_core::llm::LlmProvider;
        app.store.insert_segments(target, t.provider.as_deref().unwrap_or(llm.name()), t.model.as_deref(), segments::PROMPT_VERSION, &rows).map_err(err)?;
        for (&i, r) in misses.iter().zip(t.results) {
            if let Some(units) = r {
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
    translate::enqueue(&app.store, id, &translate::target(&app.store)?)?;
    app.wake_llm.notify_one();
    Ok(())
}

#[tauri::command]
async fn search_blocks(app: State<'_, App>, query: String) -> Result<SearchResult, String> {
    search::search(&app.store, &app.providers.embedder, &query, None, &translate::target(&app.store)?, 30).await
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
}

#[tauri::command]
fn get_settings(app: State<'_, App>, handle: tauri::AppHandle) -> Result<Settings, String> {
    Ok(Settings {
        db_path: app.db_path.clone(),
        log_dir: handle.path().app_log_dir().map_err(err)?.display().to_string(),
        backup_dir: backup_dir(&handle)?.display().to_string(),
    })
}

/// Fallback chain plus where each API key comes from ("stored" / "env"); never the keys.
#[derive(serde::Serialize)]
struct LlmSettings {
    chain: Vec<ChainEntry>,
    openai_key: Option<&'static str>,
    gemini_key: Option<&'static str>,
}

#[tauri::command(async)]
fn get_llm_settings(app: State<'_, App>) -> Result<LlmSettings, String> {
    let source = |k| chain::api_key(&app.store, k).map(|o| o.map(|(_, s)| s));
    Ok(LlmSettings { chain: chain::load_config(&app.store)?, openai_key: source(ProviderKind::Openai)?, gemini_key: source(ProviderKind::Gemini)? })
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

/// Writes a consistent copy of the database to app_data/backups and returns its path.
#[tauri::command(async)]
fn backup_db(app: State<'_, App>, handle: tauri::AppHandle) -> Result<String, String> {
    let dir = backup_dir(&handle)?;
    std::fs::create_dir_all(&dir).map_err(err)?;
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(err)?.as_secs();
    let path = dir.join(format!("lattice-{secs}.db"));
    app.store.backup_to(&path).map_err(err)?;
    log::info!("backup written to {}", path.display());
    Ok(path.display().to_string())
}

#[tauri::command(async)]
fn r2_status(app: State<'_, App>) -> Result<r2::R2Status, String> {
    r2::status(&app.store)
}

#[tauri::command(async)]
fn r2_save(app: State<'_, App>, settings: r2::R2Settings) -> Result<(), String> {
    r2::save(&app.store, settings)
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

            let (wake_llm, wake_local) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
            let wake_net: Vec<Arc<Notify>> = (0..NET_WORKERS).map(|_| Arc::new(Notify::new())).collect();
            let runners = [(LLM_JOBS, wake_llm.clone()), (LOCAL_JOBS, wake_local.clone())]
                .into_iter()
                .chain(wake_net.iter().map(|w| (NET_JOBS, w.clone())));
            for (types, wake) in runners {
                let (handle, embedder_wake, llm_wake) = (app.handle().clone(), wake_local.clone(), wake_llm.clone());
                let on_change = move |article_id: i64| {
                    let _ = handle.emit("article-changed", article_id);
                    if types == NET_JOBS {
                        embedder_wake.notify_one(); // a fetched article has just queued its embed job
                        llm_wake.notify_one(); // ... and maybe its classify job
                    }
                };
                tauri::async_runtime::spawn(jobs::run_worker(store.clone(), providers.clone(), types, wake, on_change));
            }

            tauri::async_runtime::spawn(r2::run_scheduler(store.clone(), path.clone(), dir.join("backups")));

            let (handle, fetchers) = (app.handle().clone(), wake_net.clone());
            tauri::async_runtime::spawn(feeds::poll_forever(store.clone(), providers.http.clone(), move |queued| {
                if queued > 0 {
                    fetchers.iter().for_each(|w| w.notify_one());
                }
                let _ = handle.emit("feeds-changed", queued);
            }));

            app.manage(App { store, providers, wake_llm, wake_local, wake_net, overlay_llm: Semaphore::new(OVERLAY_LLM_CONCURRENCY), chat_llm: Semaphore::new(CHAT_LLM_CONCURRENCY), db_path: path.display().to_string() });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            save_url,
            save_page,
            reextract_article,
            import_urls,
            list_articles,
            list_tags,
            list_genres,
            set_genre,
            set_difficulty,
            classify_article,
            classify_unclassified,
            get_auto_classify,
            set_auto_classify,
            get_translate_keep_terms,
            set_translate_keep_terms,
            list_feeds,
            add_feed,
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
            r2_status,
            r2_save,
            r2_backup_now,
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
