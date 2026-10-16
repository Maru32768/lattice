// Every app command is listed so Tauri generates per-command permissions; capabilities then
// grant the app UI everything and remote pages only the two overlay commands.
const COMMANDS: &[&str] = &[
    "save_url",
    "list_articles",
    "get_article",
    "article_for_url",
    "translate_article",
    "search_blocks",
    "set_read",
    "db_path",
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
