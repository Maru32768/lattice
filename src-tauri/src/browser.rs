//! In-app browser: one child webview per visible Page tab, over the content area of the window
//! whose UI shows the tab (the main window or a pop-out, G52), showing the real page and running
//! the translation overlay. Links navigate in place; pop-ups open in the same webview.
//!
//! Trust boundary: the pages are remote and untrusted. Their webviews (labels `browser-<tab>`)
//! get only the capability in `capabilities/browser.json` (overlay_config / overlay_translate /
//! overlay_snapshot / overlay_history / overlay_progress / overlay_key / overlay_vocab / overlay_print), translate calls are refused
//! unless the user has switched translation on, snapshots unless the app asked for one, and word
//! captures unless the page is on screen and the last one is a moment ago. The background
//! renderer's hidden webview (`renderer.rs`) gets the same capability, never translation.

#![allow(unsafe_code, reason = "WebView2 and COM calls through the windows crate")]

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, State, Url, Webview, WebviewBuilder, WebviewUrl, Window};
use tokio::sync::oneshot;
use ts_rs::TS;

/// Labels of the page webviews: `browser-<tab key>`. The key (`PageTab.key` in `src/layout/layout.ts`)
/// names the tab across windows and restarts; the UI's numeric tab ids are per window.
const PREFIX: &str = "browser-";
pub const RENDER_LABEL: &str = "renderer";
pub(crate) const OVERLAY_JS: &str = include_str!("../overlay-dist/overlay.js");
/// Keys are short and alphanumeric (`newKey` in `src/layout/layout.ts`); anything else is not a tab of ours.
const MAX_KEY: usize = 32;

/// Hidden tabs keep their webview (instant switching, history and scroll kept) up to this many;
/// creating one more closes the one hidden longest, and the UI reopens it when shown again.
const MAX_PARKED: usize = 3;

/// The webview label of tab `key`; an error for a key the UI could not have made.
pub fn label(key: &str) -> Result<String, String> {
    if key.is_empty() || key.len() > MAX_KEY || !key.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err("invalid tab key".into());
    }
    Ok(format!("{PREFIX}{key}"))
}

pub fn is_browser(label: &str) -> bool {
    label.starts_with(PREFIX)
}

fn tab_of(label: &str) -> Option<&str> {
    label.strip_prefix(PREFIX)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OverlayConfig {
    pub enabled: bool,
    pub percent: u8,
    pub labels: OverlayLabels,
}

/// The overlay's tooltip text in the display language, from the UI's catalog (G51); empty until the UI sends it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct OverlayLabels {
    /// The display language itself ("ja" / "en"): the mixed percent counts text in it.
    lang: String,
    original: String,
    translated: String,
    flip: String,
    translating: String,
    failed: String,
    retry: String,
    /// 単語を登録 and its confirmation.
    save_word: String,
    saved_word: String,
}

/// The app shortcuts the overlay forwards (`PageKeys` in `src/lib/keys.ts`), passed through to the page.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageKeys {
    in_fields: Vec<String>,
    outside: Vec<String>,
    prefix: Vec<String>,
    prefix_ms: u32,
}

pub struct Browser {
    /// Shared by every page webview, like the Reader's display language is shared by articles.
    pub config: Mutex<OverlayConfig>,
    keys: Mutex<Option<PageKeys>>,
    /// Per webview label.
    tabs: Mutex<HashMap<String, TabState>>,
    /// Serializes create-or-navigate so overlapping opens cannot create a webview twice.
    opening: tokio::sync::Mutex<()>,
    snapshots: Snapshots,
}

struct TabState {
    /// Text to scroll to once the next page finishes loading (search-result jumps).
    focus: Option<String>,
    visibility: Visibility,
    /// (can go back, can go forward) of the current page, as the overlay last reported it.
    history: (bool, bool),
    /// Since when the webview has been hidden.
    parked: Option<Instant>,
    /// The page's last word capture (overlay_vocab).
    captured: Option<Instant>,
}

impl Default for TabState {
    fn default() -> Self {
        Self { focus: None, visibility: Visibility::default(), history: (true, true), parked: None, captured: None }
    }
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
        if pending.get(label).is_some_and(|(n, _)| n == nonce) {
            pending.remove(label).map(|(_, tx)| tx)
        } else {
            None
        }
    }
}

/// A webview is on screen only while the UI shows its tab and the current page has loaded; until
/// then the placeholder underneath shows a loading state instead of the previous page. A loading
/// page is parked off-screen rather than hidden: a hidden WebView2 stops rendering, and revealing
/// it would first show the stale frame of the page before.
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
            config: Mutex::new(OverlayConfig { enabled: false, percent: 70, labels: OverlayLabels::default() }),
            keys: Mutex::new(None),
            tabs: Mutex::new(HashMap::new()),
            opening: tokio::sync::Mutex::new(()),
            snapshots: Snapshots::default(),
        }
    }
}

impl Browser {
    fn with_tab<T>(&self, label: &str, f: impl FnOnce(&mut TabState) -> T) -> T {
        f(lock(&self.tabs).entry(label.to_string()).or_default())
    }

    /// Every page webview, by label.
    fn webviews(&self, app: &AppHandle) -> Vec<(String, Webview)> {
        app.webviews().into_iter().filter(|(l, _)| is_browser(l)).collect()
    }

    /// Closes hidden webviews beyond MAX_PARKED, oldest first.
    fn evict(&self, app: &AppHandle) {
        for label in to_evict(&lock(&self.tabs)) {
            if let Some(wv) = app.get_webview(&label)
                && let Err(e) = wv.close()
            {
                log::warn!("closing the webview {label}: {e}");
            }
            lock(&self.tabs).remove(&label);
        }
    }
}

/// The hidden webviews that have been hidden longest, beyond the newest MAX_PARKED.
fn to_evict(tabs: &HashMap<String, TabState>) -> Vec<String> {
    let mut parked: Vec<(Instant, &String)> = tabs.iter().filter_map(|(l, t)| t.parked.filter(|_| !t.visibility.wanted).map(|at| (at, l))).collect();
    parked.sort();
    parked.iter().rev().skip(MAX_PARKED).map(|(_, l)| (*l).clone()).collect()
}

fn update_visibility(wv: &Webview, browser: &Browser, f: impl FnOnce(&mut Visibility)) -> tauri::Result<()> {
    let (wanted, loading, bounds) = browser.with_tab(wv.label(), |t| {
        f(&mut t.visibility);
        let v = &t.visibility;
        t.parked = if v.wanted {
            None
        } else {
            t.parked.or_else(|| Some(Instant::now()))
        };
        (v.wanted, v.loading, v.bounds)
    });
    // Lock released first: show/hide may wait on the main thread, which may want this lock.
    match bounds.filter(|_| wanted) {
        Some(b) => {
            let (x, y) = if loading {
                PARKED
            } else {
                (b.x, b.y)
            };
            // One message: set_position then set_size each read the webview's current rect and
            // write it back whole, so the second could put back a position the first had not applied yet.
            wv.set_bounds(Rect { position: LogicalPosition::new(x, y).into(), size: LogicalSize::new(b.width.max(1.0), b.height.max(1.0)).into() })?;
            wv.show()
        }
        None => wv.hide(),
    }
}

#[derive(Debug, Clone, Copy, Deserialize, TS)]
#[ts(export)]
pub struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Serialize)]
struct PageEvent {
    tab: String,
    url: String,
    loading: bool,
    can_go_back: bool,
    can_go_forward: bool,
}

#[derive(Clone, Serialize)]
struct TabEvent<T: Serialize> {
    tab: String,
    #[serde(flatten)]
    body: T,
}

/// A body with no fields (`browser-focus` only names the tab).
#[derive(Clone, Serialize)]
struct Empty {}

/// Tab events go to the window the webview is in: that window's UI holds the tab.
fn emit_tab<T: Serialize + Clone>(wv: &Webview, event: &str, body: T) {
    if let Some(tab) = tab_of(wv.label()) {
        let _ = wv.app_handle().emit_to(wv.window().label(), event, TabEvent { tab: tab.to_string(), body });
    }
}

fn emit_page(wv: &Webview, browser: &Browser, url: String) {
    let Some(tab) = tab_of(wv.label()).map(str::to_string) else {
        return;
    };
    let (loading, reported) = browser.with_tab(wv.label(), |t| (t.visibility.loading, t.history));
    let (app, host) = (wv.app_handle().clone(), wv.window().label().to_string());
    let send = move |(can_go_back, can_go_forward): (bool, bool)| {
        let _ = app.emit_to(host, "browser-page", PageEvent { tab, url, loading, can_go_back, can_go_forward });
    };
    // The page's `navigation` API only sees same-origin entries, so after moving to another site
    // it reports no way back; WebView2 knows the whole history.
    #[cfg(windows)]
    // SAFETY: with_webview runs this on the main thread with wry's live controller.
    if let Err(e) = wv.with_webview(move |pw| send(unsafe { native_history(&pw) }.unwrap_or(reported))) {
        log::warn!("reading the page history: {e}");
    }
    #[cfg(not(windows))]
    send(reported);
}

/// # Safety
/// On the main thread, with `pw` from `with_webview` (its controller is alive there).
#[cfg(windows)]
unsafe fn native_history(pw: &tauri::webview::PlatformWebview) -> windows::core::Result<(bool, bool)> {
    // SAFETY: the caller's contract: a live controller on its own thread.
    let core = unsafe { pw.controller().CoreWebView2()? };
    let (mut back, mut forward) = (windows::core::BOOL::default(), windows::core::BOOL::default());
    // SAFETY: `core` is alive for this call; the out-pointers are locals that outlive it.
    unsafe {
        core.CanGoBack(&mut back)?;
        core.CanGoForward(&mut forward)?;
    }
    Ok((back.as_bool(), forward.as_bool()))
}

/// A click in the page focuses its pane in the UI, as a click in a Reader would. Only Windows
/// reports it (WebView2's GotFocus); elsewhere the pane is focused by the next shortcut from the page.
#[cfg(windows)]
fn watch_focus(wv: &Webview) {
    use webview2_com::FocusChangedEventHandler;
    let webview = wv.clone();
    // The COM handler is made on the main thread, inside the closure: it cannot be sent there.
    if let Err(e) = wv.with_webview(move |pw| {
        let handler = FocusChangedEventHandler::create(Box::new(move |_, _| {
            emit_tab(&webview, "browser-focus", Empty {});
            Ok(())
        }));
        let mut token = 0i64;
        // SAFETY: on the main thread with wry's live controller; `token` outlives the call.
        if let Err(e) = unsafe { pw.controller().add_GotFocus(&handler, &mut token) } {
            log::warn!("GotFocus: {e}");
        }
    }) {
        log::warn!("watching the page focus: {e}");
    }
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

/// Whether page webview `wv` is in `window`. A tab that moved to another window brings its
/// webview along when that window opens it (`attach`).
fn in_window(wv: &Webview, window: &Window) -> bool {
    wv.window().label() == window.label()
}

/// Moves page webview `wv` into `window`, whose UI shows its tab now: the page keeps its history
/// and scroll position, as a tab dragged between Chrome windows does. If it cannot move, it is
/// closed and the tab opens its page again there.
async fn attach(app: &AppHandle, wv: Webview, window: &Window) -> Result<(), String> {
    match wv.reparent(window) {
        Ok(()) => {
            #[cfg(windows)]
            settle(&wv);
            Ok(())
        }
        Err(e) => {
            log::warn!("moving {} to {}: {e}", wv.label(), window.label());
            close_page(app, wv).await
        }
    }
}

/// After a move to another window, WebView2 is told its top-level window changed (wry does that
/// only for a webview that fills its window), and the page goes above the window's own UI webview,
/// as a new one does. Without them the moved page drew at the old window's offset (a1fe3b4).
#[cfg(windows)]
fn settle(wv: &Webview) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{HWND_TOP, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SetWindowPos};
    let r = wv.with_webview(|pw| {
        let c = pw.controller();
        let mut host = HWND::default();
        // SAFETY: with_webview runs this on the main thread with wry's live controller; `host` is a
        // local the call writes, and the window it names is wry's container of this webview.
        unsafe {
            let _ = c.NotifyParentWindowPositionChanged();
            if c.ParentWindow(&mut host).is_ok() {
                let _ = SetWindowPos(host, Some(HWND_TOP), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            }
        }
    });
    if let Err(e) = r {
        log::warn!("placing {} in its new window: {e}", wv.label());
    }
}

/// Window `from` is closing: its page webviews go into `to`, hidden, because the UI is sending
/// their tabs there and a child webview would close with its window.
pub async fn park_all(app: &AppHandle, from: &Window, to: &Window) {
    let browser = app.state::<Browser>();
    // After a move `browser_open` has begun, or before it: never in between.
    let _opening = browser.opening.lock().await;
    for wv in from.webviews().into_iter().filter(|wv| is_browser(wv.label())) {
        if let Err(e) = update_visibility(&wv, &browser, |v| v.wanted = false) {
            log::warn!("hiding {}: {e}", wv.label());
        }
        if let Err(e) = attach(app, wv, to).await {
            log::warn!("{e}");
        }
    }
}

/// Closes a page webview and waits until its label is free to be used again.
async fn close_page(app: &AppHandle, wv: Webview) -> Result<(), String> {
    let label = wv.label().to_string();
    wv.close().map_err(|e| e.to_string())?;
    for _ in 0..50 {
        if app.get_webview(&label).is_none() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Err(format!("{label} did not close"))
}

// browser_open/go/set_translation are async on purpose: sync commands run on the main thread,
// where creating or navigating a WebView2 deadlocks. browser_hide/set_bounds stay sync so
// hide-then-show sequences from the UI apply in order.
#[tauri::command]
pub async fn browser_open(
    app: AppHandle,
    browser: State<'_, Browser>,
    webview: Webview,
    tab: String,
    url: String,
    bounds: Bounds,
    focus_text: Option<String>,
) -> Result<(), String> {
    let url = http_url(&url)?;
    let label = label(&tab)?;
    let window = webview.window();
    let _opening = browser.opening.lock().await;
    let focus_text = focus_text.filter(|t| !t.trim().is_empty());
    let opened = Visibility { wanted: true, loading: true, bounds: Some(bounds) };
    let moved = match app.get_webview(&label).filter(|wv| !in_window(wv, &window)) {
        Some(wv) => {
            attach(&app, wv, &window).await?;
            true
        }
        None => false,
    };
    if let Some(wv) = app.get_webview(&label) {
        // Already showing this page, or the tab's own page come from another window (its URL may have
        // moved on in the page since the tab last saw it): no reload, its history and scroll stay.
        let loading = browser.with_tab(&label, |t| t.visibility.loading);
        if focus_text.is_none() && !loading && (moved || wv.url().is_ok_and(|u| u == url)) {
            update_visibility(&wv, &browser, |v| *v = Visibility { loading: false, ..opened }).map_err(|e| e.to_string())?;
            emit_page(&wv, &browser, url.to_string());
            return Ok(());
        }
        browser.with_tab(&label, |t| t.focus = focus_text);
        update_visibility(&wv, &browser, |v| *v = opened).map_err(|e| e.to_string())?;
        return wv.navigate(url).map_err(|e| e.to_string());
    }
    browser.with_tab(&label, |t| t.focus = focus_text);
    browser.evict(&app);
    let (popup_target, popup_label) = (app.clone(), label.clone());
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(url))
        .initialization_script(OVERLAY_JS)
        // Never leave the web: no file:, custom schemes or app-internal URLs in this webview.
        .on_navigation(is_http)
        .on_new_window(move |u, _| {
            if is_http(&u)
                && let Some(wv) = popup_target.get_webview(&popup_label)
            {
                let _ = wv.navigate(u);
            }
            NewWindowResponse::Deny
        })
        .on_page_load(|wv, p| {
            let loading = matches!(p.event(), PageLoadEvent::Started);
            let browser = wv.app_handle().state::<Browser>();
            if loading {
                browser.with_tab(wv.label(), |t| t.history = (true, true)); // until the new page's overlay reports
            }
            // Every navigation, in-page links and back/forward too, keeps the page off-screen until it has loaded.
            let _ = update_visibility(&wv, &browser, |v| v.loading = loading);
            emit_page(&wv, &browser, p.url().to_string());
            if !loading && let Some(text) = browser.with_tab(wv.label(), |t| t.focus.take()) {
                let arg = serde_json::to_string(&text).expect("string serializes");
                let _ = wv.eval(format!("window.__lattice&&window.__lattice.scrollToText({arg})"));
            }
        })
        .on_document_title_changed(|wv, title| {
            #[derive(Clone, Serialize)]
            struct Title {
                title: String,
            }
            emit_tab(&wv, "browser-title", Title { title });
        });
    let builder = match app.state::<crate::location::Location>().webview_dir() {
        Some(d) => builder.data_directory(d),
        None => builder,
    };
    let wv = window
        .add_child(builder, LogicalPosition::new(PARKED.0, PARKED.1), LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)))
        .map_err(|e| e.to_string())?;
    #[cfg(windows)]
    watch_focus(&wv);
    update_visibility(&wv, &browser, |v| *v = opened).map_err(|e| e.to_string())
}

/// Also shows the webview (once loaded) in the calling window: the placeholder only exists while
/// its tab is on screen. False when the tab has no webview (never opened, evicted, or restored at
/// startup): open it.
#[tauri::command]
pub fn browser_set_bounds(app: AppHandle, browser: State<'_, Browser>, webview: Webview, tab: String, bounds: Bounds) -> Result<bool, String> {
    match app.get_webview(&label(&tab)?) {
        // In another window: the UI opens the tab here, which brings the webview along (browser_open).
        Some(wv) if !in_window(&wv, &webview.window()) => Ok(false),
        Some(wv) => update_visibility(&wv, &browser, |v| {
            v.wanted = true;
            v.bounds = Some(bounds);
        })
        .map(|()| true)
        .map_err(|e| e.to_string()),
        None => Ok(false),
    }
}

#[tauri::command]
pub fn browser_hide(app: AppHandle, browser: State<'_, Browser>, tab: String) -> Result<(), String> {
    match app.get_webview(&label(&tab)?) {
        Some(wv) => update_visibility(&wv, &browser, |v| v.wanted = false).map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

/// The tab was closed (or shows a Reader now): its webview goes with it.
#[tauri::command]
pub async fn browser_close(app: AppHandle, browser: State<'_, Browser>, tab: String) -> Result<(), String> {
    let label = label(&tab)?;
    let _opening = browser.opening.lock().await;
    lock(&browser.tabs).remove(&label);
    match app.get_webview(&label) {
        Some(wv) => wv.close().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

#[cfg(windows)]
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(2);

/// The page as its webview currently draws it, as a PNG data URL at device pixels, for the UI to
/// show in the webview's place while an app overlay needs it hidden. None off Windows.
#[tauri::command]
#[cfg_attr(not(windows), allow(unused_variables))]
pub async fn browser_capture(app: AppHandle, tab: String) -> Result<Option<String>, String> {
    let label = label(&tab)?;
    #[cfg(windows)]
    if let Some(wv) = app.get_webview(&label) {
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
    // SAFETY: on the main thread with wry's live controller; the stream and handler are owned
    // COM references that WebView2 keeps until the capture completes.
    wv.with_webview(move |pw| unsafe {
        let Some(stream) = SHCreateMemStream(None) else {
            return;
        };
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

/// # Safety
/// `s` must be a live stream no other thread uses meanwhile.
#[cfg(windows)]
unsafe fn read_stream(s: &windows::Win32::System::Com::IStream) -> windows::core::Result<Vec<u8>> {
    use windows::Win32::System::Com::STREAM_SEEK_SET;
    let mut out = Vec::new();
    let mut buf = vec![0u8; 1 << 16];
    // SAFETY: the caller's contract for `s`; Read writes at most `buf.len()` bytes into `buf`.
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

/// The rendered DOM of tab's page and the webview's own URL, from the overlay.
/// None if the page does not answer in time (overlay missing, page busy or hostile).
pub async fn snapshot(app: &AppHandle, browser: &Browser, tab: &str) -> Option<(String, String)> {
    snapshot_of(&app.get_webview(&label(tab).ok()?)?, browser, None, SNAPSHOT_TIMEOUT).await
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
    if !is_browser(webview.label()) && webview.label() != RENDER_LABEL {
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
    if !is_browser(webview.label()) {
        return Err("not a browser webview".into());
    }
    browser.with_tab(webview.label(), |t| t.history = (can_go_back, can_go_forward));
    emit_page(&webview, &browser, webview.url().map_err(|e| e.to_string())?.to_string());
    Ok(())
}

#[derive(Clone, Serialize)]
struct Progress {
    done: u32,
    total: u32,
}

/// Called by the overlay as its translation advances: blocks done of those sent so far, shown on
/// the page's tab. Exposed to remote pages; it only sets that label.
#[tauri::command]
pub fn overlay_progress(webview: Webview, done: u32, total: u32) -> Result<(), String> {
    if !is_browser(webview.label()) {
        return Err("not a browser webview".into());
    }
    emit_tab(&webview, "browser-translate", Progress { done: done.min(total), total });
    Ok(())
}

#[tauri::command]
pub async fn browser_go(app: AppHandle, tab: String, action: String) -> Result<(), String> {
    let Some(wv) = app.get_webview(&label(&tab)?) else {
        return Ok(());
    };
    match action.as_str() {
        "back" => wv.eval("history.back()"),
        "forward" => wv.eval("history.forward()"),
        "reload" => wv.reload(),
        other => return Err(format!("unknown action: {other}")),
    }
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_set_translation(app: AppHandle, browser: State<'_, Browser>, enabled: bool, percent: u8, labels: OverlayLabels) -> Result<(), String> {
    let cfg = OverlayConfig { enabled, percent: percent.min(100), labels };
    let arg = serde_json::to_string(&cfg).expect("config serializes");
    *lock(&browser.config) = cfg;
    for (_, wv) in browser.webviews(&app) {
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
/// Only the visible browsers translate and forward shortcuts; the renderer's page stays as served.
#[tauri::command]
pub fn overlay_config(browser: State<'_, Browser>, webview: Webview) -> OverlayBoot {
    let config = lock(&browser.config).clone();
    if is_browser(webview.label()) {
        OverlayBoot { config, keys: lock(&browser.keys).clone() }
    } else {
        OverlayBoot { config: OverlayConfig { enabled: false, ..config }, keys: None }
    }
}

/// The user's shortcuts changed (or the app started): the overlays forward these from now on.
#[tauri::command]
pub async fn browser_set_keys(app: AppHandle, browser: State<'_, Browser>, keys: PageKeys) -> Result<(), String> {
    let arg = serde_json::to_string(&keys).expect("keys serialize");
    *lock(&browser.keys) = Some(keys);
    for (_, wv) in browser.webviews(&app) {
        wv.eval(format!("window.__lattice&&window.__lattice.setKeys({arg})")).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Called by the overlay with an app shortcut pressed while the page has focus. Exposed to remote
/// pages, so a page can press the app's shortcuts itself; it can do no more than the user's keys
/// can, and only while it is on screen.
#[tauri::command]
pub fn overlay_key(browser: State<'_, Browser>, webview: Webview, key: String) -> Result<(), String> {
    if !is_browser(webview.label()) {
        return Err("not a browser webview".into());
    }
    let shown = browser.with_tab(webview.label(), |t| t.visibility.wanted && !t.visibility.loading);
    if !shown || key.len() > 64 {
        return Err("key refused".into());
    }
    #[derive(Clone, Serialize)]
    struct Key {
        key: String,
    }
    emit_tab(&webview, "browser-key", Key { key });
    Ok(())
}

/// Called by the overlay for Ctrl+P and `window.print()`. WebView2's own print preview is drawn
/// inside the page's child webview and showed up behind the page; the system dialog is a window of
/// its own. Exposed to remote pages, which can call print() anyway; only while the page is on
/// screen. False off Windows, where the overlay falls back to the page's own print.
#[tauri::command]
pub async fn overlay_print(browser: State<'_, Browser>, webview: Webview) -> Result<bool, String> {
    if !is_browser(webview.label()) {
        return Err("not a browser webview".into());
    }
    if !browser.with_tab(webview.label(), |t| t.visibility.wanted && !t.visibility.loading) {
        return Err("print refused".into());
    }
    #[cfg(windows)]
    {
        use webview2_com::Microsoft::Web::WebView2::Win32::{COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM, ICoreWebView2_16};
        use windows::core::Interface;
        webview
            .with_webview(|pw| {
                // SAFETY: on the main thread with wry's live controller.
                let shown = unsafe {
                    pw.controller().CoreWebView2().and_then(|c| c.cast::<ICoreWebView2_16>()).and_then(|c| c.ShowPrintUI(COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM))
                };
                if let Err(e) = shown {
                    log::warn!("ShowPrintUI: {e}");
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(true)
    }
    #[cfg(not(windows))]
    Ok(false)
}

/// A page can call overlay_vocab on its own, so captures are spaced at least this far apart:
/// a reader selects and clicks far slower, a script filling the book with junk is held to this.
const CAPTURE_GAP: Duration = Duration::from_secs(1);

/// Guards overlay_vocab: the caller must be a browser webview on screen, not capturing faster than `CAPTURE_GAP`.
pub fn ensure_capture_allowed(webview: &Webview, browser: &Browser) -> Result<(), String> {
    if !is_browser(webview.label()) {
        return Err("not a browser webview".into());
    }
    if !browser.with_tab(webview.label(), |t| take_capture(t, Instant::now())) {
        return Err("capture refused".into());
    }
    Ok(())
}

/// Whether the tab may capture a word at `now` (on screen, `CAPTURE_GAP` since its last one); if so, records it.
fn take_capture(t: &mut TabState, now: Instant) -> bool {
    let ok = t.visibility.wanted && !t.visibility.loading && t.captured.is_none_or(|at| now.duration_since(at) >= CAPTURE_GAP);
    if ok {
        t.captured = Some(now);
    }
    ok
}

/// Guards overlay_translate: the caller must be a browser webview with translation on.
pub fn ensure_translation_allowed(webview: &Webview, browser: &Browser) -> Result<(), String> {
    if !is_browser(webview.label()) {
        return Err("not a browser webview".into());
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
    fn labels_name_their_tab_and_nothing_else_passes() {
        assert_eq!(label("k7a").as_deref(), Ok("browser-k7a"));
        assert_eq!(tab_of("browser-k7a"), Some("k7a"));
        assert!(is_browser("browser-123"));
        assert!(!is_browser("main"), "the app UI is not a page");
        assert!(!is_browser(RENDER_LABEL));
        assert_eq!(tab_of("main"), None);
        for bad in ["", "a b", "x/y", "../main", &"a".repeat(MAX_KEY + 1)] {
            assert!(label(bad).is_err(), "{bad:?} is not a key the UI makes");
        }
    }

    #[test]
    fn snapshot_nonces_are_per_label_and_single_use() {
        let s = Snapshots::default();
        let b_label = label("1").unwrap();
        let (b, _rb) = s.begin(&b_label);
        let (r, _rr) = s.begin(RENDER_LABEL);
        assert!(s.take(&b_label, &r).is_none(), "another webview's nonce");
        assert!(s.take(RENDER_LABEL, &r).is_some());
        assert!(s.take(RENDER_LABEL, &r).is_none(), "used once");
        let (b2, _rb2) = s.begin(&b_label);
        assert!(s.take(&b_label, &b).is_none(), "superseded by a newer request");
        assert!(s.take(&b_label, &b2).is_some());
    }

    #[test]
    fn page_keys_keep_the_overlay_shape() {
        let keys: PageKeys = serde_json::from_str(r#"{"inFields":["Ctrl+K"],"outside":["J"],"prefix":["Ctrl+B"],"prefixMs":1500}"#).unwrap();
        let boot =
            serde_json::to_value(OverlayBoot { config: OverlayConfig { enabled: true, percent: 70, labels: OverlayLabels::default() }, keys: Some(keys) })
                .unwrap();
        assert_eq!(boot["enabled"], true, "config fields at the top level, as configure() takes them");
        assert_eq!(boot["keys"]["inFields"][0], "Ctrl+K");
        assert_eq!(boot["keys"]["prefixMs"], 1500);
    }

    #[test]
    fn tab_events_carry_the_tab_beside_the_body() {
        #[derive(Clone, Serialize)]
        struct Title {
            title: String,
        }
        let v = serde_json::to_value(TabEvent { tab: "k4".into(), body: Title { title: "t".into() } }).unwrap();
        assert_eq!(v, serde_json::json!({ "tab": "k4", "title": "t" }));
        assert_eq!(serde_json::to_value(TabEvent { tab: "k4".into(), body: Empty {} }).unwrap(), serde_json::json!({ "tab": "k4" }));
    }

    #[test]
    fn a_page_captures_words_only_on_screen_and_not_in_bursts() {
        let now = Instant::now();
        let mut t = TabState::default();
        assert!(!take_capture(&mut t, now), "hidden");
        t.visibility.wanted = true;
        assert!(take_capture(&mut t, now));
        assert!(!take_capture(&mut t, now + Duration::from_millis(300)), "too soon");
        assert!(take_capture(&mut t, now + CAPTURE_GAP));
        t.visibility.loading = true;
        assert!(!take_capture(&mut t, now + 3 * CAPTURE_GAP), "loading");
    }

    #[test]
    fn eviction_takes_the_longest_hidden_webviews_beyond_the_cap_and_never_a_shown_one() {
        let now = Instant::now();
        let mut tabs = HashMap::new();
        for i in 0..6u32 {
            let mut t = TabState::default();
            t.visibility.wanted = i == 0; // tab 0 is on screen
            t.parked = now.checked_sub(Duration::from_secs(i as u64)); // higher i: hidden longer
            tabs.insert(label(&i.to_string()).unwrap(), t);
        }
        let mut gone = to_evict(&tabs);
        gone.sort();
        assert_eq!(gone, vec!["browser-4", "browser-5"], "5 hidden, 3 kept: the two hidden longest go");
        tabs.remove("browser-5");
        tabs.remove("browser-4");
        assert!(to_evict(&tabs).is_empty());
        assert_eq!(TabState::default().history, (true, true), "a fresh tab assumes history both ways until the page reports");
    }
}
