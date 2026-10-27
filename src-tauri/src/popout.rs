//! Pop-out windows (G52, design-review §26): document windows (`doc-<n>`, one pane tree of tabs)
//! and the chat window (`chat`). Each loads the same frontend, which reads its own label to know
//! what to show (`src/app/windows.ts`) and keeps what it holds in its own storage. This module creates
//! the windows where they last were, keeps their page webviews alive while they close, and quits
//! the app with the main window.
//!
//! One document window is kept ready, hidden, with the frontend loaded (`Spare`): a tab torn off
//! or popped out goes to it and shows at once. A new window takes 2-3 s to start WebView2 and load
//! the frontend, which is how long a torn-off tab took to appear.

use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, State, Webview, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window, WindowEvent};
use tokio::sync::oneshot;

use crate::browser::lock;
use crate::location::Location;
use crate::{App, browser, err, tabdrag};

pub const MAIN: &str = "main";
const DEFAULT_SIZE: (f64, f64) = (960.0, 720.0);
/// A pop-out shows once its UI has mounted (`window_ready`), so it never flashes empty; this is
/// how long it waits for that before showing anyway.
const REVEAL_AFTER: Duration = Duration::from_secs(3);
/// How long after startup, or after the spare was taken, the next one is made: not while the app
/// starts or the torn-off window is being dragged.
const SPARE_AFTER: Duration = Duration::from_secs(3);

/// The spare document window's label and, while its frontend waits for a layout (`window_adopted`),
/// what wakes it.
#[derive(Default)]
pub struct Spare(Mutex<Option<(String, Option<oneshot::Sender<()>>)>>);

/// A document window's label: `doc-<n>`.
pub fn is_doc(label: &str) -> bool {
    label.strip_prefix("doc-").is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

fn doc_number(label: &str) -> Option<u32> {
    label.strip_prefix("doc-").filter(|_| is_doc(label))?.parse().ok()
}

/// A pop-out's label: `doc-<n>` or `chat`. Nothing else is created on the UI's request.
fn is_popout(label: &str) -> bool {
    label == "chat" || is_doc(label)
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
    // shortcut: a minimized or maximized window keeps its last normal geometry; maximized is not restored, save the flag if that is missed.
    if w.is_minimized().unwrap_or(false) || w.is_maximized().unwrap_or(false) {
        return;
    }
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
    let Some(w) = create(&app, &loc, &label)? else {
        return app.get_window(&label).map_or(Ok(()), |w| w.set_focus().map_err(err));
    };
    place(&app, &state, &w)
}

/// Puts window `w` where it last was; centered when that spot is on no monitor now.
fn place(app: &AppHandle, state: &App, w: &WebviewWindow) -> Result<(), String> {
    let monitors: Vec<MonitorRect> = app.available_monitors().map_err(err)?.iter().map(|m| (*m.position(), *m.size())).collect();
    match saved_geometry(state, w.label()).filter(|g| on_a_monitor(g, &monitors)) {
        Some(g) => {
            w.set_position(PhysicalPosition::new(g.x, g.y)).map_err(err)?;
            w.set_size(PhysicalSize::new(g.width, g.height)).map_err(err)?;
        }
        None => w.center().map_err(err)?,
    }
    Ok(())
}

/// Shows the (hidden) main window where it last was; at tauri.conf.json's size until it has been closed once.
pub fn restore_main(app: &AppHandle, state: &App) {
    let Some(w) = app.get_webview_window(MAIN) else {
        return;
    };
    if saved_geometry(state, MAIN).is_some()
        && let Err(e) = place(app, state, &w)
    {
        log::warn!("restoring the main window's position: {e}");
    }
    if let Err(e) = w.show() {
        log::warn!("showing the main window: {e}");
    }
    prepare_spare(app);
}

/// Creates pop-out `label`, hidden until `ready`, or takes the spare when it has that label. None
/// when it is open already (asked twice before the first finished, as a double click does: the
/// first one wins).
pub fn create(app: &AppHandle, loc: &Location, label: &str) -> Result<Option<WebviewWindow>, String> {
    if let Some(w) = take_spare(app, label) {
        reveal_later(app, label);
        prepare_spare(app);
        return Ok(Some(w));
    }
    if app.get_window(label).is_some() {
        return Ok(None);
    }
    match build(app, loc, label) {
        Ok(w) => {
            reveal_later(app, label);
            Ok(Some(w))
        }
        Err(tauri::Error::WindowLabelAlreadyExists(_) | tauri::Error::WebviewLabelAlreadyExists(_)) => Ok(None),
        Err(e) => Err(err(e)),
    }
}

fn build(app: &AppHandle, loc: &Location, label: &str) -> tauri::Result<WebviewWindow> {
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::default())
        .title("Lattice")
        .decorations(false)
        .inner_size(DEFAULT_SIZE.0, DEFAULT_SIZE.1)
        .visible(false);
    if let Some(d) = loc.webview_dir() {
        builder = builder.data_directory(d);
    }
    builder.build()
}

fn reveal_later(app: &AppHandle, label: &str) {
    let (app, label) = (app.clone(), label.to_string());
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(REVEAL_AFTER).await;
        // A window following a drag shows when the drag says, and only once it holds the tab.
        if !tabdrag::follows(&app, &label) {
            show(&app, &label);
        }
    });
}

/// The spare, if it is `label`: no longer a spare, its frontend goes on to load the layout stored
/// for it. None while it is still being created; it is no spare then either, and the create that
/// asked for it finds the label taken.
fn take_spare(app: &AppHandle, label: &str) -> Option<WebviewWindow> {
    let (_, wake) = {
        let spare = app.state::<Spare>();
        let mut g = lock(&spare.0);
        g.take_if(|(l, _)| l == label)?
    };
    if let Some(wake) = wake {
        let _ = wake.send(());
    }
    app.get_webview_window(label)
}

/// Makes a spare document window `SPARE_AFTER` from now, unless there is one, with the lowest free
/// label: the one the UI picks next (`nextDocLabel`).
pub fn prepare_spare(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SPARE_AFTER).await;
        let label = {
            let spare = app.state::<Spare>();
            let mut g = lock(&spare.0);
            if g.is_some() {
                return;
            }
            let Some(label) = (1..).map(|n: u32| format!("doc-{n}")).find(|l| app.get_window(l).is_none()) else {
                return;
            };
            *g = Some((label.clone(), None));
            label
        };
        if let Err(e) = build(&app, &app.state::<Location>(), &label) {
            log::warn!("creating the spare window {label}: {e}");
            lock(&app.state::<Spare>().0).take_if(|(l, _)| *l == label);
        }
    });
}

/// Document window `closed` is gone: the spare is made again when its label is no longer the
/// lowest free one, since the UI would pick that one instead.
fn respare(app: &AppHandle, closed: &str) {
    let Some(n) = doc_number(closed) else {
        return;
    };
    let stale = {
        let spare = app.state::<Spare>();
        let mut g = lock(&spare.0);
        g.take_if(|(l, _)| doc_number(l).is_some_and(|s| s > n))
    };
    if let Some((label, _)) = stale {
        if let Some(w) = app.get_window(&label)
            && let Err(e) = w.destroy()
        {
            log::warn!("closing the spare window {label}: {e}");
        }
        prepare_spare(app);
    }
}

/// The calling window's frontend waits here before it mounts: at once, unless it is the spare,
/// which waits until a tab or document is sent to it (`take_spare`).
#[tauri::command]
pub async fn window_adopted(spare: State<'_, Spare>, webview: Webview) -> Result<(), String> {
    let label = webview.window().label().to_string();
    let woken = {
        let mut g = lock(&spare.0);
        match g.as_mut() {
            Some((l, wake)) if *l == label => {
                let (tx, rx) = oneshot::channel();
                *wake = Some(tx);
                rx
            }
            _ => return Ok(()),
        }
    };
    woken.await.map_err(err)
}

fn show(app: &AppHandle, label: &str) {
    let Some(w) = app.get_window(label) else {
        return;
    };
    // Showing an already visible window would take the focus.
    if !w.is_visible().unwrap_or(true)
        && let Err(e) = w.show()
    {
        log::warn!("showing {label}: {e}");
    }
}

/// The calling pop-out has mounted its UI: it shows, unless it is following a tab drag (which shows it).
#[tauri::command]
pub async fn window_ready(app: AppHandle, webview: Webview) -> Result<(), String> {
    let label = webview.window().label().to_string();
    if !tabdrag::claim_ready(&app, &label) {
        show(&app, &label);
    }
    Ok(())
}

/// Closes the calling pop-out. Its page webviews go to the main window first, hidden: the UI is
/// moving their tabs there, and they would close with this window.
#[tauri::command]
pub async fn close_window(app: AppHandle, state: State<'_, App>, webview: Webview) -> Result<(), String> {
    let w = webview.window();
    if !is_popout(w.label()) {
        return Err("not a pop-out window".into());
    }
    if let Some(main) = app.get_window(MAIN) {
        browser::park_all(&app, &w, &main).await;
    }
    save_geometry(&state, &w);
    w.destroy().map_err(err)?;
    respare(&app, w.label());
    Ok(())
}

/// The main window's close quits the app, as before pop-outs existed; its position and the
/// pop-outs' are saved first, since they go down with it (their contents are saved by the UI as they change).
pub fn on_window_event(w: &Window, e: &WindowEvent) {
    if w.label() != MAIN {
        return;
    }
    let app = w.app_handle();
    match e {
        WindowEvent::CloseRequested { .. } => {
            if let Some(state) = app.try_state::<App>() {
                for (label, win) in app.windows() {
                    // Not the spare: it never showed, and the place saved under its label is another window's.
                    if (label == MAIN || is_popout(&label)) && win.is_visible().unwrap_or(false) {
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
    fn a_document_windows_number_is_its_label_s() {
        assert_eq!((doc_number("doc-1"), doc_number("doc-12")), (Some(1), Some(12)));
        for other in ["doc-", "doc-x", "chat", "main", "doc-1-2"] {
            assert_eq!(doc_number(other), None, "{other:?}");
        }
    }

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
