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

/// A point in physical screen pixels (the UI maps its pointer through `inner_position`).
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Point {
    x: f64,
    y: f64,
}

/// Where the first tab's center sits in a fresh document window, in logical pixels: the title bar
/// (32) plus half the strip, and half a tab from the left edge.
const TAB_GRAB: (f64, f64) = (56.0, 51.0);

/// The origin of a window torn off at `at`, so the tab lands under the pointer that dropped it.
fn torn_off_origin(at: Point, scale: f64) -> PhysicalPosition<i32> {
    PhysicalPosition::new((at.x - TAB_GRAB.0 * scale).round() as i32, (at.y - TAB_GRAB.1 * scale).round() as i32)
}

/// Opens pop-out `label` where it last was (centered when that spot is on no monitor now), or
/// brings it to the front if it is open. With `at`, the window goes there instead (a tab dragged
/// away from every strip; an open window moves there).
#[tauri::command]
pub async fn open_window(app: AppHandle, state: State<'_, App>, loc: State<'_, Location>, label: String, at: Option<Point>) -> Result<(), String> {
    if !is_popout(&label) {
        return Err("not a pop-out window".into());
    }
    let dropped = match at {
        Some(p) => Some(torn_off_origin(p, app.monitor_from_point(p.x, p.y).map_err(err)?.map_or(1.0, |m| m.scale_factor()))),
        None => None,
    };
    if let Some(w) = app.get_webview_window(&label) {
        if let Some(pos) = dropped {
            w.set_position(pos).map_err(err)?;
        }
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
    match (dropped, saved_geometry(&state, &label).filter(|g| on_a_monitor(g, &monitors))) {
        (Some(pos), _) => w.set_position(pos).map_err(err)?,
        (None, Some(g)) => {
            w.set_position(PhysicalPosition::new(g.x, g.y)).map_err(err)?;
            w.set_size(PhysicalSize::new(g.width, g.height)).map_err(err)?;
        }
        (None, None) => w.center().map_err(err)?,
    }
    w.show().map_err(err)
}

/// Closes the calling pop-out. Its page webviews close with it; the UI moves their tabs to the
/// main window, which opens their pages again (see `browser::in_window`).
#[tauri::command]
pub async fn close_window(_app: AppHandle, state: State<'_, App>, webview: Webview) -> Result<(), String> {
    let w = webview.window();
    if !is_popout(w.label()) {
        return Err("not a pop-out window".into());
    }
    for wv in w.webviews().into_iter().filter(|wv| browser::is_browser(wv.label())) {
        if let Err(e) = wv.close() {
            log::warn!("closing {}: {e}", wv.label());
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
    fn a_torn_off_window_puts_its_tab_under_the_pointer_at_the_monitor_scale() {
        assert_eq!(torn_off_origin(Point { x: 1000.0, y: 500.0 }, 1.0), PhysicalPosition::new(944, 449));
        assert_eq!(torn_off_origin(Point { x: 1000.0, y: 500.0 }, 2.0), PhysicalPosition::new(888, 398));
        let p: Point = serde_json::from_str(r#"{"x":12.5,"y":-3}"#).unwrap();
        assert_eq!((p.x, p.y), (12.5, -3.0), "the UI sends plain x/y, possibly left of the primary monitor");
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
