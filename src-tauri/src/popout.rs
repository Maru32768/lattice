//! Pop-out windows (G52, design-review §26): document windows (`doc-<n>`, one pane tree of tabs)
//! and the chat window (`chat`). Each loads the same frontend, which reads its own label to know
//! what to show (`src/windows.ts`) and keeps what it holds in its own storage. This module creates
//! the windows where they last were, keeps their page webviews alive while they close, and quits
//! the app with the main window.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, State, Webview, WebviewUrl, WebviewWindowBuilder, Window, WindowEvent};

use crate::location::Location;
use crate::{App, browser, err};

pub const MAIN: &str = "main";
const DEFAULT_SIZE: (f64, f64) = (960.0, 720.0);

/// A pop-out's label: `doc-<n>` or `chat`. Nothing else is created on the UI's request.
fn is_popout(label: &str) -> bool {
    label == "chat" || label.strip_prefix("doc-").is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// Physical pixels, as the window reports them (a logical size differs per monitor).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
struct Geometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

type MonitorRect = (PhysicalPosition<i32>, PhysicalSize<u32>);

/// A saved position is used only while the start of its title bar is on some monitor: the one
/// it was on may have been unplugged, and a window nobody can grab is lost.
fn on_a_monitor(g: &Geometry, monitors: &[MonitorRect]) -> bool {
    let (px, py) = (g.x.saturating_add(48), g.y.saturating_add(16));
    monitors.iter().any(|(p, s)| px >= p.x && py >= p.y && px < p.x.saturating_add(s.width as i32) && py < p.y.saturating_add(s.height as i32))
}

fn setting_key(label: &str) -> String {
    format!("window.{label}")
}

fn save_geometry(app: &App, w: &Window) {
    let saved = w.outer_position().and_then(|p| w.inner_size().map(|s| Geometry { x: p.x, y: p.y, width: s.width, height: s.height }));
    let result = saved
        .map_err(err)
        .and_then(|g| serde_json::to_string(&g).map_err(err))
        .and_then(|json| app.store.set_setting(&setting_key(w.label()), Some(&json)).map_err(err));
    if let Err(e) = result {
        log::warn!("saving the position of {}: {e}", w.label());
    }
}

fn saved_geometry(app: &App, label: &str) -> Option<Geometry> {
    serde_json::from_str(&app.store.setting(&setting_key(label)).ok()??).ok()
}

/// Opens pop-out `label` where it last was (centered when that spot is on no monitor now), or
/// brings it to the front if it is open.
#[tauri::command]
pub async fn open_window(app: AppHandle, state: State<'_, App>, loc: State<'_, Location>, label: String) -> Result<(), String> {
    if !is_popout(&label) {
        return Err("not a pop-out window".into());
    }
    if let Some(w) = app.get_webview_window(&label) {
        return w.set_focus().map_err(err);
    }
    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::default())
        .title("Lattice")
        .decorations(false)
        .inner_size(DEFAULT_SIZE.0, DEFAULT_SIZE.1)
        .visible(false);
    if let Some(d) = loc.webview_dir() {
        builder = builder.data_directory(d);
    }
    let w = match builder.build() {
        Ok(w) => w,
        // Asked twice before the first finished (a double click): the first one wins.
        Err(tauri::Error::WindowLabelAlreadyExists(_)) => return app.get_webview_window(&label).map_or(Ok(()), |w| w.set_focus().map_err(err)),
        Err(e) => return Err(err(e)),
    };
    let monitors: Vec<MonitorRect> = app.available_monitors().map_err(err)?.iter().map(|m| (*m.position(), *m.size())).collect();
    match saved_geometry(&state, &label).filter(|g| on_a_monitor(g, &monitors)) {
        Some(g) => {
            w.set_position(PhysicalPosition::new(g.x, g.y)).map_err(err)?;
            w.set_size(PhysicalSize::new(g.width, g.height)).map_err(err)?;
        }
        None => w.center().map_err(err)?,
    }
    w.show().map_err(err)
}

/// Closes the calling pop-out. Its page webviews first go back under the main window, hidden:
/// the UI is moving their tabs there, and a child webview dies with its window.
#[tauri::command]
pub async fn close_window(app: AppHandle, state: State<'_, App>, webview: Webview) -> Result<(), String> {
    let w = webview.window();
    if !is_popout(w.label()) {
        return Err("not a pop-out window".into());
    }
    if let Some(main) = app.get_window(MAIN) {
        for wv in w.webviews().into_iter().filter(|wv| browser::is_browser(wv.label())) {
            let _ = wv.hide();
            if let Err(e) = wv.reparent(&main) {
                log::warn!("moving {} back to the main window: {e}", wv.label());
            }
        }
    }
    save_geometry(&state, &w);
    w.destroy().map_err(err)
}

/// The main window's close quits the app, as before pop-outs existed; the pop-outs' positions are
/// saved first, since they go down with it (their contents are saved by the UI as they change).
pub fn on_window_event(w: &Window, e: &WindowEvent) {
    if w.label() != MAIN {
        return;
    }
    let app = w.app_handle();
    match e {
        WindowEvent::CloseRequested { .. } => {
            if let Some(state) = app.try_state::<App>() {
                for (label, win) in app.windows() {
                    if is_popout(&label) {
                        save_geometry(&state, &win);
                    }
                }
            }
        }
        WindowEvent::Destroyed => app.exit(0),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_document_and_chat_labels_are_pop_outs() {
        assert!(is_popout("doc-1") && is_popout("doc-42") && is_popout("chat"));
        for other in ["main", "doc-", "doc-x", "doc-1-2", "browser-abc", "renderer", ""] {
            assert!(!is_popout(other), "{other:?}");
        }
    }

    #[test]
    fn a_saved_position_is_kept_only_while_its_monitor_is_there() {
        let primary = (PhysicalPosition::new(0, 0), PhysicalSize::new(2560, 1440));
        let left = (PhysicalPosition::new(-1920, 200), PhysicalSize::new(1920, 1080));
        let on_left = Geometry { x: -1800, y: 300, width: 900, height: 700 };
        assert!(on_a_monitor(&on_left, &[primary, left]));
        assert!(!on_a_monitor(&on_left, &[primary]), "the left monitor was unplugged");
        assert!(on_a_monitor(&Geometry { x: 2500, y: 0, width: 900, height: 700 }, &[primary]), "its left edge is still on screen");
        assert!(!on_a_monitor(&Geometry { x: 2520, y: 0, width: 900, height: 700 }, &[primary]), "nothing of the title bar's start is visible");
        assert!(!on_a_monitor(&Geometry { x: 0, y: 0, width: 1, height: 1 }, &[]));
        let g: Geometry = serde_json::from_str(r#"{"x":-1800,"y":300,"width":900,"height":700}"#).unwrap();
        assert_eq!(g, on_left, "stored as plain JSON in the settings table");
    }
}
