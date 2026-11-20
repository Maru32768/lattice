//! Starts and stops the MCP server (`lattice_server::mcp_http`) as Settings › MCP turns it on and off, and gives that
//! screen the registrations with what each one copies and what each agent has been doing.

use std::sync::Arc;

use lattice_core::mcp::{self, Edit, Role, Scope};
use lattice_core::msg;
use lattice_server::Server;
use lattice_server::mcp_http::{self, ADDR, Activity, CallInfo, SessionInfo};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
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
    server: Option<(Server, Arc<Activity>)>,
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
    scope: Scope,
    /// `claude mcp add ...` with the token.
    command: String,
    /// `claude mcp remove ...`, which the confirmations ask for before a new command or after a deletion.
    remove: String,
    sessions: Vec<SessionInfo>,
    /// Newest first.
    calls: Vec<CallInfo>,
}

/// Ends the running server, if any, and starts it again when it is on.
pub async fn apply(handle: &AppHandle) -> Result<(), String> {
    let app = handle.state::<App>();
    let mcp_server = handle.state::<McpServer>();
    let mut running = mcp_server.running.lock().await;
    if let Some((server, _)) = running.server.take() {
        server.stop().await;
    }
    running.error = None;
    if !mcp::enabled(&app.store)? {
        return Ok(());
    }
    let tell = handle.clone();
    let on_applied: lattice_server::OnApplied = Arc::new(move |effects| crate::mobile::on_applied(&tell, effects));
    let tell = handle.clone();
    let activity = Activity::new(move || {
        let _ = tell.emit("mcp-activity", ());
    });
    match lattice_server::start(ADDR, mcp_http::router(app.store.clone(), app.providers.clone(), on_applied, activity.clone())).await {
        Ok(server) => {
            log::info!("MCP server listening on {}", server.addr);
            running.server = Some((server, activity));
        }
        Err(e) => {
            log::warn!("MCP server on {ADDR}: {e}");
            running.error = Some(msg!("mcp.bind", port = ADDR.port().to_string(), error = e.to_string()));
        }
    }
    Ok(())
}

fn view(r: mcp::Registration, activity: Option<&Activity>) -> McpRegistration {
    let (sessions, calls) = activity.map(|a| a.of(&r)).unwrap_or_default();
    McpRegistration {
        command: mcp_http::add_command(&r.token, r.scope),
        remove: mcp_http::remove_command(r.scope),
        id: r.id,
        name: r.name,
        role: r.role,
        scope: r.scope,
        sessions,
        calls,
    }
}

async fn status(mcp_server: &McpServer, app: &App, loc: &Location) -> Result<McpStatus, String> {
    let (error, activity) = {
        let running = mcp_server.running.lock().await;
        (running.error.clone(), running.server.as_ref().map(|(_, activity)| activity.clone()))
    };
    let registrations = mcp::registrations(&app.store)?.into_iter().map(|r| view(r, activity.as_deref())).collect();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_registration_is_added_and_removed_in_its_own_scope() {
        for scope in [Scope::User, Scope::Local] {
            let shown = view(mcp::Registration { id: "r1".into(), name: "Claude Code".into(), role: Role::Read, scope, token: "t0k".into() }, None);
            assert_eq!(shown.scope, scope);
            assert_eq!(shown.command, mcp_http::add_command("t0k", scope));
            assert_eq!(shown.remove, mcp_http::remove_command(scope), "following the dialog must not remove another registration");
        }
    }
}
