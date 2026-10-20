//! In-app browser: a child webview over the main window's content area that shows the real
//! page and runs the translation overlay. Links navigate in place; pop-ups open here too.
//!
//! Trust boundary: the page is remote and untrusted. Its webview gets only the capability in
//! `capabilities/browser.json` (overlay_config / overlay_translate / overlay_snapshot / overlay_history / overlay_key), translate calls are
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

/// The app shortcuts the overlay forwards (`PageKeys` in `src/keys.ts`), passed through to the page.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageKeys {
    in_fields: Vec<String>,
    outside: Vec<String>,
    prefix: Vec<String>,
    prefix_ms: u32,
}

pub struct Browser {
    pub config: Mutex<OverlayConfig>,
    keys: Mutex<Option<PageKeys>>,
    /// Text to scroll to once the next page finishes loading (search-result jumps).
    focus: Mutex<Option<String>>,
    /// Serializes create-or-navigate so overlapping opens cannot create the webview twice.
    opening: tokio::sync::Mutex<()>,
    visibility: Mutex<Visibility>,
    /// (can go back, can go forward) of the current page, as the overlay last reported it.
    history: Mutex<(bool, bool)>,
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

/// The webview is on screen only while the UI shows the browser view and the current page has
/// loaded; until then the placeholder underneath shows a loading state instead of the previous
/// page. A loading page is parked off-screen rather than hidden: a hidden WebView2 stops
/// rendering, and revealing it would first show the stale frame of the page before.
#[derive(Default)]
struct Visibility {
    wanted: bool,
    loading: bool,
    /// Where the UI's placeholder is.
    bounds: Option<Bounds>,
}

/// Off the window's client area, as the renderer's webview (`renderer.rs`).
const PARKED: (f64, f64) = (-20000.0, -20000.0);

impl Default for Browser {
    fn default() -> Self {
        Self {
            config: Mutex::new(OverlayConfig { enabled: false, percent: 70 }),
            keys: Mutex::new(None),
            focus: Mutex::new(None),
            opening: tokio::sync::Mutex::new(()),
            visibility: Mutex::new(Visibility::default()),
            history: Mutex::new((true, true)),
            snapshots: Snapshots::default(),
        }
    }
}

fn update_visibility(wv: &Webview, browser: &Browser, f: impl FnOnce(&mut Visibility)) -> tauri::Result<()> {
    let (wanted, loading, bounds) = {
        let mut v = lock(&browser.visibility);
        f(&mut v);
        (v.wanted, v.loading, v.bounds)
    };
    // Lock released first: show/hide may wait on the main thread, which may want this lock.
    match bounds.filter(|_| wanted) {
        Some(b) => {
            let (x, y) = if loading { PARKED } else { (b.x, b.y) };
            wv.set_position(LogicalPosition::new(x, y))?;
            wv.set_size(LogicalSize::new(b.width.max(1.0), b.height.max(1.0)))?;
            wv.show()
        }
        None => wv.hide(),
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
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
    can_go_back: bool,
    can_go_forward: bool,
}

fn emit_page(wv: &Webview, browser: &Browser, url: String) {
    let loading = lock(&browser.visibility).loading;
    let reported = *lock(&browser.history);
    let app = wv.app_handle().clone();
    let send = move |(can_go_back, can_go_forward): (bool, bool)| {
        let _ = app.emit_to("main", "browser-page", PageEvent { url, loading, can_go_back, can_go_forward });
    };
    // The page's `navigation` API only sees same-origin entries, so after moving to another site
    // it reports no way back; WebView2 knows the whole history.
    #[cfg(windows)]
    if let Err(e) = wv.with_webview(move |pw| send(unsafe { native_history(&pw) }.unwrap_or(reported))) {
        log::warn!("reading the page history: {e}");
    }
    #[cfg(not(windows))]
    send(reported);
}

#[cfg(windows)]
unsafe fn native_history(pw: &tauri::webview::PlatformWebview) -> windows::core::Result<(bool, bool)> {
    let core = unsafe { pw.controller().CoreWebView2()? };
    let (mut back, mut forward) = (windows::core::BOOL::default(), windows::core::BOOL::default());
    unsafe {
        core.CanGoBack(&mut back)?;
        core.CanGoForward(&mut forward)?;
    }
    Ok((back.as_bool(), forward.as_bool()))
}

pub(crate) fn http_url(s: &str) -> Result<Url, String> {
    let u = Url::parse(s.trim()).map_err(|e| format!("invalid URL: {e}"))?;
    matches!(u.scheme(), "http" | "https").then_some(u).ok_or_else(|| "only http(s) pages can be opened".into())
}

pub(crate) fn is_http(u: &Url) -> bool {
    matches!(u.scheme(), "http" | "https")
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
    let opened = Visibility { wanted: true, loading: true, bounds: Some(bounds) };
    if let Some(wv) = app.get_webview(LABEL) {
        update_visibility(&wv, &browser, |v| *v = opened).map_err(|e| e.to_string())?;
        return wv.navigate(url).map_err(|e| e.to_string());
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
            let browser = wv.app_handle().state::<Browser>();
            if loading {
                *lock(&browser.history) = (true, true); // until the new page's overlay reports
            }
            // Every navigation, in-page links and back/forward too, keeps the page off-screen until it has loaded.
            let _ = update_visibility(&wv, &browser, |v| v.loading = loading);
            emit_page(&wv, &browser, p.url().to_string());
            if !loading {
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
        .add_child(builder, LogicalPosition::new(PARKED.0, PARKED.1), LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)))
        .map_err(|e| e.to_string())?;
    update_visibility(&wv, &browser, |v| *v = opened).map_err(|e| e.to_string())
}

#[tauri::command]
/// Also shows the webview (once loaded): the placeholder only exists while the browser view is on screen.
pub fn browser_set_bounds(app: AppHandle, browser: State<'_, Browser>, bounds: Bounds) -> Result<(), String> {
    match app.get_webview(LABEL) {
        Some(wv) => update_visibility(&wv, &browser, |v| {
            v.wanted = true;
            v.bounds = Some(bounds);
        })
        .map_err(|e| e.to_string()),
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

#[cfg(windows)]
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(2);

/// The page as the webview currently draws it, as a PNG data URL at device pixels, for the UI to
/// show in the webview's place while an app overlay needs it hidden. None off Windows.
#[tauri::command]
#[cfg_attr(not(windows), allow(unused_variables))]
pub async fn browser_capture(app: AppHandle) -> Result<Option<String>, String> {
    #[cfg(windows)]
    if let Some(wv) = app.get_webview(LABEL) {
        let png = tokio::time::timeout(CAPTURE_TIMEOUT, capture_png(&wv)).await.map_err(|_| "capture timed out")??;
        return Ok(Some(format!("data:image/png;base64,{}", lattice_core::images::base64(&png))));
    }
    Ok(None)
}

#[cfg(windows)]
async fn capture_png(wv: &Webview) -> Result<Vec<u8>, String> {
    use webview2_com::CapturePreviewCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
    use windows::Win32::UI::Shell::SHCreateMemStream;

    let (tx, rx) = oneshot::channel();
    wv.with_webview(move |pw| unsafe {
        let Some(stream) = SHCreateMemStream(None) else { return };
        let out = stream.clone();
        // Fires later on this (main) thread; if CapturePreview fails, dropping it closes the channel.
        let done = CapturePreviewCompletedHandler::create(Box::new(move |hr| {
            let _ = tx.send(hr.and_then(|()| read_stream(&out)));
            Ok(())
        }));
        let started = pw.controller().CoreWebView2().and_then(|core| core.CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, &stream, &done));
        if let Err(e) = started {
            log::warn!("CapturePreview: {e}");
        }
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|_| "capture failed".to_string())?.map_err(|e| e.to_string())
}

#[cfg(windows)]
unsafe fn read_stream(s: &windows::Win32::System::Com::IStream) -> windows::core::Result<Vec<u8>> {
    use windows::Win32::System::Com::STREAM_SEEK_SET;
    let mut out = Vec::new();
    let mut buf = vec![0u8; 1 << 16];
    unsafe {
        s.Seek(0, STREAM_SEEK_SET, None)?;
        loop {
            let mut n = 0u32;
            s.Read(buf.as_mut_ptr().cast(), buf.len() as u32, Some(&mut n)).ok()?;
            if n == 0 {
                return Ok(out);
            }
            out.extend_from_slice(&buf[..n as usize]);
        }
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

/// Called by the overlay with Chromium's `navigation.canGoBack/canGoForward` on load and after
/// same-document navigations. Exposed to remote pages; it only sets the toolbar's buttons.
#[tauri::command]
pub fn overlay_history(browser: State<'_, Browser>, webview: Webview, can_go_back: bool, can_go_forward: bool) -> Result<(), String> {
    if webview.label() != LABEL {
        return Err("not the browser webview".into());
    }
    *lock(&browser.history) = (can_go_back, can_go_forward);
    emit_page(&webview, &browser, webview.url().map_err(|e| e.to_string())?.to_string());
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

#[derive(Serialize)]
pub struct OverlayBoot {
    #[serde(flatten)]
    config: OverlayConfig,
    keys: Option<PageKeys>,
}

/// Called by the overlay on every page load. Exposed to remote pages (read-only).
/// Only the visible browser translates and forwards shortcuts; the renderer's page stays as served.
#[tauri::command]
pub fn overlay_config(browser: State<'_, Browser>, webview: Webview) -> OverlayBoot {
    let config = *lock(&browser.config);
    if webview.label() == LABEL {
        OverlayBoot { config, keys: lock(&browser.keys).clone() }
    } else {
        OverlayBoot { config: OverlayConfig { enabled: false, ..config }, keys: None }
    }
}

/// The user's shortcuts changed (or the app started): the overlay forwards these from now on.
#[tauri::command]
pub async fn browser_set_keys(app: AppHandle, browser: State<'_, Browser>, keys: PageKeys) -> Result<(), String> {
    let arg = serde_json::to_string(&keys).expect("keys serialize");
    *lock(&browser.keys) = Some(keys);
    if let Some(wv) = app.get_webview(LABEL) {
        wv.eval(format!("window.__lattice&&window.__lattice.setKeys({arg})")).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Called by the overlay with an app shortcut pressed while the page has focus. Exposed to remote
/// pages, so a page can press the app's shortcuts itself; it can do no more than the user's keys
/// can, and only while it is on screen.
#[tauri::command]
pub fn overlay_key(browser: State<'_, Browser>, webview: Webview, key: String) -> Result<(), String> {
    if webview.label() != LABEL {
        return Err("not the browser webview".into());
    }
    let shown = {
        let v = lock(&browser.visibility);
        v.wanted && !v.loading
    };
    if !shown || key.len() > 64 {
        return Err("key refused".into());
    }
    webview.app_handle().emit_to("main", "browser-key", key).map_err(|e| e.to_string())
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

    #[test]
    fn page_keys_keep_the_overlay_shape() {
        let keys: PageKeys = serde_json::from_str(r#"{"inFields":["Ctrl+K"],"outside":["J"],"prefix":["Ctrl+B"],"prefixMs":1500}"#).unwrap();
        let boot = serde_json::to_value(OverlayBoot { config: OverlayConfig { enabled: true, percent: 70 }, keys: Some(keys) }).unwrap();
        assert_eq!(boot["enabled"], true, "config fields at the top level, as configure() takes them");
        assert_eq!(boot["keys"]["inFields"][0], "Ctrl+K");
        assert_eq!(boot["keys"]["prefixMs"], 1500);
    }
}
