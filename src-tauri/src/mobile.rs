//! Starts and stops the phone's server (`lattice-server`) as its settings change, and tells the
//! settings screen what the phone should open (G47, design-review §32).

use std::net::{Ipv4Addr, SocketAddr};

use lattice_core::mobile::{self, Effects, MobileSettings, ServerMode};
use lattice_core::mobile_publish::{self, SnapshotSettings, SnapshotStatus};
use lattice_core::msg;
use lattice_server::Server;
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{Mutex, Notify};
use ts_rs::TS;

use crate::App;
use crate::location::Location;

#[derive(Default)]
pub struct MobileServer {
    running: Mutex<Running>,
    /// Starts a snapshot pass now: there is a new token, new settings, or the button was pressed.
    publish_now: Arc<Notify>,
}

#[derive(Default)]
struct Running {
    server: Option<Server>,
    /// Why the server is not running although it should be.
    error: Option<String>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct MobileStatus {
    settings: MobileSettings,
    running: bool,
    error: Option<String>,
    /// What the phone opens, with the token. None while nothing can be offered yet.
    url: Option<String>,
    qr: Option<MobileQr>,
    snapshot: SnapshotStatus,
    /// What the phone opens for the snapshot, with the token, once there is one to read.
    snapshot_url: Option<String>,
    snapshot_qr: Option<MobileQr>,
    /// Running on a stand-in library because the real one could not be opened: nothing is served.
    fell_back: bool,
}

/// A QR code as an SVG path over a `width`-square viewBox.
#[derive(Serialize, TS)]
#[ts(export)]
pub struct MobileQr {
    width: u32,
    path: String,
}

fn qr_of(url: &str) -> Result<MobileQr, String> {
    let code = qrcode::QrCode::new(url.as_bytes()).map_err(|e| e.to_string())?;
    let width = code.width();
    let mut path = String::new();
    for (i, color) in code.to_colors().iter().enumerate() {
        if *color == qrcode::Color::Dark {
            path += &format!("M{} {}h1v1h-1z", i % width, i / width);
        }
    }
    Ok(MobileQr { width: width as u32, path })
}

fn base_url(s: &MobileSettings) -> Option<String> {
    if !s.public_url.is_empty() {
        return Some(s.public_url.clone());
    }
    match s.mode {
        ServerMode::Lan => mobile::lan_ip().and_then(|ip| mobile::base_of(ip, s.port)),
        ServerMode::Off | ServerMode::Local => None,
    }
}

/// The app sees what the phone did as it sees what a job did.
pub(crate) fn on_applied(handle: &AppHandle, effects: &Effects) {
    let app = handle.state::<App>();
    if let Some(id) = effects.article {
        let _ = handle.emit("article-changed", id);
    }
    if effects.vocab {
        app.wake_llm.iter().for_each(|w| w.notify_one());
        let _ = handle.emit("vocab-changed", ());
    }
    if effects.fetch {
        app.wake_net.iter().for_each(|w| w.notify_one());
    }
}

/// Ends the running server, if any, and starts what the settings ask for.
pub async fn apply(handle: &AppHandle) -> Result<(), String> {
    let mobile_server = handle.state::<MobileServer>();
    let app = handle.state::<App>();
    let store = &app.store;
    let mut running = mobile_server.running.lock().await;
    if let Some(server) = running.server.take() {
        server.stop().await;
    }
    running.error = None;
    let s = mobile::settings(store)?;
    let ip = match s.mode {
        ServerMode::Off => return Ok(()),
        ServerMode::Local => Ipv4Addr::LOCALHOST,
        ServerMode::Lan => Ipv4Addr::UNSPECIFIED,
    };
    // Made here so that the first request has a token to compare with, and the settings a QR code to show.
    mobile::token(store)?;
    let effects_handle = handle.clone();
    let tell_app: lattice_server::OnApplied = Arc::new(move |effects| on_applied(&effects_handle, effects));
    match lattice_server::start(SocketAddr::from((ip, s.port)), lattice_server::router(store.clone(), Some(tell_app))).await {
        Ok(server) => {
            log::info!("mobile server listening on {}", server.addr);
            running.server = Some(server);
        }
        Err(e) => {
            log::warn!("mobile server on port {}: {e}", s.port);
            running.error = Some(msg!("mobile.bind", port = s.port.to_string(), error = e.to_string()));
        }
    }
    Ok(())
}

async fn status(mobile_server: &MobileServer, app: &App, loc: &Location) -> Result<MobileStatus, String> {
    let settings = mobile::settings(&app.store)?;
    let running = mobile_server.running.lock().await;
    let url = match (&running.server, base_url(&settings)) {
        (Some(_), Some(base)) => Some(mobile::phone_url(&app.store, &base)?),
        _ => None,
    };
    // A failure must not lock the settings screen: the address shows in place of the code.
    let qr = url.as_deref().and_then(|u| qr_of(u).inspect_err(|e| log::warn!("mobile QR code: {e}")).ok());
    let snapshot = mobile_publish::status(&app.store)?;
    let snapshot_url = if snapshot.enabled && snapshot.last_publish.is_some() && loc.warning.is_none() {
        Some(mobile::phone_url(&app.store, &snapshot.worker_url)?)
    } else {
        None
    };
    let snapshot_qr = snapshot_url.as_deref().and_then(|u| qr_of(u).inspect_err(|e| log::warn!("mobile QR code: {e}")).ok());
    Ok(MobileStatus {
        settings,
        running: running.server.is_some(),
        error: running.error.clone(),
        url,
        qr,
        snapshot,
        snapshot_url,
        snapshot_qr,
        fell_back: loc.warning.is_some(),
    })
}

#[tauri::command]
pub async fn mobile_status(mobile_server: State<'_, MobileServer>, app: State<'_, App>, loc: State<'_, Location>) -> Result<MobileStatus, String> {
    status(&mobile_server, &app, &loc).await
}

#[tauri::command]
pub async fn mobile_save(
    settings: MobileSettings,
    handle: AppHandle,
    mobile_server: State<'_, MobileServer>,
    app: State<'_, App>,
    loc: State<'_, Location>,
) -> Result<MobileStatus, String> {
    if loc.warning.is_some() {
        return Err(msg!("mobile.fellBack"));
    }
    mobile::save_settings(&app.store, &settings)?;
    apply(&handle).await?;
    // The snapshot names the PC's address, and its page may connect to no other.
    mobile_server.publish_now.notify_one();
    status(&mobile_server, &app, &loc).await
}

#[tauri::command]
pub async fn mobile_regenerate_token(mobile_server: State<'_, MobileServer>, app: State<'_, App>, loc: State<'_, Location>) -> Result<MobileStatus, String> {
    if loc.warning.is_some() {
        return Err(msg!("mobile.fellBack"));
    }
    mobile::regenerate_token(&app.store)?;
    mobile_server.publish_now.notify_one();
    status(&mobile_server, &app, &loc).await
}

#[tauri::command]
pub async fn mobile_snapshot_save(
    settings: SnapshotSettings,
    abandon: bool,
    handle: AppHandle,
    mobile_server: State<'_, MobileServer>,
    app: State<'_, App>,
    loc: State<'_, Location>,
) -> Result<MobileStatus, String> {
    if loc.warning.is_some() {
        return Err(msg!("mobile.fellBack"));
    }
    let tell = handle.clone();
    mobile_publish::change(&app.store, settings, abandon, &move |effects| on_applied(&tell, effects)).await?;
    mobile_server.publish_now.notify_one();
    status(&mobile_server, &app, &loc).await
}

#[tauri::command]
pub async fn mobile_publish_now(mobile_server: State<'_, MobileServer>, app: State<'_, App>, loc: State<'_, Location>) -> Result<MobileStatus, String> {
    if loc.warning.is_some() {
        return Err(msg!("mobile.fellBack"));
    }
    mobile_publish::clear_rejected(&app.store)?;
    mobile_server.publish_now.notify_one();
    status(&mobile_server, &app, &loc).await
}

/// Runs the snapshot's schedule for this app's library.
pub fn start_publisher(handle: &AppHandle) {
    let publish_now = handle.state::<MobileServer>().publish_now.clone();
    let store = handle.state::<App>().store.clone();
    let tell = handle.clone();
    tauri::async_runtime::spawn(mobile_publish::run_scheduler(
        store,
        lattice_server::page_files(),
        Box::new(move |effects| on_applied(&tell, effects)),
        publish_now,
    ));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_qr_code_draws_only_its_dark_modules() {
        let qr = qr_of("http://192.168.0.2:8787/#t=abc").unwrap();
        assert!(qr.width >= 21);
        assert!(qr.path.starts_with("M0 0h1v1h-1z"), "the finder pattern's corner is dark");
        assert!(qr.path.matches('M').count() < (qr.width * qr.width) as usize);
    }

    #[test]
    fn the_longest_address_allowed_fits_a_qr_code_with_the_token() {
        let longest = format!("{}/#t={}&l={}", "x".repeat(mobile::MAX_PUBLIC_URL), "f".repeat(64), "f".repeat(16));
        assert!(qr_of(&longest).is_ok());
    }

    #[test]
    fn the_phone_opens_the_tunnel_when_there_is_one() {
        let with = |mode, public_url: &str| base_url(&MobileSettings { mode, port: 8787, public_url: public_url.into() });
        assert_eq!(with(ServerMode::Local, "https://pc.example.ts.net").as_deref(), Some("https://pc.example.ts.net"));
        assert_eq!(with(ServerMode::Lan, "https://pc.example.ts.net").as_deref(), Some("https://pc.example.ts.net"));
        assert_eq!(with(ServerMode::Local, ""), None);
    }
}
