// Every app command is listed so Tauri generates per-command permissions; capabilities then
// grant the app UI everything and remote pages only the overlay commands.
const COMMANDS: &[&str] = &[
    "save_url",
    "save_page",
    "reextract_article",
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
    "set_read",
    "db_path",
    "get_settings",
    "set_claude_model",
    "backup_db",
    "browser_open",
    "browser_set_bounds",
    "browser_hide",
    "browser_go",
    "browser_set_translation",
    "overlay_config",
    "overlay_translate",
    "overlay_snapshot",
];

fn main() {
    println!("cargo:rerun-if-changed=overlay-dist/overlay.js");
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)))
        .expect("failed to run tauri-build");
}
