use lattice_core::fetch::{HttpClient, client};
use lattice_core::ingest;
use lattice_core::store::{ArticleRow, ArticleView, Store};
use tauri::{Manager, State};

struct App {
    store: Store,
    http: HttpClient,
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
    app.store.get_article(id).map_err(err)
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
            let store = Store::open(&path)?;
            app.manage(App { store, http: client(), db_path: path.display().to_string() });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![save_url, list_articles, get_article, set_read, db_path])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
