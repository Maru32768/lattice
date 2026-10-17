//! In-app browser: a child webview over the main window's content area that shows the real
//! page and runs the translation overlay. Links navigate in place; pop-ups open here too.
//!
//! Trust boundary: the page is remote and untrusted. Its webview gets only the capability in
//! `capabilities/browser.json` (overlay_config / overlay_translate / overlay_snapshot), translate calls are
//! refused unless the user has switched translation on, and snapshots unless the app asked for one.
//! The background renderer's hidden webview (`renderer.rs`) gets the same capability, never translation.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Url, Webview, WebviewBuilder, WebviewUrl};

pub const LABEL: &str = "browser";
pub const RENDER_LABEL: &str = "renderer";
pub(crate) const OVERLAY_JS: &str = include_str!("../overlay-dist/overlay.js");

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct OverlayConfig {
    pub enabled: bool,
    pub percent: u8,
}

pub struct Browser {
    pub config: Mutex<OverlayConfig>,
    /// Text to scroll to once the next page finishes loading (search-result jumps).
    focus: Mutex<Option<String>>,
    /// Serializes create-or-navigate so overlapping opens cannot create the webview twice.
    opening: tokio::sync::Mutex<()>,
    visibility: Mutex<Visibility>,
    snapshots: Snapshots,
}

type SnapshotReply = oneshot::Sender<(String, String)>;

/// Outstanding DOM snapshot requests, at most one per webview label: (nonce, reply channel for (url, html)).
#[derive(Default)]
struct Snapshots(Mutex<HashMap<String, (String, SnapshotReply)>>);

impl Snapshots {
    /// Replaces any older request for `label`, whose waiter then gets nothing.
    fn begin(&self, label: &str) -> (String, oneshot::Receiver<(String, String)>) {
        use std::hash::{BuildHasher, Hasher};
        // Only pairs the reply with this request (the page can read it); unguessable is not needed.
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());
        let nonce = format!("{:016x}", h.finish());
        let (tx, rx) = oneshot::channel();
        lock(&self.0).insert(label.to_string(), (nonce.clone(), tx));
        (nonce, rx)
    }

    /// The reply channel, if `nonce` is the outstanding request of `label`.
    fn take(&self, label: &str, nonce: &str) -> Option<SnapshotReply> {
        let mut pending = lock(&self.0);
        if pending.get(label).is_some_and(|(n, _)| n == nonce) { pending.remove(label).map(|(_, tx)| tx) } else { None }
    }
}

/// The webview is on screen only while the UI shows the browser view and the page opened
/// from the app has loaded; until then the placeholder underneath shows a loading state
/// instead of the previous page.
#[derive(Default)]
struct Visibility {
    wanted: bool,
    loading: bool,
}

impl Default for Browser {
    fn default() -> Self {
        Self {
            config: Mutex::new(OverlayConfig { enabled: false, percent: 70 }),
            focus: Mutex::new(None),
            opening: tokio::sync::Mutex::new(()),
            visibility: Mutex::new(Visibility::default()),
            snapshots: Snapshots::default(),
        }
    }
}

fn update_visibility(wv: &Webview, browser: &Browser, f: impl FnOnce(&mut Visibility)) -> tauri::Result<()> {
    let show = {
        let mut v = lock(&browser.visibility);
        f(&mut v);
        v.wanted && !v.loading
    };
    // Lock released first: show/hide may wait on the main thread, which may want this lock.
    if show { wv.show() } else { wv.hide() }
}

#[derive(Debug, Deserialize)]
pub struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Serialize)]
struct PageEvent {
    url: String,
    loading: bool,
}

pub(crate) fn http_url(s: &str) -> Result<Url, String> {
    let u = Url::parse(s.trim()).map_err(|e| format!("invalid URL: {e}"))?;
    matches!(u.scheme(), "http" | "https").then_some(u).ok_or_else(|| "only http(s) pages can be opened".into())
}

pub(crate) fn is_http(u: &Url) -> bool {
    matches!(u.scheme(), "http" | "https")
}

fn place(wv: &Webview, b: &Bounds) -> tauri::Result<()> {
    wv.set_position(LogicalPosition::new(b.x, b.y))?;
    wv.set_size(LogicalSize::new(b.width.max(1.0), b.height.max(1.0)))
}

pub(crate) fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// browser_open/go/set_translation are async on purpose: sync commands run on the main thread,
// where creating or navigating a WebView2 deadlocks. browser_hide/set_bounds stay sync so
// hide-then-show sequences from the UI apply in order.
#[tauri::command]
pub async fn browser_open(app: AppHandle, browser: State<'_, Browser>, url: String, bounds: Bounds, focus_text: Option<String>) -> Result<(), String> {
    let url = http_url(&url)?;
    let _opening = browser.opening.lock().await;
    *lock(&browser.focus) = focus_text.filter(|t| !t.trim().is_empty());
    if let Some(wv) = app.get_webview(LABEL) {
        update_visibility(&wv, &browser, |v| *v = Visibility { wanted: true, loading: true }).map_err(|e| e.to_string())?;
        wv.navigate(url).map_err(|e| e.to_string())?;
        return place(&wv, &bounds).map_err(|e| e.to_string());
    }
    let window = app.get_window("main").ok_or("main window missing")?;
    let popup_target = app.clone();
    let builder = WebviewBuilder::new(LABEL, WebviewUrl::External(url))
        .initialization_script(OVERLAY_JS)
        // Never leave the web: no file:, custom schemes or app-internal URLs in this webview.
        .on_navigation(is_http)
        .on_new_window(move |u, _| {
            if is_http(&u) {
                if let Some(wv) = popup_target.get_webview(LABEL) {
                    let _ = wv.navigate(u);
                }
            }
            NewWindowResponse::Deny
        })
        .on_page_load(|wv, p| {
            let loading = matches!(p.event(), PageLoadEvent::Started);
            let _ = wv.app_handle().emit_to("main", "browser-page", PageEvent { url: p.url().to_string(), loading });
            if !loading {
                let browser = wv.app_handle().state::<Browser>();
                let _ = update_visibility(&wv, &browser, |v| v.loading = false);
                if let Some(text) = lock(&browser.focus).take() {
                    let arg = serde_json::to_string(&text).expect("string serializes");
                    let _ = wv.eval(format!("window.__lattice&&window.__lattice.scrollToText({arg})"));
                }
            }
        })
        .on_document_title_changed(|wv, title| {
            let _ = wv.app_handle().emit_to("main", "browser-title", title);
        });
    let wv = window
        .add_child(builder, LogicalPosition::new(bounds.x, bounds.y), LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)))
        .map_err(|e| e.to_string())?;
    update_visibility(&wv, &browser, |v| *v = Visibility { wanted: true, loading: true }).map_err(|e| e.to_string())
}

#[tauri::command]
/// Also shows the webview (once loaded): the placeholder only exists while the browser view is on screen.
pub fn browser_set_bounds(app: AppHandle, browser: State<'_, Browser>, bounds: Bounds) -> Result<(), String> {
    match app.get_webview(LABEL) {
        Some(wv) => place(&wv, &bounds).and_then(|_| update_visibility(&wv, &browser, |v| v.wanted = true)).map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

#[tauri::command]
pub fn browser_hide(app: AppHandle, browser: State<'_, Browser>) -> Result<(), String> {
    match app.get_webview(LABEL) {
        Some(wv) => update_visibility(&wv, &browser, |v| v.wanted = false).map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(5);

/// The current page's rendered DOM and the webview's own URL, from the overlay.
/// None if the page does not answer in time (overlay missing, page busy or hostile).
pub async fn snapshot(app: &AppHandle, browser: &Browser) -> Option<(String, String)> {
    snapshot_of(&app.get_webview(LABEL)?, browser, None, SNAPSHOT_TIMEOUT).await
}

/// `settle`: (quiet ms, max ms) the overlay waits for DOM mutations to stop before snapshotting.
pub(crate) async fn snapshot_of(wv: &Webview, browser: &Browser, settle: Option<(u32, u32)>, timeout: Duration) -> Option<(String, String)> {
    let (nonce, rx) = browser.snapshots.begin(wv.label());
    let arg = serde_json::to_string(&nonce).expect("string serializes");
    let settle = settle.map_or("null".into(), |(quiet, max)| format!("{{quietMs:{quiet},maxMs:{max}}}"));
    let reply = match wv.eval(format!("window.__lattice&&window.__lattice.snapshot({arg},{settle})")) {
        Ok(()) => tokio::time::timeout(timeout, rx).await.ok().and_then(Result::ok),
        Err(_) => None,
    };
    browser.snapshots.take(wv.label(), &nonce);
    reply
}

/// Called by the overlay with the DOM it was asked for. Exposed to remote pages, so it only
/// answers an outstanding request from the app, caps the size, and takes the URL from the
/// webview rather than from the page.
#[tauri::command]
pub async fn overlay_snapshot(browser: State<'_, Browser>, webview: Webview, nonce: String, html: String) -> Result<(), String> {
    if ![LABEL, RENDER_LABEL].contains(&webview.label()) {
        return Err("not an app webview".into());
    }
    if html.len() > lattice_core::fetch::MAX_BODY {
        return Err("snapshot too large".into());
    }
    let tx = browser.snapshots.take(webview.label(), &nonce).ok_or("no snapshot was requested")?;
    let url = webview.url().map_err(|e| e.to_string())?;
    if !is_http(&url) {
        return Err("only http(s) pages can be saved".into());
    }
    let _ = tx.send((url.to_string(), html));
    Ok(())
}

#[tauri::command]
pub async fn browser_go(app: AppHandle, action: String) -> Result<(), String> {
    let Some(wv) = app.get_webview(LABEL) else { return Ok(()) };
    match action.as_str() {
        "back" => wv.eval("history.back()"),
        "forward" => wv.eval("history.forward()"),
        "reload" => wv.reload(),
        other => return Err(format!("unknown action: {other}")),
    }
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_set_translation(app: AppHandle, browser: State<'_, Browser>, enabled: bool, percent: u8) -> Result<(), String> {
    let cfg = OverlayConfig { enabled, percent: percent.min(100) };
    *lock(&browser.config) = cfg;
    if let Some(wv) = app.get_webview(LABEL) {
        let arg = serde_json::to_string(&cfg).expect("config serializes");
        wv.eval(format!("window.__lattice&&window.__lattice.configure({arg})")).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Called by the overlay on every page load. Exposed to remote pages (read-only).
/// Only the visible browser translates; the renderer's page stays as served.
#[tauri::command]
pub fn overlay_config(browser: State<'_, Browser>, webview: Webview) -> OverlayConfig {
    let cfg = *lock(&browser.config);
    if webview.label() == LABEL { cfg } else { OverlayConfig { enabled: false, ..cfg } }
}

/// Guards overlay_translate: the caller must be the browser webview with translation on.
pub fn ensure_translation_allowed(webview: &Webview, browser: &Browser) -> Result<(), String> {
    if webview.label() != LABEL {
        return Err("not the browser webview".into());
    }
    if !lock(&browser.config).enabled {
        return Err("translation is off".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_nonces_are_per_label_and_single_use() {
        let s = Snapshots::default();
        let (b, _rb) = s.begin(LABEL);
        let (r, _rr) = s.begin(RENDER_LABEL);
        assert!(s.take(LABEL, &r).is_none(), "another webview's nonce");
        assert!(s.take(RENDER_LABEL, &r).is_some());
        assert!(s.take(RENDER_LABEL, &r).is_none(), "used once");
        let (b2, _rb2) = s.begin(LABEL);
        assert!(s.take(LABEL, &b).is_none(), "superseded by a newer request");
        assert!(s.take(LABEL, &b2).is_some());
    }
}
