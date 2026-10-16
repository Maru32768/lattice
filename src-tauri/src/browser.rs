//! In-app browser: a child webview over the main window's content area that shows the real
//! page and runs the translation overlay. Links navigate in place; pop-ups open here too.
//!
//! Trust boundary: the page is remote and untrusted. Its webview gets only the capability in
//! `capabilities/browser.json` (overlay_config / overlay_translate), and translate calls are
//! refused unless the user has switched translation on.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Url, Webview, WebviewBuilder, WebviewUrl};

pub const LABEL: &str = "browser";
const OVERLAY_JS: &str = include_str!("../overlay-dist/overlay.js");

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
}

impl Default for Browser {
    fn default() -> Self {
        Self {
            config: Mutex::new(OverlayConfig { enabled: false, percent: 70 }),
            focus: Mutex::new(None),
            opening: tokio::sync::Mutex::new(()),
        }
    }
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

fn http_url(s: &str) -> Result<Url, String> {
    let u = Url::parse(s.trim()).map_err(|e| format!("invalid URL: {e}"))?;
    matches!(u.scheme(), "http" | "https").then_some(u).ok_or_else(|| "only http(s) pages can be opened".into())
}

fn is_http(u: &Url) -> bool {
    matches!(u.scheme(), "http" | "https")
}

fn place(wv: &Webview, b: &Bounds) -> tauri::Result<()> {
    wv.set_position(LogicalPosition::new(b.x, b.y))?;
    wv.set_size(LogicalSize::new(b.width.max(1.0), b.height.max(1.0)))
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
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
        wv.navigate(url).map_err(|e| e.to_string())?;
        place(&wv, &bounds).map_err(|e| e.to_string())?;
        return wv.show().map_err(|e| e.to_string());
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
                if let Some(text) = lock(&wv.app_handle().state::<Browser>().focus).take() {
                    let arg = serde_json::to_string(&text).expect("string serializes");
                    let _ = wv.eval(format!("window.__lattice&&window.__lattice.scrollToText({arg})"));
                }
            }
        })
        .on_document_title_changed(|wv, title| {
            let _ = wv.app_handle().emit_to("main", "browser-title", title);
        });
    window
        .add_child(builder, LogicalPosition::new(bounds.x, bounds.y), LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)))
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
/// Also shows the webview: the placeholder only exists while the browser view is on screen.
pub fn browser_set_bounds(app: AppHandle, bounds: Bounds) -> Result<(), String> {
    match app.get_webview(LABEL) {
        Some(wv) => place(&wv, &bounds).and_then(|_| wv.show()).map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

#[tauri::command]
pub fn browser_hide(app: AppHandle) -> Result<(), String> {
    match app.get_webview(LABEL) {
        Some(wv) => wv.hide().map_err(|e| e.to_string()),
        None => Ok(()),
    }
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
#[tauri::command]
pub fn overlay_config(browser: State<'_, Browser>) -> OverlayConfig {
    *lock(&browser.config)
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
