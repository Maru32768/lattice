//! Starts and stops the phone's server (`lattice-server`) as its settings change, and tells the
//! settings screen what the phone should open (G47, design-review §32).

use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};

use lattice_core::mobile::{self, MobileSettings, ServerMode};
use lattice_core::msg;
use lattice_core::store::Store;
use lattice_server::Server;
use serde::Serialize;
use std::sync::Arc;
use tauri::State;
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

/// The address other devices reach this PC at: the one the route to the Internet leaves from.
/// Connecting a UDP socket sends nothing.
fn lan_ip() -> Option<IpAddr> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect((Ipv4Addr::new(8, 8, 8, 8), 53)).ok()?;
    socket.local_addr().ok().map(|a| a.ip())
}

fn base_url(s: &MobileSettings) -> Option<String> {
    if !s.public_url.is_empty() {
        return Some(s.public_url.clone());
    }
    match s.mode {
        ServerMode::Lan => lan_ip().map(|ip| format!("http://{}", SocketAddr::new(ip, s.port))),
        ServerMode::Off | ServerMode::Local => None,
    }
}

/// Ends the running server, if any, and starts what the settings ask for.
pub async fn apply(mobile_server: &MobileServer, store: &Arc<Store>) -> Result<(), String> {
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
    let router = lattice_server::router(store.clone(), &mobile::token(store)?);
    match lattice_server::start(SocketAddr::from((ip, s.port)), router).await {
        Ok(server) => {
            log::info!("mobile server listening on {}", server.addr);
            running.server = Some(server);
        }
        Err(e) => {
            log::warn!("mobile server on port {}: {e}", s.port);
            running.error = Some(msg!("mobile.bind", port = s.port, error = e.to_string()));
        }
    }
    Ok(())
}

async fn status(mobile_server: &MobileServer, app: &App, loc: &Location) -> Result<MobileStatus, String> {
    let settings = mobile::settings(&app.store)?;
    let running = mobile_server.0.lock().await;
    let url = match (&running.server, base_url(&settings)) {
        (Some(_), Some(base)) => Some(format!("{base}/#t={}", mobile::token(&app.store)?)),
        _ => None,
    };
    let qr = url.as_deref().map(qr_of).transpose()?;
    Ok(MobileStatus { settings, running: running.server.is_some(), error: running.error.clone(), url, qr, fell_back: loc.warning.is_some() })
}

#[tauri::command]
pub async fn mobile_status(mobile_server: State<'_, MobileServer>, app: State<'_, App>, loc: State<'_, Location>) -> Result<MobileStatus, String> {
    status(&mobile_server, &app, &loc).await
}

#[tauri::command]
pub async fn mobile_save(
    settings: MobileSettings,
    mobile_server: State<'_, MobileServer>,
    app: State<'_, App>,
    loc: State<'_, Location>,
) -> Result<MobileStatus, String> {
    if loc.warning.is_some() {
        return Err(msg!("mobile.fellBack"));
    }
    mobile::save_settings(&app.store, &settings)?;
    apply(&mobile_server, &app.store).await?;
    status(&mobile_server, &app, &loc).await
}

#[tauri::command]
pub async fn mobile_regenerate_token(mobile_server: State<'_, MobileServer>, app: State<'_, App>, loc: State<'_, Location>) -> Result<MobileStatus, String> {
    if loc.warning.is_some() {
        return Err(msg!("mobile.fellBack"));
    }
    mobile::regenerate_token(&app.store)?;
    apply(&mobile_server, &app.store).await?;
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
    fn the_phone_opens_the_tunnel_when_there_is_one() {
        let with = |mode, public_url: &str| base_url(&MobileSettings { mode, port: 8787, public_url: public_url.into() });
        assert_eq!(with(ServerMode::Local, "https://pc.example.ts.net").as_deref(), Some("https://pc.example.ts.net"));
        assert_eq!(with(ServerMode::Lan, "https://pc.example.ts.net").as_deref(), Some("https://pc.example.ts.net"));
        assert_eq!(with(ServerMode::Local, ""), None);
    }
}
