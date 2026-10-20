//! In-place updates from the GitHub release's `latest.json` (tauri-plugin-updater). The UI talks
//! to these commands only; the plugin's own JS commands are not granted to any webview.

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

use crate::location::{Kind, Location};

/// tauri.conf.json ships this in place of the signing public key; until it is replaced the
/// updater stays off instead of failing every check (docs/release.md).
const PUBKEY_PLACEHOLDER: &str = "NOT_CONFIGURED";
/// Bytes between `update-progress` events (the installer arrives in many small chunks).
const PROGRESS_STEP: u64 = 256 * 1024;

fn err(e: impl ToString) -> String {
    e.to_string()
}

fn configured(pubkey: Option<&str>) -> bool {
    pubkey.is_some_and(|k| !k.trim().is_empty() && !k.starts_with(PUBKEY_PLACEHOLDER))
}

fn pubkey(app: &AppHandle) -> Option<String> {
    app.config().plugins.0.get("updater")?.get("pubkey")?.as_str().map(str::to_owned)
}

#[derive(serde::Serialize)]
pub struct UpdateInfo {
    current: String,
    configured: bool,
    /// The installer would install a separate copy with its data in %APPDATA%, so a portable
    /// copy is updated by replacing it with the new zip.
    portable: bool,
}

fn portable(app: &AppHandle) -> bool {
    app.state::<Location>().kind == Kind::Portable
}

#[tauri::command]
pub fn update_info(app: AppHandle) -> UpdateInfo {
    UpdateInfo { current: app.package_info().version.to_string(), configured: configured(pubkey(&app).as_deref()), portable: portable(&app) }
}

async fn find(app: &AppHandle) -> Result<Option<tauri_plugin_updater::Update>, String> {
    if !configured(pubkey(app).as_deref()) {
        return Err("このビルドでは自動更新が設定されていません".into());
    }
    app.updater().map_err(err)?.check().await.map_err(|e| format!("更新を確認できませんでした: {e}"))
}

/// The newer version, or `None` when this one is the latest.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Option<String>, String> {
    Ok(find(&app).await?.map(|u| u.version))
}

#[derive(Clone, serde::Serialize)]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

/// Downloads, verifies and installs the update, then relaunches. On Windows the installer
/// takes over: the plugin exits the app and the NSIS installer starts the new version.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    if portable(&app) {
        return Err("ポータブル版は新しい zip に置き換えて更新してください".into());
    }
    let update = find(&app).await?.ok_or("新しいバージョンはありません")?;
    let (mut downloaded, mut reported) = (0u64, 0u64);
    update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk as u64;
                if downloaded - reported >= PROGRESS_STEP || Some(downloaded) == total {
                    reported = downloaded;
                    let _ = app.emit("update-progress", Progress { downloaded, total });
                }
            },
            || {},
        )
        .await
        .map_err(|e| format!("更新をインストールできませんでした: {e}"))?;
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_real_key_turns_the_updater_on() {
        assert!(!configured(Some("NOT_CONFIGURED: run `tauri signer generate`")));
        assert!(!configured(None));
        assert!(!configured(Some(" ")));
        assert!(configured(Some("dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk")));
    }
}
