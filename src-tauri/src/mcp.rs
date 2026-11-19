//! Starts and stops the MCP server (`lattice_server::mcp_http`) as Settings › MCP turns it on and off, and gives that
//! screen the registrations with what each one copies.

use std::sync::Arc;

use lattice_core::mcp::{self, Edit, Role};
use lattice_core::msg;
use lattice_server::Server;
use lattice_server::mcp_http::{self, ADDR};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;
use ts_rs::TS;

use crate::App;
use crate::location::Location;

#[derive(Default)]
pub struct McpServer {
    running: Mutex<Running>,
}

#[derive(Default)]
struct Running {
    server: Option<Server>,
    /// Why the server is not running although it is on.
    error: Option<String>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct McpStatus {
    enabled: bool,
    error: Option<String>,
    /// Running on a stand-in library because the real one could not be opened: nothing is served.
    fell_back: bool,
    registrations: Vec<McpRegistration>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct McpRegistration {
    id: String,
    name: String,
    role: Role,
    /// `claude mcp add ...` with the token.
    command: String,
}

/// Ends the running server, if any, and starts it again when it is on.
pub async fn apply(handle: &AppHandle) -> Result<(), String> {
    let app = handle.state::<App>();
    let mcp_server = handle.state::<McpServer>();
    let mut running = mcp_server.running.lock().await;
    if let Some(server) = running.server.take() {
        server.stop().await;
    }
    running.error = None;
    // An agent would read and write the stand-in copy.
    if handle.state::<Location>().warning.is_some() || !mcp::enabled(&app.store)? {
        return Ok(());
    }
    let tell = handle.clone();
    let on_applied: lattice_server::OnApplied = Arc::new(move |effects| crate::mobile::on_applied(&tell, effects));
    match lattice_server::start(ADDR, mcp_http::router(app.store.clone(), app.providers.clone(), on_applied)).await {
        Ok(server) => {
            log::info!("MCP server listening on {}", server.addr);
            running.server = Some(server);
        }
        Err(e) => {
            log::warn!("MCP server on {ADDR}: {e}");
            running.error = Some(msg!("mcp.bind", port = ADDR.port().to_string(), error = e.to_string()));
        }
    }
    Ok(())
}

async fn status(mcp_server: &McpServer, app: &App, loc: &Location) -> Result<McpStatus, String> {
    let error = mcp_server.running.lock().await.error.clone();
    let registrations = mcp::registrations(&app.store)?
        .into_iter()
        .map(|r| McpRegistration { command: mcp_http::add_command(&r.token), id: r.id, name: r.name, role: r.role })
        .collect();
    Ok(McpStatus { enabled: mcp::enabled(&app.store)?, error, fell_back: loc.warning.is_some(), registrations })
}

#[tauri::command]
pub async fn mcp_status(mcp_server: State<'_, McpServer>, app: State<'_, App>, loc: State<'_, Location>) -> Result<McpStatus, String> {
    status(&mcp_server, &app, &loc).await
}

/// The server reads registrations at every request, so only switching it on or off restarts it.
#[tauri::command]
pub async fn mcp_edit(
    edit: Edit,
    handle: AppHandle,
    mcp_server: State<'_, McpServer>,
    app: State<'_, App>,
    loc: State<'_, Location>,
) -> Result<McpStatus, String> {
    if loc.warning.is_some() {
        return Err(msg!("mcp.fellBack"));
    }
    mcp::edit(&app.store, &edit)?;
    if let Edit::Enable { .. } = edit {
        apply(&handle).await?;
    }
    status(&mcp_server, &app, &loc).await
}
