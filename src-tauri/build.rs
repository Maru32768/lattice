// Every app command is listed so Tauri generates per-command permissions; capabilities then
// grant the app UI everything and remote pages only the two overlay commands.
const COMMANDS: &[&str] = &[
    "save_url",
    "import_urls",
    "list_articles",
    "list_tags",
    "set_favorite",
    "add_tag",
    "remove_tag",
    "get_article",
    "article_for_url",
    "translate_article",
    "summarize_article",
    "search_blocks",
    "chat_ask",
    "chat_threads",
    "chat_messages",
    "chat_delete_thread",
    "set_read",
    "db_path",
    "get_settings",
    "get_llm_settings",
    "set_llm_chain",
    "set_api_key",
    "backup_db",
    "r2_status",
    "r2_save",
    "r2_backup_now",
    "browser_open",
    "browser_set_bounds",
    "browser_hide",
    "browser_go",
    "browser_set_translation",
    "overlay_config",
    "overlay_translate",
];

fn main() {
    println!("cargo:rerun-if-changed=overlay-dist/overlay.js");
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)))
        .expect("failed to run tauri-build");
}
