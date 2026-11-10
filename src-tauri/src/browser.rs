//! In-app browser: one child webview per visible Page tab, over the content area of the window
//! whose UI shows the tab (the main window or a pop-out, G52), showing the real page and running
//! the translation overlay. Links navigate in place; pop-ups open in the same webview.
//!
//! Trust boundary: the pages are remote and untrusted. Their webviews (labels `browser-<tab>`)
//! get only the capability in `capabilities/browser.json` (overlay_config / overlay_translate /
//! overlay_snapshot / overlay_history / overlay_progress / overlay_key / overlay_vocab / overlay_ask / overlay_print), translate calls are refused
//! unless the user has switched translation on, snapshots unless the app asked for one, and word
//! captures unless the page is on screen and the last one is a moment ago. The background
//! renderer's hidden webview (`renderer.rs`) gets the same capability, never translation.

#![allow(unsafe_code, reason = "WebView2 and COM calls through the windows crate")]

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use lattice_core::url_norm::normalize;
use serde::{Deserialize, Serialize};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, State, Url, Webview, WebviewBuilder, WebviewUrl, Window};
use tokio::sync::oneshot;
use ts_rs::TS;

/// Labels of the page webviews: `browser-<tab key>`. The key (`PageTab.key` in `src/layout/layout.ts`)
/// names the tab across windows and restarts; the UI's numeric tab ids are per window.
const PREFIX: &str = "browser-";
pub const RENDER_LABEL: &str = "renderer";
pub const PDF_SCHEME: &str = "lattice-pdf";
const PDF_HOST: &str = "lattice-pdf.localhost";
pub(crate) const OVERLAY_JS: &str = include_str!("../overlay-dist/overlay.js");
/// Keys are short and alphanumeric (`newKey` in `src/layout/layout.ts`); anything else is not a tab of ours.
const MAX_KEY: usize = 32;

/// Hidden tabs keep their webview (instant switching, history and scroll kept) up to this many;
/// creating one more closes the one hidden longest, and the UI reopens it when shown again.
const MAX_PARKED: usize = 3;
/// Of a page not in the library, how many translated texts its save can give the article it becomes.
const MAX_UNOWNED: usize = 20_000;

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
    /// 混在's share of text in the display language; none for 訳文, the whole translation in whichever language.
    pub percent: Option<u8>,
    pub labels: OverlayLabels,
    /// The page is a saved article with automatic translation off: only what is saved shows, the
    /// rest waits to be asked for. Per page (`config_for`); never set in `Browser::config`.
    pub manual: bool,
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
    /// The PDF viewer's table of contents.
    outline: String,
    /// The PDF viewer's button on each page.
    translate_page: String,
    retranslate_page: String,
    /// The PDF viewer's word when it cannot open the file.
    pdf_failed: String,
    /// The find bar's name, for screen readers.
    find: String,
}

/// What the overlay reads keys with (`PageKeys` in `src/lib/keymap.ts`), passed through to the page.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PageKeys {
    /// Opaque here: the overlay's `stepKeys` reads it.
    bindings: serde_json::Value,
    /// The complete sequences a page may press in the app.
    sequences: Vec<String>,
    /// The chords' first keys, for the app's hint.
    first: Vec<String>,
}

pub struct Browser {
    /// Shared by every page webview, like the Reader's display language is shared by articles.
    pub config: Mutex<OverlayConfig>,
    /// Hosts never translated (`translate::page_skip_sites`): their pages get the config switched off.
    skip_sites: Mutex<Vec<String>>,
    keys: Mutex<Option<PageKeys>>,
    /// Per webview label.
    tabs: Mutex<HashMap<String, TabState>>,
    /// Serializes create-or-navigate so overlapping opens cannot create a webview twice.
    opening: tokio::sync::Mutex<()>,
    snapshots: Snapshots,
}

struct TabState {
    /// `browser_hide` came while there was no webview yet, so `browser_open` must not show the one it is creating.
    hidden_while_opening: bool,
    /// Where to scroll once the next page finishes loading.
    jump: Option<Jump>,
    visibility: Visibility,
    /// (can go back, can go forward) of the current page, as the overlay last reported it.
    history: (bool, bool),
    /// Since when the webview has been hidden.
    parked: Option<Instant>,
    /// The page's last word capture (overlay_vocab).
    captured: Option<Instant>,
    /// The page's last quote (overlay_ask).
    asked: Option<Instant>,
    /// The saved PDFs the app opened in this tab, which Back and Forward can return to: the only ones the tab may load (`pdf_allowed`).
    pdfs: HashSet<i64>,
    /// How many documents have begun loading, which `pushState` and in-page links do not count as.
    documents: u64,
    /// The text hashes the page at `unowned_page` asked to translate while it was in no article, for the one it is
    /// saved as (`save_page`). By URL: a page that changes its own (`pushState`) is another page, in the same document.
    unowned: HashSet<String>,
    unowned_page: String,
}

impl Default for TabState {
    fn default() -> Self {
        Self {
            hidden_while_opening: false,
            jump: None,
            visibility: Visibility::default(),
            history: (true, true),
            parked: None,
            captured: None,
            asked: None,
            pdfs: HashSet::new(),
            documents: 0,
            unowned: HashSet::new(),
            unowned_page: String::new(),
        }
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
            config: Mutex::new(OverlayConfig { enabled: false, percent: Some(70), labels: OverlayLabels::default(), manual: false }),
            skip_sites: Mutex::new(Vec::new()),
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

    /// The protocol is registered on every webview and remote pages can navigate to its URLs, so a
    /// tab gets only the PDF `browser_open` was told to show. The same-origin policy keeps its bytes
    /// from a page the user reaches from there by a link.
    pub fn pdf_allowed(&self, label: &str, id: i64) -> bool {
        is_browser(label) && lock(&self.tabs).get(label).is_some_and(|t| t.pdfs.contains(&id))
    }

    /// Changes when the webview's page is replaced, unlike its URL, which a page can change itself.
    pub fn document(&self, label: &str) -> u64 {
        self.with_tab(label, |t| t.documents)
    }

    /// Notes what the page at `page` (`page_key`), in no article, asked to translate. Bounded: the page decides how
    /// often it asks.
    pub fn note_unowned(&self, label: &str, page: &str, hashes: &[String]) {
        self.with_tab(label, |t| {
            if t.unowned_page != page {
                t.unowned.clear();
                t.unowned_page = page.to_string();
            }
            let room = MAX_UNOWNED.saturating_sub(t.unowned.len());
            t.unowned.extend(hashes.iter().take(room).cloned());
        });
    }

    /// What the page at `page` noted with `note_unowned`, once; nothing if the tab has gone on to another.
    pub fn take_unowned(&self, label: &str, page: &str) -> Vec<String> {
        self.with_tab(label, |t| {
            if t.unowned_page == page {
                t.unowned.drain().collect()
            } else {
                Vec::new()
            }
        })
    }

    /// Every page webview, by label.
    fn webviews(&self, app: &AppHandle) -> Vec<(String, Webview)> {
        app.webviews().into_iter().filter(|(l, _)| is_browser(l)).collect()
    }

    /// Whether the page now in `wv` is one the user excluded from translation.
    // shortcut: checked at page load and on a settings change, so a same-document navigation (pushState)
    // onto or off an excluded path keeps the page's state until the next load; watch overlay_history if that matters.
    fn skipped(&self, wv: &Webview) -> bool {
        wv.url().is_ok_and(|u| lattice_core::translate::page_skipped(&lock(&self.skip_sites), u.as_str()))
    }

    /// The overlay config for the page in `wv`.
    fn config_for(&self, wv: &Webview) -> OverlayConfig {
        let config = OverlayConfig { manual: page_is_manual(wv), ..lock(&self.config).clone() };
        if config.enabled && self.skipped(wv) {
            OverlayConfig { enabled: false, ..config }
        } else {
            config
        }
    }

    /// Sends every page its config again (the config, the excluded sites or an article's automatic translation changed).
    pub fn reconfigure(&self, app: &AppHandle) -> Result<(), String> {
        for (_, wv) in self.webviews(app) {
            let arg = serde_json::to_string(&self.config_for(&wv)).expect("config serializes");
            wv.eval(format!("window.__lattice&&window.__lattice.configure({arg})")).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// The article's translation job has saved more: a page showing it in manual mode asks for nothing by
    /// itself, so it is told to look. Pages translating by themselves get it as they scroll.
    pub fn show_saved(&self, app: &AppHandle, article: i64) {
        for (label, wv) in self.webviews(app) {
            if page_article(&wv) == Some(article)
                && page_is_manual(&wv)
                && let Err(e) = wv.eval("window.__lattice&&window.__lattice.showSavedIdle()")
            {
                log::warn!("telling {label} of saved translations: {e}");
            }
        }
    }

    /// New excluded sites: pages on them stop translating, pages no longer on them start.
    pub fn set_skip_sites(&self, app: &AppHandle, sites: Vec<String>) -> Result<(), String> {
        *lock(&self.skip_sites) = sites;
        self.reconfigure(app)
    }

    /// Closes hidden webviews beyond MAX_PARKED, oldest first.
    fn evict(&self, app: &AppHandle) {
        self.evict_with(|label| {
            if let Some(wv) = app.get_webview(label)
                && let Err(e) = wv.close()
            {
                log::warn!("closing the webview {label}: {e}");
            }
        });
    }

    fn evict_with(&self, mut close: impl FnMut(&str)) {
        // Bound first: a guard in the `for` expression lives through the loop, so `close` ran under
        // the tab lock and the `remove` below took it again, and the app froze at the first eviction.
        let gone = to_evict(&lock(&self.tabs));
        for label in gone {
            close(&label);
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

/// The article a saved PDF's URL names: `http://lattice-pdf.localhost/<id>`, as WebView2 addresses the scheme.
/// The page in `wv`, for `note_unowned`: its URL without the fragment, which in-page links change.
pub fn page_key(wv: &Webview) -> Option<String> {
    let mut url = wv.url().ok()?;
    url.set_fragment(None);
    Some(url.into())
}

pub fn pdf_article(u: &Url) -> Option<i64> {
    (u.scheme() == "http" && u.host_str() == Some(PDF_HOST)).then(|| pdf_path(u.path()))?
}

/// The saved article the page in `wv` is.
pub fn page_article(wv: &Webview) -> Option<i64> {
    let (app, url) = (wv.app_handle().try_state::<crate::App>()?, wv.url().ok()?);
    pdf_article(&url).or_else(|| app.store.find_article_by_url(normalize(url.as_str()).ok()?.as_str()).ok()?)
}

/// Whether the page in `wv` is a saved article with automatic translation off.
fn page_is_manual(wv: &Webview) -> bool {
    let Some(app) = wv.app_handle().try_state::<crate::App>() else {
        return false;
    };
    page_article(wv).and_then(|id| app.store.article_row(id).ok()?).is_some_and(|a| a.translate_manual)
}

/// The protocol's handler sees that URL rewritten to `lattice-pdf://localhost/<id>`; the path is the same.
pub fn pdf_path(path: &str) -> Option<i64> {
    path.strip_prefix('/')?.parse().ok()
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
    let (tx, rx) = oneshot::channel();
    let (moving, to) = (wv.clone(), window.clone());
    // On the main thread: off it, `reparent` holds the webview's lock until the main thread has
    // moved it, and the window already counts as the webview's, so a `browser_set_bounds` for it
    // run there meanwhile waited on that lock and the app froze.
    app.run_on_main_thread(move || {
        let moved = moving.reparent(&to).map_err(|e| e.to_string());
        #[cfg(windows)]
        if moved.is_ok() {
            settle(&moving);
        }
        let _ = tx.send(moved);
    })
    .map_err(|e| e.to_string())?;
    match rx.await.unwrap_or_else(|_| Err("the main thread dropped the move".into())) {
        Ok(()) => Ok(()),
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
#[allow(clippy::too_many_arguments, reason = "Tauri's injected state, then the call's own arguments")]
pub async fn browser_open(
    app: AppHandle,
    browser: State<'_, Browser>,
    webview: Webview,
    tab: String,
    url: String,
    bounds: Bounds,
    focus_text: Option<String>,
    place: Option<Place>,
) -> Result<(), String> {
    let url = http_url(&url)?;
    let label = label(&tab)?;
    let window = webview.window();
    let _opening = browser.opening.lock().await;
    if let Some(id) = pdf_article(&url) {
        browser.with_tab(&label, |t| t.pdfs.insert(id));
    }
    let focus_text = focus_text.filter(|t| !t.trim().is_empty());
    // A search result is worth loading the page again for; a place only matters to a page that loads anyway.
    let searching = focus_text.is_some();
    let jump = focus_text.map(Jump::Text).or_else(|| place.and_then(Place::checked).map(Jump::Place));
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
        if !searching && !loading && (moved || wv.url().is_ok_and(|u| u == url)) {
            update_visibility(&wv, &browser, |v| *v = Visibility { loading: false, ..opened }).map_err(|e| e.to_string())?;
            emit_page(&wv, &browser, url.to_string());
            return Ok(());
        }
        browser.with_tab(&label, |t| t.jump = jump);
        update_visibility(&wv, &browser, |v| *v = opened).map_err(|e| e.to_string())?;
        return wv.navigate(url).map_err(|e| e.to_string());
    }
    browser.with_tab(&label, |t| {
        t.jump = jump;
        t.hidden_while_opening = false;
    });
    browser.evict(&app);
    let (popup_target, popup_label) = (app.clone(), label.clone());
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(url))
        .initialization_script(OVERLAY_JS)
        // Never leave the web: no file:, custom schemes or app-internal URLs in this webview.
        .on_navigation(is_http)
        // A middle-click, Ctrl+click or target=_blank link opens a Page tab next to this one (the UI holds the tabs).
        .on_new_window(move |u, _| {
            // Not a saved PDF: the UI would open it for the page that asked.
            if is_http(&u)
                && pdf_article(&u).is_none()
                && let Some(wv) = popup_target.get_webview(&popup_label)
            {
                #[derive(Clone, Serialize)]
                struct NewTab {
                    url: String,
                }
                emit_tab(&wv, "browser-new-tab", NewTab { url: u.to_string() });
            }
            NewWindowResponse::Deny
        })
        .on_page_load(|wv, p| {
            let loading = matches!(p.event(), PageLoadEvent::Started);
            let browser = wv.app_handle().state::<Browser>();
            if loading {
                browser.with_tab(wv.label(), |t| {
                    t.history = (true, true); // until the new page's overlay reports
                    t.documents += 1;
                    t.unowned.clear();
                });
            }
            // Every navigation, in-page links and back/forward too, keeps the page off-screen until it has loaded.
            let _ = update_visibility(&wv, &browser, |v| v.loading = loading);
            emit_page(&wv, &browser, p.url().to_string());
            if !loading && let Some(jump) = browser.with_tab(wv.label(), |t| t.jump.take()) {
                let args = match jump {
                    Jump::Text(text) => serde_json::to_string(&text),
                    Jump::Place(p) => serde_json::to_string(&p.text).map(|text| format!("{text},{}", p.at)),
                }
                .expect("string serializes");
                let _ = wv.eval(format!("window.__lattice&&window.__lattice.scrollToText({args})"));
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
    let wanted = !browser.with_tab(&label, |t| t.hidden_while_opening);
    update_visibility(&wv, &browser, |v| *v = Visibility { wanted, ..opened }).map_err(|e| e.to_string())
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
    let label = label(&tab)?;
    match app.get_webview(&label) {
        Some(wv) => update_visibility(&wv, &browser, |v| v.wanted = false).map_err(|e| e.to_string()),
        // Creating a webview pumps the main thread, so this can run in the middle of `browser_open`, which
        // would then show the page over whatever the user has switched to.
        None => {
            if let Some(t) = lock(&browser.tabs).get_mut(&label) {
                t.hidden_while_opening = true;
            }
            Ok(())
        }
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

/// Whether webview `label` is a page whose tab is not one of `keep`.
fn is_stray(label: &str, keep: &[String]) -> bool {
    tab_of(label).is_some_and(|tab| !keep.iter().any(|k| k == tab))
}

/// The calling window's UI has started with the page tabs `keep`. Another page webview in this window
/// is left from before a reload whose layout no longer has its tab, and would stay drawn over the
/// documents with no tab to close it. A tab coming here from another window is not affected: its
/// webview stays in the window it left until this one opens it (`attach`).
#[tauri::command]
pub async fn browser_retain(browser: State<'_, Browser>, webview: Webview, keep: Vec<String>) -> Result<(), String> {
    let _opening = browser.opening.lock().await;
    for wv in webview.window().webviews().into_iter().filter(|wv| is_stray(wv.label(), &keep)) {
        log::info!("closing {}: its window's tabs no longer include it", wv.label());
        lock(&browser.tabs).remove(wv.label());
        if let Err(e) = wv.close() {
            log::warn!("closing {}: {e}", wv.label());
        }
    }
    Ok(())
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
    wv.with_webview(move |pw| {
        // SAFETY: a plain Win32 call; the stream is an owned COM reference.
        let Some(stream) = (unsafe { SHCreateMemStream(None) }) else {
            return;
        };
        let out = stream.clone();
        // Fires later on this (main) thread; if CapturePreview fails, dropping it closes the channel.
        let done = CapturePreviewCompletedHandler::create(Box::new(move |hr| {
            // SAFETY: completion handlers run on the STA thread that created the stream, once WebView2 has finished writing it.
            let _ = tx.send(hr.and_then(|()| unsafe { read_stream(&out) }));
            Ok(())
        }));
        // SAFETY: on the main thread with wry's live controller; WebView2 keeps the stream and handler until the capture completes.
        let started =
            unsafe { pw.controller().CoreWebView2().and_then(|core| core.CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, &stream, &done)) };
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

/// Where a saved article was being read in its page: the block on the overlay's reading line, by the start of its text,
/// and how far down that block the line was.
#[derive(Clone, Serialize, Deserialize)]
pub struct Place {
    text: String,
    at: f64,
}

impl Place {
    /// Pages send these, so a page's own value is taken only within reason. `at` reaches the page as script source.
    fn checked(self) -> Option<Self> {
        let ok = !self.text.trim().is_empty() && self.text.chars().count() <= 80 && self.at.is_finite();
        ok.then(|| Self { at: self.at.clamp(-10.0, 10.0), ..self })
    }
}

/// Where to scroll once a page has loaded.
enum Jump {
    /// A search result's or citation's passage: centred and flashed.
    Text(String),
    /// Where the reader left the article.
    Place(Place),
}

#[derive(Clone, Serialize)]
struct PlaceReport {
    place: Option<Place>,
}

/// Called by the overlay as the page comes to rest: the place being read, which the UI keeps for the tab's saved
/// article, or none at the page's top. Exposed to remote pages; a page can only move where its own article opens.
#[tauri::command]
pub fn overlay_place(webview: Webview, place: Option<Place>) -> Result<(), String> {
    if !is_browser(webview.label()) {
        return Err("not a browser webview".into());
    }
    // A place out of reason is dropped, not taken for the top.
    let Ok(place) = place.map(|p| p.checked().ok_or(())).transpose() else {
        return Ok(());
    };
    emit_tab(&webview, "browser-place", PlaceReport { place });
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

/// Runs a document action in the tab's page (`docNav.run` in the overlay): for the palette, and for
/// the second key of a chord, which reaches the app once its hint has taken the keyboard. App only:
/// no page gets this, and a page only ever runs these actions on itself.
#[tauri::command]
pub async fn browser_run_doc(app: AppHandle, key: String, action: String, count: u32) -> Result<(), String> {
    let Some(wv) = app.get_webview(&label(&key)?) else {
        return Ok(());
    };
    let arg = serde_json::to_string(&action).expect("string serializes");
    wv.eval(format!("window.__lattice&&window.__lattice.runDoc({arg},{count})")).map_err(|e| e.to_string())
}

/// Opens the repeat window of a chord beginning with `first` in the tab's page: the app read that chord's
/// second key under its hint, but the page takes the keyboard back as the hint goes, so the next key lands
/// there. App only: all it sets is the page's own key state.
#[tauri::command]
pub async fn browser_repeat_keys(app: AppHandle, key: String, first: String) -> Result<(), String> {
    let Some(wv) = app.get_webview(&label(&key)?) else {
        return Ok(());
    };
    let arg = serde_json::to_string(&first).expect("string serializes");
    wv.eval(format!("window.__lattice&&window.__lattice.repeatKeys({arg})")).map_err(|e| e.to_string())
}

/// The keyboard goes to the tab's page, so its keys work right after a move into its pane.
#[tauri::command]
pub async fn browser_focus(app: AppHandle, tab: String) -> Result<(), String> {
    match app.get_webview(&label(&tab)?) {
        Some(wv) => wv.set_focus().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

#[tauri::command]
pub async fn browser_set_translation(
    app: AppHandle,
    browser: State<'_, Browser>,
    enabled: bool,
    percent: Option<u8>,
    labels: OverlayLabels,
) -> Result<(), String> {
    *lock(&browser.config) = OverlayConfig { enabled, percent: percent.map(|p| p.min(100)), labels, manual: false };
    browser.reconfigure(&app)
}

#[derive(Serialize)]
pub struct OverlayBoot {
    #[serde(flatten)]
    config: OverlayConfig,
    keys: Option<PageKeys>,
}

/// Called by the overlay on every page load. Exposed to remote pages (read-only).
/// Only the visible browsers translate and forward shortcuts; the renderer's page stays as served.
#[tauri::command(async)]
pub fn overlay_config(browser: State<'_, Browser>, webview: Webview) -> OverlayBoot {
    if is_browser(webview.label()) {
        OverlayBoot { config: browser.config_for(&webview), keys: lock(&browser.keys).clone() }
    } else {
        OverlayBoot { config: OverlayConfig { enabled: false, ..lock(&browser.config).clone() }, keys: None }
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

/// Called by the overlay with an app shortcut pressed while the page has focus: a whole sequence
/// and its count, a chord's first key, or nothing to end the app's hint. Exposed to remote pages, so
/// a page can press the app's shortcuts itself; it can do no more than the user's keys can, and only
/// while it is on screen.
#[tauri::command]
pub fn overlay_key(browser: State<'_, Browser>, webview: Webview, key: String, count: u32) -> Result<(), String> {
    if !is_browser(webview.label()) {
        return Err("not a browser webview".into());
    }
    let keys = lock(&browser.keys).clone();
    if !browser.with_tab(webview.label(), |t| take_key(t, keys.as_ref(), &key)) {
        return Err("key refused".into());
    }
    #[derive(Clone, Serialize)]
    struct Key {
        key: String,
        count: u32,
    }
    emit_tab(&webview, "browser-key", Key { key, count });
    Ok(())
}

/// Whether the tab may forward `key`: on screen, and `key` empty or one the overlay was told it can
/// send. The overlay's `stepKeys` holds the sequence; nothing here does.
fn take_key(t: &TabState, keys: Option<&PageKeys>, key: &str) -> bool {
    let Some(k) = keys else {
        return false;
    };
    let listed = key.is_empty() || k.sequences.iter().chain(&k.first).any(|s| s == key);
    t.visibility.wanted && !t.visibility.loading && key.len() <= 64 && listed
}

/// A page can call overlay_ask on its own, so a quote is bounded (the overlay cuts it at 4000 characters).
const MAX_QUOTE_BYTES: usize = 16 * 1024;
/// And quotes are spaced at least this far apart: a reader selects text for each, while a script's loop
/// would keep opening the chat, taking the keyboard and growing the draft.
const QUOTE_GAP: Duration = Duration::from_secs(1);

/// Called by the overlay for `a` in visual mode: the selection goes into the chat's input. Exposed to
/// remote pages, so the quote is untrusted: it is only ever text in that input, and only the user can
/// send it. Only while the page is on screen.
#[tauri::command]
pub fn overlay_ask(browser: State<'_, Browser>, webview: Webview, quote: String) -> Result<(), String> {
    if !is_browser(webview.label()) {
        return Err("not a browser webview".into());
    }
    if !browser.with_tab(webview.label(), |t| take_quote(t, &quote, Instant::now())) {
        return Err("quote refused".into());
    }
    #[derive(Clone, Serialize)]
    struct Quote {
        quote: String,
    }
    emit_tab(&webview, "browser-ask", Quote { quote });
    Ok(())
}

/// Whether the tab may quote at `now` (on screen, within the bound, `QUOTE_GAP` since its last one); if so, records it.
fn take_quote(t: &mut TabState, quote: &str, now: Instant) -> bool {
    let ok = t.visibility.wanted && !t.visibility.loading && quote.len() <= MAX_QUOTE_BYTES && t.asked.is_none_or(|at| now.duration_since(at) >= QUOTE_GAP);
    if ok {
        t.asked = Some(now);
    }
    ok
}

/// Called by the overlay for its print key and `window.print()`. WebView2's own print preview is drawn
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

/// Guards overlay_translate: the caller must be a browser webview with translation on, not on an excluded site.
pub fn ensure_translation_allowed(webview: &Webview, browser: &Browser) -> Result<(), String> {
    if !is_browser(webview.label()) {
        return Err("not a browser webview".into());
    }
    // The guard is dropped before skipped() waits on the main thread, where overlay_config takes the same lock.
    let enabled = lock(&browser.config).enabled;
    if !enabled || browser.skipped(webview) {
        return Err("translation is off".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_reports_a_place_only_within_reason() {
        let place = |text: &str, at: f64| Place { text: text.into(), at }.checked().map(|p| (p.text, p.at));
        assert_eq!(place("A paragraph", 0.25), Some(("A paragraph".into(), 0.25)));
        assert_eq!(place("A paragraph", -40.0), Some(("A paragraph".into(), -10.0)), "far below the line: about there");
        for (text, at) in [("A paragraph", f64::NAN), ("A paragraph", f64::INFINITY), ("  ", 0.5)] {
            assert_eq!(place(text, at), None, "{text:?} at {at} would not reach the page as a number");
        }
        assert_eq!(place(&"あ".repeat(81), 0.0), None, "longer than any block's start");
        assert!(place(&"あ".repeat(80), 0.0).is_some());
    }

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
    fn a_tab_loads_only_the_saved_pdfs_it_was_opened_on() {
        let article = |s: &str| pdf_article(&Url::parse(s).unwrap());
        assert_eq!(article("http://lattice-pdf.localhost/5"), Some(5));
        assert_eq!(article("https://lattice-pdf.localhost/5"), None);
        assert_eq!(article("http://example.com/5"), None);
        assert_eq!(article("http://lattice-pdf.localhost/5/x"), None);
        let browser = Browser::default();
        let tab = label("k1").unwrap();
        assert!(!browser.pdf_allowed(&tab, 5), "never opened");
        browser.with_tab(&tab, |t| t.pdfs.insert(5));
        assert!(browser.pdf_allowed(&tab, 5));
        assert!(!browser.pdf_allowed(&tab, 6), "another article");
        browser.with_tab(&tab, |t| t.pdfs.insert(6));
        assert!(browser.pdf_allowed(&tab, 5), "Back to the earlier one still works");
        assert!(!browser.pdf_allowed(&label("k2").unwrap(), 5), "another tab");
        assert!(!browser.pdf_allowed("main", 5), "only page webviews");
    }

    #[test]
    fn a_page_hands_what_it_translated_to_its_save_once_and_within_bounds() {
        let browser = Browser::default();
        let hashes: Vec<String> = (0..MAX_UNOWNED + 5).map(|i| i.to_string()).collect();
        let (page, route) = ("https://docs.dev/a", "https://docs.dev/b");
        browser.note_unowned("browser-a", page, &hashes[..2]);
        browser.note_unowned("browser-a", page, &hashes[..3]);
        assert!(browser.take_unowned("browser-a", route).is_empty(), "the tab has gone on to another page");
        let mut taken = browser.take_unowned("browser-a", page);
        taken.sort();
        assert_eq!(taken, ["0", "1", "2"]);
        assert!(browser.take_unowned("browser-a", page).is_empty(), "once");
        browser.note_unowned("browser-a", page, &hashes[..1]);
        browser.note_unowned("browser-a", route, &hashes[1..2]);
        assert_eq!(browser.take_unowned("browser-a", route), ["1"], "a route pushState opened is another page");
        browser.note_unowned("browser-b", page, &hashes);
        assert_eq!(browser.take_unowned("browser-b", page).len(), MAX_UNOWNED);
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
        let keys: PageKeys = serde_json::from_str(r#"{"bindings":{"palette":["Ctrl+P"]},"sequences":["Ctrl+P"],"first":["Ctrl+B"]}"#).unwrap();
        let boot = serde_json::to_value(OverlayBoot {
            config: OverlayConfig { enabled: true, percent: Some(70), labels: OverlayLabels::default(), manual: false },
            keys: Some(keys),
        })
        .unwrap();
        assert_eq!(boot["enabled"], true, "config fields at the top level, as configure() takes them");
        assert_eq!(boot["keys"]["bindings"]["palette"][0], "Ctrl+P", "the bindings pass through as they came");
        assert_eq!(boot["keys"]["sequences"][0], "Ctrl+P");
        assert_eq!(boot["keys"]["first"][0], "Ctrl+B");
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
    fn a_page_forwards_only_the_keys_it_was_given() {
        let keys = PageKeys { bindings: serde_json::Value::Null, sequences: vec!["Ctrl+P".into(), "Ctrl+B X".into()], first: vec!["Ctrl+B".into()] };
        let mut t = TabState::default();
        assert!(!take_key(&t, Some(&keys), "Ctrl+P"), "hidden");
        t.visibility.wanted = true;
        assert!(!take_key(&t, None, "Ctrl+P"), "no keys yet");
        assert!(take_key(&t, Some(&keys), "Ctrl+P"));
        assert!(take_key(&t, Some(&keys), "Ctrl+B"), "a first key, for the hint");
        assert!(take_key(&t, Some(&keys), "Ctrl+B X"), "a whole sequence");
        assert!(take_key(&t, Some(&keys), ""), "ending the hint");
        assert!(!take_key(&t, Some(&keys), "Ctrl+Q"), "not a shortcut");
        assert!(!take_key(&t, Some(&keys), "Ctrl+B Q"), "a sequence the app does not have");
        assert!(!take_key(&t, Some(&keys), "X"), "a second key alone");
        let long = "Ctrl+B ".repeat(10);
        let keys = PageKeys { sequences: vec![long.clone()], ..keys };
        assert!(!take_key(&t, Some(&keys), &long), "too long");
        t.visibility.loading = true;
        assert!(!take_key(&t, Some(&keys), "Ctrl+B"), "loading");
    }

    #[test]
    fn a_page_quotes_only_on_screen_and_within_the_bound() {
        let now = Instant::now();
        let mut t = TabState::default();
        assert!(!take_quote(&mut t, "q", now), "hidden");
        t.visibility.wanted = true;
        assert!(!take_quote(&mut t, &"q".repeat(MAX_QUOTE_BYTES + 1), now), "too long");
        assert!(take_quote(&mut t, "q", now), "a refused quote starts no gap");
        t.visibility.loading = true;
        assert!(!take_quote(&mut t, "q", now + 3 * QUOTE_GAP), "loading");
    }

    #[test]
    fn a_page_cannot_quote_in_a_loop() {
        let now = Instant::now();
        let mut t = TabState::default();
        t.visibility.wanted = true;
        assert!(take_quote(&mut t, "q", now));
        assert!(!take_quote(&mut t, "q", now + Duration::from_millis(300)), "too soon");
        assert!(!take_quote(&mut t, "q", now + Duration::from_millis(999)), "a refusal does not move the gap, and it has not passed");
        assert!(take_quote(&mut t, "q", now + QUOTE_GAP));
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

    #[test]
    fn eviction_holds_no_tab_lock_while_a_webview_closes() {
        let browser = Browser::default();
        for i in 0..5u32 {
            browser.with_tab(&label(&i.to_string()).unwrap(), |t| t.parked = Instant::now().checked_sub(Duration::from_secs(i as u64)));
        }
        let mut closed = Vec::new();
        browser.evict_with(|label| {
            assert!(browser.tabs.try_lock().is_ok(), "closing {label} with the tab lock held: close may wait on the main thread, which wants it");
            closed.push(label.to_string());
        });
        assert_eq!(closed, vec!["browser-3", "browser-4"]);
        assert_eq!(lock(&browser.tabs).len(), 3);
    }

    #[test]
    fn a_starting_window_drops_only_the_pages_of_tabs_it_does_not_have() {
        let keep = ["k1".to_string(), "k2".to_string()];
        assert!(is_stray("browser-k3", &keep));
        assert!(!is_stray("browser-k1", &keep));
        assert!(is_stray("browser-k1", &[]), "a window with no Page tabs keeps no page");
        assert!(!is_stray("browser-k10", &["k10".into()]));
        assert!(is_stray("browser-k1", &["k10".into()]), "keys match whole, not by prefix");
        for ui in ["main", "doc-1", "chat", RENDER_LABEL] {
            assert!(!is_stray(ui, &[]), "{ui} is not a page webview");
        }
    }
}
