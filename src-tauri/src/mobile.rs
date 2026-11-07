//! Starts and stops the phone's server (`lattice-server`) as its settings change, and tells the
//! settings screen what the phone should open (G47, design-review §32).

use std::net::{Ipv4Addr, SocketAddr};

use lattice_core::mobile::{self, Effects, MobileSettings, ServerMode};
use lattice_core::msg;
use lattice_server::Server;
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;
use ts_rs::TS;

use crate::App;
use crate::location::Location;

#[derive(Default)]
pub struct MobileServer(Mutex<Running>);

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
fn on_applied(handle: &AppHandle, effects: &Effects) {
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
    let mut running = mobile_server.0.lock().await;
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
    let running = mobile_server.0.lock().await;
    let url = match (&running.server, base_url(&settings)) {
        (Some(_), Some(base)) => Some(mobile::phone_url(&base, &mobile::token(&app.store)?)),
        _ => None,
    };
    // A failure must not lock the settings screen: the address shows in place of the code.
    let qr = url.as_deref().and_then(|u| qr_of(u).inspect_err(|e| log::warn!("mobile QR code: {e}")).ok());
    Ok(MobileStatus { settings, running: running.server.is_some(), error: running.error.clone(), url, qr, fell_back: loc.warning.is_some() })
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
    status(&mobile_server, &app, &loc).await
}

#[tauri::command]
pub async fn mobile_regenerate_token(mobile_server: State<'_, MobileServer>, app: State<'_, App>, loc: State<'_, Location>) -> Result<MobileStatus, String> {
    if loc.warning.is_some() {
        return Err(msg!("mobile.fellBack"));
    }
    mobile::regenerate_token(&app.store)?;
    status(&mobile_server, &app, &loc).await
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
        assert!(qr_of(&mobile::phone_url(&"x".repeat(mobile::MAX_PUBLIC_URL), &"f".repeat(64))).is_ok());
    }

    #[test]
    fn the_phone_opens_the_tunnel_when_there_is_one() {
        let with = |mode, public_url: &str| base_url(&MobileSettings { mode, port: 8787, public_url: public_url.into() });
        assert_eq!(with(ServerMode::Local, "https://pc.example.ts.net").as_deref(), Some("https://pc.example.ts.net"));
        assert_eq!(with(ServerMode::Lan, "https://pc.example.ts.net").as_deref(), Some("https://pc.example.ts.net"));
        assert_eq!(with(ServerMode::Local, ""), None);
    }
}
