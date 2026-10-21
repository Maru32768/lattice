//! Live tab dragging between windows (design-review §26), the way Chrome does it: a tab pulled
//! `DETACH` px off its strip comes out at once in a window that follows the cursor; over another
//! window's strip that window goes away and the strip shows the tab at the slot under the cursor;
//! off the strip again the window comes back. A document window dragging its only tab is itself
//! the window that follows.
//!
//! The backend runs the drag. Once the cursor leaves the window that was pressed, its pointer
//! events cannot be relied on (the tab element holding the pointer capture is gone after a tear,
//! and the new window takes the activation), so a thread polls the cursor, the primary button
//! and Escape until the button comes up. The windows report their strips; this module decides,
//! and tells each window what to draw (`tab-drag-over`), the source to tear the tab off
//! (`tab-drag-tear`), and the window holding the tab where it goes when the drag ends
//! (`tab-drag-drop`). Page webviews move only then, so passing over strips never reloads a page.
//!
//! In a window split into panes the tab can also go onto a pane's body, as in VS Code: its center
//! moves the tab into that pane, its edges split the pane that way (`Zone`).

use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, Webview};

use crate::browser::lock;
use crate::location::Location;
use crate::{err, popout};

const TICK: Duration = Duration::from_millis(8);
/// How far (CSS px) above or below its strip a tab can go and stay in it; Chrome lets go at about this.
const DETACH: f64 = 30.0;
/// Where the first tab's center sits in a fresh document window, in logical pixels: the title bar
/// (32) plus half the strip, and half a tab from the left edge.
const TAB_GRAB: (f64, f64) = (56.0, 51.0);
/// How far into a pane's body, as a fraction of its width or height, an edge reaches.
const EDGE: f64 = 0.25;

/// A point in physical screen pixels.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct Point {
    x: f64,
    y: f64,
}

/// One pane's tab strip in the CSS pixels of its window; `mids` are its tabs' horizontal centers,
/// `body` the rest of the pane below the strip.
#[derive(Debug, Clone, Deserialize)]
struct Strip {
    pane: u64,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    mids: Vec<f64>,
    body: Rect,
}

/// A rectangle in the CSS pixels of a window.
#[derive(Debug, Clone, Copy, Deserialize)]
struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl Rect {
    /// Where `c` falls on this pane body: the nearest edge when it is within `EDGE` of one, else the center.
    fn zone(&self, c: Point) -> Option<Zone> {
        let (fx, fy) = ((c.x - self.x) / self.width, (c.y - self.y) / self.height);
        // Also false for NaN: a body of no size has no zones.
        if !((0.0..1.0).contains(&fx) && (0.0..1.0).contains(&fy)) {
            return None;
        }
        let edges = [(fx, Zone::Left), (1.0 - fx, Zone::Right), (fy, Zone::Top), (1.0 - fy, Zone::Bottom)];
        let (d, z) = edges.into_iter().min_by(|a, b| a.0.total_cmp(&b.0))?;
        Some(if d < EDGE { z } else { Zone::Center })
    }
}

/// A part of a pane's body: the center takes the tab, an edge splits the pane on that side.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Zone {
    Center,
    Left,
    Right,
    Top,
    Bottom,
}

/// Where in a pane the tab goes: before its `index`-th tab, or onto its body.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum At {
    Index(usize),
    Zone(Zone),
}

/// A window's client area in physical pixels, its scale, and its strips (`measure` in `src/tabDrag.ts`).
#[derive(Debug, Clone, Deserialize)]
pub struct Geom {
    #[serde(default)]
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale: f64,
    strips: Vec<Strip>,
}

impl Geom {
    fn contains(&self, p: Point) -> bool {
        p.x >= self.x && p.y >= self.y && p.x < self.x + self.width && p.y < self.y + self.height
    }

    fn client(&self, p: Point) -> Point {
        Point { x: (p.x - self.x) / self.scale, y: (p.y - self.y) / self.scale }
    }
}

/// A place in pane `pane` of window `label`: `{index}` in its strip or `{zone}` on its body.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Slot {
    label: String,
    pane: u64,
    #[serde(flatten)]
    at: At,
}

fn index_at(mids: &[f64], x: f64) -> usize {
    mids.iter().filter(|m| **m < x).count()
}

/// The slot under `p`, if any. The first window that contains `p` decides: the source is `wins[0]`
/// (it is the active window, so on top), the rest in report order; `skip` is the window following
/// the cursor. Off every strip, the tab stays in the strip it is `attached` to while it is within
/// `DETACH` above or below it.
fn slot_at(p: Point, wins: &[Geom], skip: Option<&str>, attached: Option<&Slot>) -> Option<Slot> {
    let wins = || wins.iter().filter(|w| Some(w.label.as_str()) != skip);
    if let Some(w) = wins().find(|w| w.contains(p)) {
        let c = w.client(p);
        if let Some(s) = w.strips.iter().find(|s| c.x >= s.x && c.y >= s.y && c.x < s.x + s.width && c.y < s.y + s.height) {
            return Some(Slot { label: w.label.clone(), pane: s.pane, at: At::Index(index_at(&s.mids, c.x)) });
        }
    }
    let a = attached?;
    let w = wins().find(|w| w.label == a.label)?;
    let s = w.strips.iter().find(|s| s.pane == a.pane)?;
    let c = w.client(p);
    let near = c.x >= s.x && c.x < s.x + s.width && c.y >= s.y - DETACH && c.y < s.y + s.height + DETACH;
    near.then(|| Slot { label: a.label.clone(), pane: a.pane, at: At::Index(index_at(&s.mids, c.x)) })
}

/// What a pane draws at its slot: in its strip a marker in the window that has the tab, the tab
/// itself elsewhere; on its body the zone's overlay.
#[derive(Debug, Clone, PartialEq, Serialize)]
struct Over {
    pane: u64,
    #[serde(flatten)]
    at: At,
    #[serde(skip_serializing_if = "Option::is_none")]
    tab: Option<Value>,
}

/// The window following the cursor: the new window of a torn-off tab, or the source itself when
/// that tab was its only one. `grab` is the cursor's offset from the window's origin.
#[derive(Debug)]
struct Float {
    label: String,
    grab: (f64, f64),
    /// Its UI has mounted (it holds the tab and can be shown).
    ready: bool,
    shown: bool,
    at: Option<PhysicalPosition<i32>>,
}

/// Where the tab ends up: a slot, where its window is now, or (Escape on a window that
/// followed the cursor) back where that window was.
#[derive(Debug, Clone, PartialEq)]
enum Final {
    To(Slot),
    Stay,
    Home(PhysicalPosition<i32>),
}

#[derive(Debug, PartialEq)]
enum Effect {
    Over(String, Option<Over>),
    Tear(String),
    Drop(String, Slot),
    /// To every window: the drag is over (markers, the tab drawn at a slot, the ghost go).
    End,
    Move(String, PhysicalPosition<i32>),
    Show(String),
    Hide(String),
    Focus(String),
}

struct Session {
    id: u64,
    source: String,
    /// The dragged tab's title, domain and feed, for the strips that draw it.
    tab: Value,
    /// Where the tab was in the source, for Escape.
    origin: Slot,
    /// Where the source window was, when it is the one that follows the cursor.
    home: Option<PhysicalPosition<i32>>,
    wins: Vec<Geom>,
    float: Option<Float>,
    /// The source was asked to tear the tab off (it then has the tab no more).
    torn: bool,
    over: Option<Slot>,
    last: Point,
    ended: bool,
    /// The end, until a window that holds the tab can act on it (a torn-off window that has loaded).
    pending: Option<Final>,
}

impl Session {
    fn new(id: u64, source: Geom, tab: Value, origin: (u64, usize), at: Point, alone: Option<PhysicalPosition<i32>>) -> Self {
        let label = source.label.clone();
        let float = alone.map(|o| Float { label: label.clone(), grab: (at.x - o.x as f64, at.y - o.y as f64), ready: true, shown: true, at: Some(o) });
        let origin = Slot { label: label.clone(), pane: origin.0, at: At::Index(origin.1) };
        Session { id, source: label, tab, origin, home: alone, wins: vec![source], float, torn: false, over: None, last: at, ended: false, pending: None }
    }

    /// The window that has the tab and can act on it: the source until the tab is torn off, then
    /// the window it went to once that has loaded.
    fn holder(&self) -> Option<String> {
        match &self.float {
            Some(f) => f.ready.then(|| f.label.clone()),
            None => (!self.torn).then(|| self.source.clone()),
        }
    }

    fn holds(&self, label: &str) -> bool {
        match &self.float {
            Some(f) => f.label == label,
            None => !self.torn && self.source == label,
        }
    }

    fn strips(&mut self, g: Geom) {
        match self.wins.iter_mut().find(|w| w.label == g.label) {
            Some(w) => *w = g,
            None => self.wins.push(g),
        }
    }

    fn step(&mut self, p: Point) -> Vec<Effect> {
        if self.ended {
            return vec![];
        }
        self.last = p;
        let skip = self.float.as_ref().map(|f| f.label.clone());
        let attached = self.over.as_ref().filter(|o| matches!(o.at, At::Index(_)));
        let at = slot_at(p, &self.wins, skip.as_deref(), attached).or_else(|| self.body_at(p));
        let mut fx = vec![];
        if at != self.over {
            if let Some(o) = &self.over
                && at.as_ref().is_none_or(|a| a.label != o.label)
            {
                fx.push(Effect::Over(o.label.clone(), None));
            }
            if let Some(a) = &at {
                let tab = (!self.holds(&a.label)).then(|| self.tab.clone());
                fx.push(Effect::Over(a.label.clone(), Some(Over { pane: a.pane, at: a.at, tab })));
            }
            self.over = at;
        }
        if self.over.is_some() {
            if let Some(f) = self.float.as_mut().filter(|f| f.shown) {
                f.shown = false;
                fx.push(Effect::Hide(f.label.clone()));
            }
        } else if self.float.is_some() {
            fx.extend(self.follow());
        } else if !self.torn && !self.between_panes(p) {
            self.torn = true;
            fx.push(Effect::Tear(self.source.clone()));
        }
        fx
    }

    /// In a source split into panes, the way from one pane's strip to another's crosses the panes:
    /// there the tab comes out only when the cursor leaves the window.
    fn between_panes(&self, p: Point) -> bool {
        let source = &self.wins[0];
        source.strips.len() > 1 && source.contains(p)
    }

    /// The pane body under `p` while the tab is still in a source split into panes. The center of
    /// the tab's own pane is where it already is.
    fn body_at(&self, p: Point) -> Option<Slot> {
        if self.torn || !self.between_panes(p) {
            return None;
        }
        let w = &self.wins[0];
        let c = w.client(p);
        let (pane, zone) = w.strips.iter().find_map(|s| Some((s.pane, s.body.zone(c)?)))?;
        (pane != self.origin.pane || zone != Zone::Center).then(|| Slot { label: w.label.clone(), pane, at: At::Zone(zone) })
    }

    /// The following window goes to the cursor, and shows once it has loaded.
    fn follow(&mut self) -> Vec<Effect> {
        let p = self.last;
        let Some(f) = self.float.as_mut() else { return vec![] };
        let mut fx = vec![];
        let to = PhysicalPosition::new((p.x - f.grab.0).round() as i32, (p.y - f.grab.1).round() as i32);
        if f.at != Some(to) {
            f.at = Some(to);
            fx.push(Effect::Move(f.label.clone(), to));
        }
        if f.ready && !f.shown {
            f.shown = true;
            fx.push(Effect::Show(f.label.clone()));
        }
        fx
    }

    /// The button came up; with `cancel` (Escape) the tab goes back where it started.
    fn release(&mut self, cancel: bool) -> Vec<Effect> {
        if self.ended {
            return vec![];
        }
        self.ended = true;
        self.pending = Some(match (cancel, self.home) {
            (true, Some(home)) => Final::Home(home),
            (true, None) => Final::To(self.origin.clone()),
            (false, _) => self.over.clone().map_or(Final::Stay, Final::To),
        });
        // Before `End`, which ends the source's own record of which tab it is dragging.
        let mut fx = self.deliver();
        fx.push(Effect::End);
        fx
    }

    fn deliver(&mut self) -> Vec<Effect> {
        let Some(h) = self.holder() else { return vec![] };
        let Some(end) = self.pending.take() else { return vec![] };
        let mut fx = match end {
            Final::To(s) => return vec![Effect::Drop(h, s)],
            // Never torn off, and off every strip: nothing moves.
            Final::Stay if self.float.is_none() => return vec![],
            Final::Stay => self.follow(),
            Final::Home(home) => {
                let f = self.float.as_mut().expect("only a following source has a home");
                f.at = Some(home);
                let mut fx = vec![Effect::Move(h.clone(), home)];
                if !f.shown {
                    f.shown = true;
                    fx.push(Effect::Show(h.clone()));
                }
                fx
            }
        };
        fx.push(Effect::Focus(h));
        fx
    }

    /// Window `label` has mounted its UI: None unless it is this drag's following window, which
    /// then shows only while it is off every strip.
    fn ready(&mut self, label: &str) -> Option<Vec<Effect>> {
        if !self.follows(label) {
            return None;
        }
        let f = self.float.as_mut()?;
        if f.ready {
            return Some(vec![]);
        }
        f.ready = true;
        let mut fx = if !self.ended && self.over.is_none() { self.follow() } else { vec![] };
        fx.extend(self.deliver());
        Some(fx)
    }

    /// Window `label` follows the cursor in this drag, or holds the tab until the drag's end reaches
    /// it. Once that is done the label is free: a later window of the same name is not this drag's.
    fn follows(&self, label: &str) -> bool {
        !(self.ended && self.pending.is_none()) && self.float.as_ref().is_some_and(|f| f.label == label)
    }

    /// The source tore the tab off into new window `label`, not loaded yet, on a monitor of `scale`;
    /// the next tick puts it under the cursor.
    fn floated(&mut self, label: String, scale: f64) {
        self.float = Some(Float { label, grab: (TAB_GRAB.0 * scale, TAB_GRAB.1 * scale), ready: false, shown: false, at: None });
    }
}

#[derive(Default)]
struct Drags {
    seq: u64,
    now: Option<Session>,
}

#[derive(Default)]
pub struct TabDrag(Mutex<Drags>);

fn apply(app: &AppHandle, fx: Vec<Effect>) {
    for e in fx {
        // Not `get_webview_window`: a window holding a page webview has two webviews, and that finds none.
        let win = |l: &str| app.get_window(l);
        let r = match &e {
            Effect::Over(l, o) => app.emit_to(l.as_str(), "tab-drag-over", o),
            Effect::Tear(l) => app.emit_to(l.as_str(), "tab-drag-tear", ()),
            Effect::Drop(l, s) => app.emit_to(l.as_str(), "tab-drag-drop", s),
            Effect::End => app.emit("tab-drag-end", ()),
            Effect::Move(l, p) => win(l).map_or(Ok(()), |w| w.set_position(*p)),
            Effect::Show(l) => win(l).map_or(Ok(()), |w| w.show()),
            Effect::Hide(l) => win(l).map_or(Ok(()), |w| w.hide()),
            Effect::Focus(l) => win(l).map_or(Ok(()), |w| w.set_focus()),
        };
        if let Err(err) = r {
            log::warn!("tab drag {e:?}: {err}");
        }
    }
}

struct Sample {
    at: Point,
    down: bool,
    escape: bool,
}

#[cfg(windows)]
fn sample(_app: &AppHandle) -> Option<Sample> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VIRTUAL_KEY, VK_ESCAPE, VK_LBUTTON, VK_RBUTTON};
    use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetSystemMetrics, SM_SWAPBUTTON};
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p) }.ok()?;
    let down = |k: VIRTUAL_KEY| unsafe { GetAsyncKeyState(i32::from(k.0)) } as u16 & 0x8000 != 0;
    // The async state is the physical button: swapped buttons make the right one primary.
    let primary = if unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0 { VK_RBUTTON } else { VK_LBUTTON };
    Some(Sample { at: Point { x: f64::from(p.x), y: f64::from(p.y) }, down: down(primary), escape: down(VK_ESCAPE) })
}

/// shortcut: the button and Escape are polled only on Windows (the only platform Lattice ships
/// for); elsewhere the drag ends on the source's pointerup or Escape (`tab_drag_release`).
#[cfg(not(windows))]
fn sample(app: &AppHandle) -> Option<Sample> {
    let p = app.cursor_position().ok()?;
    Some(Sample { at: Point { x: p.x, y: p.y }, down: true, escape: false })
}

/// Follows the cursor until drag `id` ends or another drag replaces it.
fn poll(app: AppHandle, id: u64) {
    thread::spawn(move || {
        loop {
            thread::sleep(TICK);
            let Some(s) = sample(&app) else { continue };
            let drag = app.state::<TabDrag>();
            let mut g = lock(&drag.0);
            let Some(d) = g.now.as_mut().filter(|d| d.id == id && !d.ended) else { break };
            let fx = if s.escape {
                d.release(true)
            } else if !s.down {
                d.release(false)
            } else {
                d.step(s.at)
            };
            // Applied under the lock so effects reach the windows in the order they were decided;
            // nothing here waits on the main thread, and the main thread never takes this lock.
            apply(&app, fx);
        }
    });
}

/// Whether window `label` is the one following the cursor in the current drag.
pub fn follows(app: &AppHandle, label: &str) -> bool {
    lock(&app.state::<TabDrag>().0).now.as_ref().is_some_and(|d| d.follows(label))
}

/// Window `label` mounted its UI: true when it is the window following a drag, which then decides
/// when it shows (`popout::window_ready` shows any other pop-out).
pub fn claim_ready(app: &AppHandle, label: &str) -> bool {
    let drag = app.state::<TabDrag>();
    let mut g = lock(&drag.0);
    match g.now.as_mut().and_then(|d| d.ready(label)) {
        Some(fx) => {
            apply(app, fx);
            true
        }
        None => false,
    }
}

#[derive(Deserialize)]
pub struct Start {
    /// The tab's title, domain and feed, as the strips draw it.
    tab: Value,
    pane: u64,
    index: usize,
    /// The window is a document window and this is its only tab: the window follows the cursor.
    alone: bool,
    geom: Geom,
}

/// A tab drag began in the calling window: every window is asked for its strips (`tab-drag-start`)
/// and the cursor is followed until the button comes up.
#[tauri::command]
pub async fn tab_drag_start(app: AppHandle, drag: State<'_, TabDrag>, webview: Webview, start: Start) -> Result<(), String> {
    let w = webview.window();
    let label = w.label().to_string();
    let at = sample(&app).ok_or("the cursor position is unknown")?.at;
    // The main window keeps its place: its only tab tears off like any other.
    let home = if start.alone && popout::is_doc(&label) { Some(w.outer_position().map_err(err)?) } else { None };
    let source = Geom { label, ..start.geom };
    let id = {
        let mut g = lock(&drag.0);
        g.seq += 1;
        g.now = Some(Session::new(g.seq, source, start.tab, (start.pane, start.index), at, home));
        g.seq
    };
    app.emit("tab-drag-start", ()).map_err(err)?;
    poll(app, id);
    Ok(())
}

/// The calling window's strips, during a drag (at its start, and when its tabs change).
#[tauri::command]
pub async fn tab_drag_strips(drag: State<'_, TabDrag>, webview: Webview, geom: Geom) -> Result<(), String> {
    let label = webview.window().label().to_string();
    if let Some(d) = lock(&drag.0).now.as_mut().filter(|d| !d.ended) {
        d.strips(Geom { label, ..geom });
    }
    Ok(())
}

/// The source tore the tab off into a new document window `label`, whose layout it has stored:
/// the window is created hidden and follows the cursor, shown once it has loaded.
#[tauri::command]
pub async fn tab_drag_float(app: AppHandle, drag: State<'_, TabDrag>, loc: State<'_, Location>, webview: Webview, label: String) -> Result<(), String> {
    if !popout::is_doc(&label) {
        return Err("not a document window".into());
    }
    let source = webview.window().label().to_string();
    let last = lock(&drag.0).now.as_ref().map(|d| d.last).ok_or("no tab is being dragged")?;
    let scale = app.monitor_from_point(last.x, last.y).map_err(err)?.map_or(1.0, |m| m.scale_factor());
    {
        let mut g = lock(&drag.0);
        let d = g.now.as_mut().filter(|d| d.source == source && d.torn && d.float.is_none()).ok_or("no tab is being torn off")?;
        // Before the window exists, so that its `window_ready` finds it.
        d.floated(label.clone(), scale);
    }
    popout::create(&app, &loc, &label).map(|_| ())
}

/// The source saw the button come up, or Escape (`cancel`). On Windows the poll usually sees it first.
#[tauri::command]
pub async fn tab_drag_release(app: AppHandle, drag: State<'_, TabDrag>, cancel: bool) -> Result<(), String> {
    if let Some(d) = lock(&drag.0).now.as_mut() {
        apply(&app, d.release(cancel));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A strip 34 px high at the left edge, its pane's body `body` px high below it.
    fn strip(pane: u64, y: f64, width: f64, mids: &[f64], body: f64) -> Strip {
        Strip { pane, x: 0.0, y, width, height: 34.0, mids: mids.to_vec(), body: Rect { x: 0.0, y: y + 34.0, width, height: body } }
    }
    fn p(x: f64, y: f64) -> Point {
        Point { x, y }
    }
    fn pos(x: i32, y: i32) -> PhysicalPosition<i32> {
        PhysicalPosition::new(x, y)
    }
    fn slot(label: &str, pane: u64, index: usize) -> Slot {
        Slot { label: label.into(), pane, at: At::Index(index) }
    }
    fn zone(label: &str, pane: u64, zone: Zone) -> Slot {
        Slot { label: label.into(), pane, at: At::Zone(zone) }
    }
    /// The main window at the origin with two panes stacked; a document window to its right at double scale.
    fn main_win() -> Geom {
        Geom {
            label: "main".into(),
            x: 0.0,
            y: 0.0,
            width: 1200.0,
            height: 800.0,
            scale: 1.0,
            strips: vec![strip(1, 32.0, 1200.0, &[60.0, 160.0], 354.0), strip(2, 420.0, 1200.0, &[], 346.0)],
        }
    }
    fn doc_win() -> Geom {
        Geom { label: "doc-1".into(), x: 1300.0, y: 100.0, width: 960.0, height: 720.0, scale: 2.0, strips: vec![strip(1, 32.0, 480.0, &[60.0], 294.0)] }
    }
    fn label() -> Value {
        json!({ "title": "B", "domain": "b.example" })
    }
    fn over(pane: u64, index: usize, tab: bool) -> Option<Over> {
        Some(Over { pane, at: At::Index(index), tab: tab.then(label) })
    }
    fn over_body(pane: u64, z: Zone) -> Option<Over> {
        Some(Over { pane, at: At::Zone(z), tab: None })
    }
    /// A drag of main's second tab (pane 1, index 1), with doc-1's strips reported.
    fn from_main() -> Session {
        let mut s = Session::new(1, main_win(), label(), (1, 1), p(160.0, 40.0), None);
        s.strips(doc_win());
        s
    }

    #[test]
    fn the_slot_is_the_number_of_tab_centers_left_of_the_pointer() {
        assert_eq!(index_at(&[60.0, 160.0], 10.0), 0);
        assert_eq!(index_at(&[60.0, 160.0], 100.0), 1);
        assert_eq!(index_at(&[60.0, 160.0], 500.0), 2);
        assert_eq!(index_at(&[], 500.0), 0, "an empty strip takes the tab first");
    }

    #[test]
    fn a_strip_is_found_in_its_own_windows_scale_and_the_source_is_on_top() {
        let wins = [main_win(), doc_win()];
        assert_eq!(slot_at(p(100.0, 40.0), &wins, None, None), Some(slot("main", 1, 1)));
        assert_eq!(slot_at(p(300.0, 430.0), &wins, None, None), Some(slot("main", 2, 0)));
        assert_eq!(slot_at(p(300.0, 300.0), &wins, None, None), None, "over the content, not a strip");
        // Physical (1400, 180) is client (50, 40) of doc-1 at scale 2: before its one tab's center.
        assert_eq!(slot_at(p(1400.0, 180.0), &wins, None, None), Some(slot("doc-1", 1, 0)));
        assert_eq!(slot_at(p(1600.0, 180.0), &wins, None, None), Some(slot("doc-1", 1, 1)));
        assert_eq!(slot_at(p(3000.0, 40.0), &wins, None, None), None, "outside every window");
        let mut above = doc_win();
        (above.label, above.x, above.y) = ("doc-2".into(), 1000.0, 0.0);
        assert_eq!(slot_at(p(1100.0, 40.0), &[main_win(), above.clone()], None, None), Some(slot("main", 1, 2)), "main is dragging, so it is on top");
        assert_eq!(slot_at(p(1100.0, 40.0), &[above, main_win()], None, None), None, "doc-2 is dragging: its content, above its strip");
        assert_eq!(slot_at(p(100.0, 40.0), &wins, Some("main"), None), None, "the window following the cursor is never a target");
    }

    #[test]
    fn a_tab_stays_in_its_strip_until_it_is_pulled_detach_px_above_or_below_it() {
        let wins = [main_win()];
        let a = slot("main", 1, 1);
        // Main's first strip spans y 32..66.
        assert_eq!(slot_at(p(100.0, 66.0 + 29.0), &wins, None, Some(&a)), Some(slot("main", 1, 1)));
        assert_eq!(slot_at(p(100.0, 3.0), &wins, None, Some(&a)), Some(slot("main", 1, 1)), "up into the title bar");
        assert_eq!(slot_at(p(500.0, 66.0 + 31.0), &wins, None, Some(&a)), None);
        assert_eq!(slot_at(p(100.0, 66.0 + 29.0), &wins, None, None), None, "only the strip it is in holds it");
        assert_eq!(slot_at(p(1250.0, 40.0), &wins, None, Some(&a)), None, "sideways out of the strip");
    }

    #[test]
    fn a_tab_torn_off_follows_the_cursor_in_its_window_hides_over_a_strip_and_comes_back() {
        let mut s = from_main();
        assert_eq!(s.step(p(170.0, 45.0)), vec![Effect::Over("main".into(), over(1, 2, false))], "its own strip: a marker");
        assert_eq!(s.step(p(600.0, 200.0)), vec![Effect::Over("main".into(), None)], "main has two panes: still inside it, over its own pane");
        assert_eq!(s.step(p(1250.0, 300.0)), vec![Effect::Tear("main".into())]);
        assert_eq!(s.step(p(1251.0, 300.0)), vec![], "asked once");
        s.floated("doc-2".into(), 1.0);
        assert_eq!(s.step(p(200.0, 300.0)), vec![Effect::Move("doc-2".into(), pos(144, 249))], "hidden until it has loaded");
        assert_eq!(claim(&mut s, "doc-2"), vec![Effect::Show("doc-2".into())]);
        assert_eq!(s.ready("doc-1"), None, "another window shows itself");
        assert_eq!(s.step(p(1400.0, 180.0)), vec![Effect::Over("doc-1".into(), over(1, 0, true)), Effect::Hide("doc-2".into())], "doc-1 draws the tab");
        assert_eq!(s.step(p(1600.0, 180.0)), vec![Effect::Over("doc-1".into(), over(1, 1, true))]);
        assert_eq!(
            s.step(p(100.0, 40.0)),
            vec![Effect::Over("doc-1".into(), None), Effect::Over("main".into(), over(1, 1, true))],
            "back in main: drawn, it left main"
        );
        assert_eq!(s.step(p(100.0, 300.0)), vec![Effect::Over("main".into(), None), Effect::Move("doc-2".into(), pos(44, 249)), Effect::Show("doc-2".into())]);
        assert_eq!(s.release(false), vec![Effect::Focus("doc-2".into()), Effect::End], "it stays where it is");
        assert_eq!(s.step(p(0.0, 0.0)), vec![]);
        assert_eq!(s.ready("doc-2"), None, "done: a later doc-2 is a window of its own");
    }

    fn claim(s: &mut Session, label: &str) -> Vec<Effect> {
        s.ready(label).expect("the following window")
    }

    #[test]
    fn a_body_is_its_center_and_an_edge_quarter_on_each_side() {
        let r = Rect { x: 0.0, y: 100.0, width: 400.0, height: 200.0 };
        assert_eq!(r.zone(p(200.0, 200.0)), Some(Zone::Center));
        assert_eq!(r.zone(p(99.0, 200.0)), Some(Zone::Left));
        assert_eq!(r.zone(p(101.0, 200.0)), Some(Zone::Center));
        assert_eq!(r.zone(p(301.0, 200.0)), Some(Zone::Right));
        assert_eq!(r.zone(p(200.0, 149.0)), Some(Zone::Top));
        assert_eq!(r.zone(p(200.0, 251.0)), Some(Zone::Bottom));
        assert_eq!(r.zone(p(10.0, 140.0)), Some(Zone::Left), "a corner: the nearer edge");
        assert_eq!(r.zone(p(200.0, 99.0)), None, "the strip above");
        assert_eq!(r.zone(p(400.0, 200.0)), None, "the next pane's");
        assert_eq!(Rect { width: 0.0, ..r }.zone(p(0.0, 200.0)), None, "no size, no zones");
    }

    #[test]
    fn in_a_window_split_into_panes_the_tab_moves_between_them_and_comes_out_only_outside_it() {
        let mut s = from_main();
        // Pane 1's body spans y 66..420, pane 2's 454..800, both x 0..1200.
        assert_eq!(s.step(p(600.0, 200.0)), vec![], "its own pane's center: where it is");
        assert_eq!(s.step(p(300.0, 430.0)), vec![Effect::Over("main".into(), over(2, 0, false))]);
        assert_eq!(s.step(p(600.0, 600.0)), vec![Effect::Over("main".into(), over_body(2, Zone::Center))], "the other pane's body");
        assert_eq!(s.step(p(100.0, 600.0)), vec![Effect::Over("main".into(), over_body(2, Zone::Left))]);
        assert_eq!(s.step(p(600.0, 380.0)), vec![Effect::Over("main".into(), over_body(1, Zone::Bottom))], "its own pane's edge");
        assert_eq!(s.step(p(600.0, 200.0)), vec![Effect::Over("main".into(), None)]);
        assert_eq!(s.release(false), vec![Effect::End], "dropped on its own pane's center: it stays");
        let mut s = from_main();
        s.step(p(1100.0, 600.0));
        assert_eq!(s.release(false), vec![Effect::Drop("main".into(), zone("main", 2, Zone::Right)), Effect::End]);
        let mut s = from_main();
        s.step(p(600.0, 600.0));
        assert_eq!(s.release(true), vec![Effect::Drop("main".into(), slot("main", 1, 1)), Effect::End], "Escape over a body");
        let mut s = from_main();
        s.step(p(600.0, 600.0));
        assert_eq!(s.step(p(1250.0, 300.0)), vec![Effect::Over("main".into(), None), Effect::Tear("main".into())], "out of the window");
        assert_eq!(s.step(p(600.0, 600.0)), vec![], "torn off: a body is no target");
        let mut s = Session::new(1, Geom { strips: vec![strip(1, 32.0, 1200.0, &[60.0, 160.0], 734.0)], ..main_win() }, label(), (1, 1), p(160.0, 40.0), None);
        assert_eq!(s.step(p(170.0, 300.0)), vec![Effect::Tear("main".into())], "one pane: as soon as it is off the strip");
    }

    #[test]
    fn released_over_another_panes_strip_in_its_own_window_the_tab_moves_there() {
        let mut s = from_main();
        s.step(p(170.0, 300.0));
        assert_eq!(s.step(p(300.0, 430.0)), vec![Effect::Over("main".into(), over(2, 0, false))], "the empty pane's strip marks its slot");
        assert_eq!(s.release(false), vec![Effect::Drop("main".into(), slot("main", 2, 0)), Effect::End]);
    }

    #[test]
    fn released_over_a_strip_the_window_holding_the_tab_sends_it_there() {
        let mut s = from_main();
        s.step(p(1250.0, 300.0));
        s.floated("doc-2".into(), 2.0);
        claim(&mut s, "doc-2");
        s.step(p(1600.0, 180.0));
        assert_eq!(s.release(false), vec![Effect::Drop("doc-2".into(), slot("doc-1", 1, 1)), Effect::End]);

        let mut s = from_main();
        s.step(p(1400.0, 180.0));
        assert_eq!(s.release(false), vec![Effect::Drop("main".into(), slot("doc-1", 1, 0)), Effect::End], "never torn off: main sends it");
        let mut s = from_main();
        s.step(p(40.0, 40.0));
        assert_eq!(s.release(false), vec![Effect::Drop("main".into(), slot("main", 1, 0)), Effect::End], "its own strip: a move");
    }

    #[test]
    fn escape_puts_the_tab_back_where_it_started() {
        let mut s = from_main();
        s.step(p(1250.0, 300.0));
        s.floated("doc-2".into(), 1.0);
        claim(&mut s, "doc-2");
        s.step(p(1400.0, 180.0));
        assert_eq!(s.release(true), vec![Effect::Drop("doc-2".into(), slot("main", 1, 1)), Effect::End]);
        assert_eq!(s.release(false), vec![], "once");
    }

    #[test]
    fn a_release_before_the_torn_off_window_loads_waits_for_it() {
        let mut s = from_main();
        s.step(p(1250.0, 300.0));
        assert_eq!(s.release(false), vec![Effect::End], "the tab is on its way to a window not created yet");
        s.floated("doc-2".into(), 1.0);
        assert_eq!(claim(&mut s, "doc-2"), vec![Effect::Move("doc-2".into(), pos(1194, 249)), Effect::Show("doc-2".into()), Effect::Focus("doc-2".into())]);

        let mut s = from_main();
        s.step(p(1250.0, 300.0));
        s.floated("doc-2".into(), 1.0);
        s.step(p(1400.0, 180.0));
        assert_eq!(s.release(false), vec![Effect::End]);
        assert_eq!(claim(&mut s, "doc-2"), vec![Effect::Drop("doc-2".into(), slot("doc-1", 1, 0))], "it never shows");
    }

    #[test]
    fn a_window_dragged_by_its_only_tab_follows_the_cursor_and_escape_puts_it_back() {
        let mut d = doc_win();
        (d.x, d.y, d.scale) = (500.0, 500.0, 1.0);
        let mut s = Session::new(1, d, label(), (1, 0), p(560.0, 549.0), Some(pos(500, 500)));
        s.strips(main_win());
        assert_eq!(s.step(p(560.0, 549.0)), vec![], "its own strip is under the cursor, but it is the window that moves");
        assert_eq!(s.step(p(600.0, 600.0)), vec![Effect::Move("doc-1".into(), pos(540, 551))]);
        assert_eq!(s.step(p(100.0, 40.0)), vec![Effect::Over("main".into(), over(1, 1, true)), Effect::Hide("doc-1".into())]);
        assert_eq!(
            s.release(true),
            vec![Effect::Move("doc-1".into(), pos(500, 500)), Effect::Show("doc-1".into()), Effect::Focus("doc-1".into()), Effect::End]
        );

        let mut s = Session::new(1, doc_win(), label(), (1, 0), p(1400.0, 180.0), Some(pos(1300, 100)));
        s.strips(main_win());
        s.step(p(100.0, 40.0));
        assert_eq!(s.release(false), vec![Effect::Drop("doc-1".into(), slot("main", 1, 1)), Effect::End], "it sends its tab and closes");
    }

    #[test]
    fn the_ui_reports_plain_numbers() {
        let g: Geom = serde_json::from_str(
            r#"{"label":"x","x":-1920,"y":0.5,"width":800,"height":600,"scale":1.25,"strips":[{"pane":3,"x":0,"y":32,"width":800,"height":34,"mids":[50.5],"body":{"x":0,"y":66,"width":800,"height":534}}]}"#,
        )
        .unwrap();
        assert_eq!((g.x, g.strips[0].pane, g.strips[0].mids.clone()), (-1920.0, 3, vec![50.5]));
        let o = serde_json::to_value(Over { pane: 1, at: At::Index(2), tab: None }).unwrap();
        assert_eq!(o, json!({ "pane": 1, "index": 2 }), "a marker carries no tab");
        assert_eq!(serde_json::to_value(over_body(2, Zone::Left)).unwrap(), json!({ "pane": 2, "zone": "left" }));
        assert_eq!(serde_json::to_value(zone("main", 2, Zone::Center)).unwrap(), json!({ "label": "main", "pane": 2, "zone": "center" }));
        assert_eq!(serde_json::to_value(slot("main", 1, 0)).unwrap(), json!({ "label": "main", "pane": 1, "index": 0 }));
    }
}
