//! Starts and stops the MCP server (`lattice_server::mcp_http`) as Settings › MCP turns it on and off, gives that
//! screen the registrations with what each one copies and what each agent has been doing, carries its changes into the
//! agents' own settings, and puts each deletion an agent asks for to the user in the main window.

use std::sync::{Arc, OnceLock, Weak};

use lattice_core::mcp::{self, ADDR, Edit, Role, Target};
use lattice_core::mcp_agents::{self, Agents};
use lattice_core::msg;
use lattice_server::Server;
use lattice_server::mcp_http::{self, Activity, Approval, Approvals, CallInfo, SessionInfo};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tokio::sync::Mutex;
use ts_rs::TS;

use crate::App;
use crate::location::Location;
use crate::popout::MAIN;

#[derive(Default)]
pub struct McpServer {
    running: Mutex<Running>,
}

#[derive(Default)]
struct Running {
    server: Option<Live>,
    /// Why the server is not running although it is on.
    error: Option<String>,
}

struct Live {
    server: Server,
    activity: Arc<Activity>,
    approvals: Arc<Approvals>,
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
    target: Target,
    /// What adds it to its agent by hand, token included: a command or a piece of settings.
    copy: String,
    /// The command that takes it out of its agent by hand, where there is one.
    remove: Option<String>,
    sessions: Vec<SessionInfo>,
    /// Newest first.
    calls: Vec<CallInfo>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct McpEdited {
    status: McpStatus,
    /// What became of the agent's own settings; null when there was nothing to change in them.
    agent: Option<McpAgentWrite>,
}

/// The change to the registrations stands either way.
#[derive(Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum McpAgentWrite {
    Written,
    Failed { error: String },
}

/// Ends the running server, if any, and starts it again when it is on.
pub async fn apply(handle: &AppHandle) -> Result<(), String> {
    let app = handle.state::<App>();
    let mcp_server = handle.state::<McpServer>();
    let mut running = mcp_server.running.lock().await;
    if let Some(live) = running.server.take() {
        // First: its calls can outlive it, and one waiting for the user would wait on with no screen to show it.
        live.approvals.close();
        live.server.stop().await;
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
    let tell = handle.clone();
    let me: Arc<OnceLock<Weak<Approvals>>> = Arc::default();
    let this = me.clone();
    let approvals = Approvals::new(move |arrived| {
        let _ = tell.emit("mcp-approval", ());
        let Some(w) = tell.get_webview_window(MAIN) else {
            return;
        };
        if arrived {
            if let Err(e) = raise(&w) {
                log::warn!("raising the main window for a deletion to approve: {e}");
            }
        } else if this.get().and_then(Weak::upgrade).is_some_and(|a| a.waiting().is_empty()) {
            // It flashes until the window comes into focus, which it need not now: nothing waits.
            let _ = w.request_user_attention(None);
        }
    });
    me.set(Arc::downgrade(&approvals)).ok();
    let router = mcp_http::router(app.store.clone(), app.providers.clone(), on_applied, activity.clone(), approvals.clone());
    match lattice_server::start(ADDR, router).await {
        Ok(server) => {
            log::info!("MCP server listening on {}", server.addr);
            running.server = Some(Live { server, activity, approvals });
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
        copy: mcp_agents::copied(r.target, &r.token),
        remove: mcp_agents::removal(r.target),
        id: r.id,
        name: r.name,
        role: r.role,
        target: r.target,
        sessions,
        calls,
    }
}

async fn status(mcp_server: &McpServer, app: &App, loc: &Location) -> Result<McpStatus, String> {
    let (error, activity) = {
        let running = mcp_server.running.lock().await;
        (running.error.clone(), running.server.as_ref().map(|live| live.activity.clone()))
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
) -> Result<McpEdited, String> {
    if loc.warning.is_some() {
        return Err(msg!("mcp.fellBack"));
    }
    let was_on = mcp::enabled(&app.store)?;
    let about = mcp::edit(&app.store, &edit)?;
    if matches!(edit, Edit::Enable { .. }) || mcp::enabled(&app.store)? != was_on {
        apply(&handle).await?;
    }
    let agents = Agents::default();
    let written = match (&edit, &about) {
        (Edit::Create { .. } | Edit::Connect { .. } | Edit::Regenerate { .. }, Some(r)) => agents.connect(&app.store, &r.id).await,
        (Edit::Delete { .. }, Some(r)) => agents.disconnect(&app.store, r.target).await,
        (Edit::Enable { .. } | Edit::SetRole { .. }, _) => Ok(false),
        (Edit::Create { .. } | Edit::Connect { .. } | Edit::Regenerate { .. } | Edit::Delete { .. }, None) => Ok(false),
    };
    let agent = match written {
        Ok(true) => Some(McpAgentWrite::Written),
        Ok(false) => None,
        Err(error) => Some(McpAgentWrite::Failed { error }),
    };
    Ok(McpEdited { status: status(&mcp_server, &app, &loc).await?, agent })
}

/// Puts the main window in front of the others for a deletion to approve, and flashes it, but leaves the keyboard
/// where it is: keys meant for the app the user is typing in would answer the dialog, and a word, Tab and a space
/// would allow the deletion.
#[allow(unsafe_code, reason = "Win32 window placement through the windows crate")]
fn raise(w: &WebviewWindow) -> tauri::Result<()> {
    let on_main = w.clone();
    // All on the main thread: asked from here, whether the window shows yet would hold up the agent's request.
    w.run_on_main_thread(move || {
        #[cfg(windows)]
        {
            use windows::Win32::UI::WindowsAndMessaging::{
                HWND_NOTOPMOST, HWND_TOPMOST, IsIconic, IsWindowVisible, SW_SHOWNOACTIVATE, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SetWindowPos, ShowWindow,
            };
            let Ok(hwnd) = on_main.hwnd() else {
                return;
            };
            let keep = SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE;
            // SAFETY: on the main thread, with the window tao made, which lives as long as `on_main`.
            unsafe {
                // Still hidden while starting up: `restore_main` shows it, with the dialog.
                if !IsWindowVisible(hwnd).as_bool() {
                    return;
                }
                if IsIconic(hwnd).as_bool() {
                    let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                }
                // Topmost and back again: in front of the other apps' windows, then ordered as any window.
                let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, keep);
                let _ = SetWindowPos(hwnd, Some(HWND_NOTOPMOST), 0, 0, 0, 0, keep);
            }
        }
        if let Err(e) = on_main.request_user_attention(Some(tauri::UserAttentionType::Critical)) {
            log::warn!("flashing the main window for a deletion to approve: {e}");
        }
    })
}

/// Deletions waiting for the user's answer, oldest first.
#[tauri::command]
pub async fn mcp_approvals(mcp_server: State<'_, McpServer>) -> Result<Vec<Approval>, String> {
    Ok(mcp_server.running.lock().await.server.as_ref().map(|live| live.approvals.waiting()).unwrap_or_default())
}

#[tauri::command]
pub async fn mcp_answer(id: u64, allow: bool, mcp_server: State<'_, McpServer>) -> Result<(), String> {
    if let Some(live) = mcp_server.running.lock().await.server.as_ref() {
        live.approvals.answer(id, allow);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_registration_is_added_and_removed_at_its_own_target() {
        for target in [Target::ClaudeCode, Target::ClaudeCodeProject, Target::Codex, Target::Other] {
            let shown = view(mcp::Registration { id: "r1".into(), name: "Claude Code".into(), role: Role::Read, target, token: "t0k".into() }, None);
            assert_eq!(shown.target, target);
            assert_eq!(shown.copy, mcp_agents::copied(target, "t0k"));
            assert_eq!(shown.remove, mcp_agents::removal(target), "following the dialog must not remove another registration");
        }
    }
}
