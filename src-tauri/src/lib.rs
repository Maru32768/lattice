mod browser;

use std::sync::Arc;

use lattice_core::claude::ClaudeCli;
use lattice_core::embed::{self, EmbeddingProvider, LocalE5};
use lattice_core::fetch::client;
use lattice_core::ir::PROSE_KINDS;
use lattice_core::jobs::{self, LLM_JOBS, LOCAL_JOBS, NET_JOBS, Providers};
use lattice_core::search::{self, SearchResult};
use lattice_core::segments::{self, Unit};
use lattice_core::url_norm::normalize;
use lattice_core::store::{ArticleFilter, ArticleRow, ArticleView, Store, TagCount};
use lattice_core::ingest::{self, ImportSummary};
use lattice_core::translate;
use tauri::{Emitter, Manager, State, Webview};
use tokio::sync::{Notify, Semaphore};

use browser::Browser;

/// Interactive (page overlay) LLM calls in flight at once; jobs run separately.
const OVERLAY_LLM_CONCURRENCY: usize = 3;
const OVERLAY_MAX_SNIPPETS: usize = 24;
const OVERLAY_MAX_SNIPPET_BYTES: usize = 20_000;
/// Parallel fetchers for bulk import.
// shortcut: no per-host politeness limit; add one if imports hammer a single site.
const NET_WORKERS: usize = 4;

struct App {
    store: Arc<Store>,
    providers: Arc<Providers<ClaudeCli, LocalE5>>,
    wake_llm: Arc<Notify>,
    wake_local: Arc<Notify>,
    wake_net: Vec<Arc<Notify>>,
    overlay_llm: Semaphore,
    db_path: String,
}

fn err(e: impl ToString) -> String {
    e.to_string()
}

#[tauri::command]
async fn save_url(app: State<'_, App>, url: String) -> Result<i64, String> {
    let id = ingest::save_url(&app.store, &app.providers.http, &url).await?;
    // Index every saved article; it is local and free, unlike translation.
    embed::enqueue(&app.store, id, app.providers.embedder.model_id())?;
    app.wake_local.notify_one();
    Ok(id)
}

/// Bulk import: any text containing URLs (list, bookmarks HTML, CSV, JSON). Fetching happens
/// in the background; failures are recorded per article and never stop the rest.
#[tauri::command]
fn import_urls(app: State<'_, App>, text: String) -> Result<ImportSummary, String> {
    let summary = ingest::enqueue_urls(&app.store, &ingest::extract_urls(&text))?;
    app.wake_net.iter().for_each(|w| w.notify_one());
    Ok(summary)
}

#[tauri::command]
fn list_articles(app: State<'_, App>, filter: ArticleFilter) -> Result<Vec<ArticleRow>, String> {
    app.store.list_articles(&filter).map_err(err)
}

#[tauri::command]
fn list_tags(app: State<'_, App>) -> Result<Vec<TagCount>, String> {
    app.store.list_tags().map_err(err)
}

#[tauri::command]
fn set_favorite(app: State<'_, App>, id: i64, favorite: bool) -> Result<(), String> {
    app.store.set_favorite(id, favorite).map_err(err)
}

#[tauri::command]
fn add_tag(app: State<'_, App>, id: i64, name: String) -> Result<(), String> {
    app.store.add_tag(id, &name).map_err(err)
}

#[tauri::command]
fn remove_tag(app: State<'_, App>, id: i64, name: String) -> Result<(), String> {
    app.store.remove_tag(id, &name).map_err(err)
}

#[tauri::command]
fn get_article(app: State<'_, App>, id: i64) -> Result<Option<ArticleView>, String> {
    app.store.get_article(id, translate::TARGET_LANGUAGE).map_err(err)
}

#[tauri::command]
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
    let target = translate::TARGET_LANGUAGE;
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
        app.store.insert_segments(target, llm.name(), t.model.as_deref(), segments::PROMPT_VERSION, &rows).map_err(err)?;
        for (&i, r) in misses.iter().zip(t.results) {
            if let Some(units) = r {
                cached.insert(hashes[i].clone(), units);
            }
        }
        if let Some(e) = t.error {
            eprintln!("overlay translate: {e}");
        }
    }
    Ok(hashes.iter().map(|h| cached.get(h).cloned()).collect())
}

#[tauri::command]
fn translate_article(app: State<'_, App>, id: i64) -> Result<(), String> {
    translate::enqueue(&app.store, id, translate::TARGET_LANGUAGE)?;
    app.wake_llm.notify_one();
    Ok(())
}

#[tauri::command]
async fn search_blocks(app: State<'_, App>, query: String) -> Result<SearchResult, String> {
    search::search(&app.store, &app.providers.embedder, &query, translate::TARGET_LANGUAGE, 30).await
}

#[tauri::command]
fn set_read(app: State<'_, App>, id: i64, read: bool) -> Result<(), String> {
    app.store.set_read_status(id, read).map_err(err)
}

#[tauri::command]
fn db_path(app: State<'_, App>) -> String {
    app.db_path.clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Browser::default())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let path = dir.join("lattice.db");
            let store = Arc::new(Store::open(&path)?);
            let providers = Arc::new(Providers { llm: ClaudeCli::default(), embedder: LocalE5::new(dir.join("models")), http: client() });

            store.recover_running_jobs()?;
            store.enqueue_missing_embeddings(embed::JOB_TYPE, providers.embedder.model_id(), PROSE_KINDS)?;

            let (wake_llm, wake_local) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
            let wake_net: Vec<Arc<Notify>> = (0..NET_WORKERS).map(|_| Arc::new(Notify::new())).collect();
            let runners = [(LLM_JOBS, wake_llm.clone()), (LOCAL_JOBS, wake_local.clone())]
                .into_iter()
                .chain(wake_net.iter().map(|w| (NET_JOBS, w.clone())));
            for (types, wake) in runners {
                let (handle, embedder_wake) = (app.handle().clone(), wake_local.clone());
                let on_change = move |article_id: i64| {
                    let _ = handle.emit("article-changed", article_id);
                    if types == NET_JOBS {
                        embedder_wake.notify_one(); // a fetched article has just queued its embed job
                    }
                };
                tauri::async_runtime::spawn(jobs::run_worker(store.clone(), providers.clone(), types, wake, on_change));
            }

            app.manage(App { store, providers, wake_llm, wake_local, wake_net, overlay_llm: Semaphore::new(OVERLAY_LLM_CONCURRENCY), db_path: path.display().to_string() });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            save_url,
            import_urls,
            list_articles,
            list_tags,
            set_favorite,
            add_tag,
            remove_tag,
            get_article,
            article_for_url,
            translate_article,
            search_blocks,
            set_read,
            db_path,
            overlay_translate,
            browser::browser_open,
            browser::browser_set_bounds,
            browser::browser_hide,
            browser::browser_go,
            browser::browser_set_translation,
            browser::overlay_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
