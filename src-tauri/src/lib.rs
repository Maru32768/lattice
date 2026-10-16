use std::sync::Arc;

use lattice_core::claude::ClaudeCli;
use lattice_core::fetch::{HttpClient, client};
use lattice_core::store::{ArticleRow, ArticleView, Store};
use lattice_core::{ingest, jobs, translate};
use tauri::{Emitter, Manager, State};
use tokio::sync::Notify;

struct App {
    store: Arc<Store>,
    http: HttpClient,
    wake_worker: Arc<Notify>,
    db_path: String,
}

fn err(e: impl ToString) -> String {
    e.to_string()
}

#[tauri::command]
async fn save_url(app: State<'_, App>, url: String) -> Result<i64, String> {
    ingest::save_url(&app.store, &app.http, &url).await
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
    app.wake_worker.notify_one();
    Ok(())
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
            let wake_worker = Arc::new(Notify::new());

            let handle = app.handle().clone();
            let on_change = move |article_id: i64| {
                let _ = handle.emit("article-changed", article_id);
            };
            tauri::async_runtime::spawn(jobs::run_worker(store.clone(), ClaudeCli::default(), wake_worker.clone(), on_change));

            app.manage(App { store, http: client(), wake_worker, db_path: path.display().to_string() });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![save_url, list_articles, get_article, translate_article, set_read, db_path])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
