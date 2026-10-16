use std::sync::Arc;

use lattice_core::claude::ClaudeCli;
use lattice_core::embed::{self, EmbeddingProvider, LocalE5};
use lattice_core::fetch::{HttpClient, client};
use lattice_core::ir::PROSE_KINDS;
use lattice_core::jobs::{self, LLM_JOBS, LOCAL_JOBS, Providers};
use lattice_core::search::{self, SearchResult};
use lattice_core::store::{ArticleRow, ArticleView, Store};
use lattice_core::{ingest, translate};
use tauri::{Emitter, Manager, State};
use tokio::sync::Notify;

struct App {
    store: Arc<Store>,
    http: HttpClient,
    providers: Arc<Providers<ClaudeCli, LocalE5>>,
    wake_llm: Arc<Notify>,
    wake_local: Arc<Notify>,
    db_path: String,
}

fn err(e: impl ToString) -> String {
    e.to_string()
}

#[tauri::command]
async fn save_url(app: State<'_, App>, url: String) -> Result<i64, String> {
    let id = ingest::save_url(&app.store, &app.http, &url).await?;
    // Index every saved article; it is local and free, unlike translation.
    embed::enqueue(&app.store, id, app.providers.embedder.model_id())?;
    app.wake_local.notify_one();
    Ok(id)
}

#[tauri::command]
fn list_articles(app: State<'_, App>) -> Result<Vec<ArticleRow>, String> {
    app.store.list_articles().map_err(err)
}

#[tauri::command]
fn get_article(app: State<'_, App>, id: i64) -> Result<Option<ArticleView>, String> {
    app.store.get_article(id, translate::TARGET_LANGUAGE).map_err(err)
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
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let path = dir.join("lattice.db");
            let store = Arc::new(Store::open(&path)?);
            let providers = Arc::new(Providers { llm: ClaudeCli::default(), embedder: LocalE5::new(dir.join("models")) });

            store.recover_running_jobs()?;
            store.enqueue_missing_embeddings(embed::JOB_TYPE, providers.embedder.model_id(), PROSE_KINDS)?;

            let (wake_llm, wake_local) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
            for (types, wake) in [(LLM_JOBS, wake_llm.clone()), (LOCAL_JOBS, wake_local.clone())] {
                let handle = app.handle().clone();
                let on_change = move |article_id: i64| {
                    let _ = handle.emit("article-changed", article_id);
                };
                tauri::async_runtime::spawn(jobs::run_worker(store.clone(), providers.clone(), types, wake, on_change));
            }

            app.manage(App { store, http: client(), providers, wake_llm, wake_local, db_path: path.display().to_string() });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            save_url, list_articles, get_article, translate_article, search_blocks, set_read, db_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
