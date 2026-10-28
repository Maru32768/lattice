//! Live tab dragging between windows (design-review §26), the way Chrome does it: a tab pulled
//! `DETACH` px off its strip comes out at once in a window that follows the cursor; over another
//! window's strip that window goes away and the tab moves into the strip at the slot under the
//! cursor, its content shown there; off the strip again it goes back into the window that follows.
//! In a strip the tab follows the cursor along it, and its neighbours change sides once its near
//! edge passes their centers. A document window dragging its only tab is itself the window that
//! follows.
//!
//! The backend runs the drag. Once the cursor leaves the window that was pressed, its pointer
//! events cannot be relied on (the tab element holding the pointer capture is gone after a tear,
//! and the new window takes the activation), so a thread polls the cursor, the primary button
//! and Escape until the button comes up. The windows report their strips; this module decides,
//! and tells the source what to mark while the tab has not left it (`tab-drag-over`), and the
//! window holding the tab where to draw it along its strip (`tab-drag-slide`), to tear it off into
//! a new window (`tab-drag-tear`) or to put it somewhere (`tab-drag-drop`). A window the tab was sent to says when it has it
//! (`tab_drag_held`), and only then does the tab move on: one window at a time. A page moves with
//! its webview, so it does not reload on the way.
//!
//! In a window split into panes the tab can also go onto a pane's body, as in VS Code: its center
//! moves the tab into that pane, its edges split the pane that way (`Zone`).

#![allow(unsafe_code, reason = "Win32 input polling through the windows crate")]

use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, Webview};

use crate::browser::lock;
use crate::location::Location;
use crate::{err, popout};

const TICK: Duration = Duration::from_millis(8);
/// How long after the button came up a window may take to say it has the tab, before the drag ends without it.
const SETTLE: Duration = Duration::from_secs(3);
/// How far (CSS px) above or below its strip a tab can go and stay in it; Chrome lets go at about this.
const DETACH: f64 = 30.0;
/// Where the first tab's corner sits in a fresh document window, in logical pixels: its strip is
/// the title bar, and this is the strip's padding (`.tabs` in `src/app/App.css`).
const FIRST_TAB: (f64, f64) = (6.0, 5.0);
/// How far into a pane's body, as a fraction of its width or height, an edge reaches.
const EDGE: f64 = 0.25;

/// A point in physical screen pixels.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct Point {
    x: f64,
    y: f64,
}

/// One pane's tab strip in the CSS pixels of its window: its tabs' left and right edges, which of
/// them is the dragged one, and `body`, the rest of the pane below the strip.
#[derive(Debug, Clone, Deserialize)]
struct Strip {
    pane: u64,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    tabs: Vec<(f64, f64)>,
    #[serde(default)]
    held: Option<usize>,
    body: Rect,
}

/// How the dragged tab sits under the cursor, in CSS px: grabbed `grab` from its left edge and
/// `grab_y` from its top, `width` wide.
#[derive(Debug, Clone, Copy)]
struct Grip {
    grab: f64,
    grab_y: f64,
    width: f64,
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
        Some(if d < EDGE {
            z
        } else {
            Zone::Center
        })
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

/// A window's client area in physical pixels, its scale, and its strips (`measure` in `src/layout/tabDrag.ts`).
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

/// The slot in `s` for the dragged tab with the cursor at client x `x`. In the strip that has it,
/// Chrome's rule: a neighbour changes sides once the tab's near edge passes the neighbour's center
/// (and a move counts the tab itself among the tabs it goes before). Elsewhere the tab goes before
/// the first tab whose center is past its own.
fn index_in(s: &Strip, x: f64, g: Grip) -> usize {
    let left = x - g.grab;
    let center = |t: &(f64, f64)| (t.0 + t.1) / 2.0;
    let Some(h) = s.held else {
        return s.tabs.iter().filter(|t| center(t) < left + g.width / 2.0).count();
    };
    let right = left + s.tabs.get(h).map_or(g.width, |t| t.1 - t.0);
    let before = s.tabs.iter().enumerate().filter(|&(i, t)| (i < h && center(t) <= left) || (i > h && center(t) < right)).count();
    if before > h {
        before + 1
    } else {
        before
    }
}

/// The slot under `p`, if any. The first window that contains `p` decides: the source is `wins[0]`
/// (it is the active window, so on top), the rest in report order; `skip` is the window following
/// the cursor. Off every strip, the tab stays in the strip it is `attached` to while it is within
/// `DETACH` above or below it.
fn slot_at(p: Point, wins: &[Geom], skip: Option<&str>, attached: Option<&Slot>, g: Grip) -> Option<Slot> {
    let wins = || wins.iter().filter(|w| Some(w.label.as_str()) != skip);
    if let Some(w) = wins().find(|w| w.contains(p)) {
        let c = w.client(p);
        if let Some(s) = w.strips.iter().find(|s| c.x >= s.x && c.y >= s.y && c.x < s.x + s.width && c.y < s.y + s.height) {
            return Some(Slot { label: w.label.clone(), pane: s.pane, at: At::Index(index_in(s, c.x, g)) });
        }
    }
    let a = attached?;
    let w = wins().find(|w| w.label == a.label)?;
    let s = w.strips.iter().find(|s| s.pane == a.pane)?;
    let c = w.client(p);
    let near = c.x >= s.x && c.x < s.x + s.width && c.y >= s.y - DETACH && c.y < s.y + s.height + DETACH;
    near.then(|| Slot { label: a.label.clone(), pane: a.pane, at: At::Index(index_in(s, c.x, g)) })
}

/// What the source marks while the tab has not left it: a slot in another pane's strip, or a zone
/// of a pane's body. The tab moves there when the button comes up.
#[derive(Debug, Clone, PartialEq, Serialize)]
struct Over {
    pane: u64,
    #[serde(flatten)]
    at: At,
}

/// Where the tab in a strip is drawn: its left edge `x` CSS px from the strip's left, following the
/// cursor along the strip.
#[derive(Debug, Clone, PartialEq, Serialize)]
struct Slide {
    pane: u64,
    x: f64,
}

/// The window following the cursor: the new window of a torn-off tab, or the source itself when
/// that tab was its only one. `grab` is the cursor's offset from the window's origin.
#[derive(Debug)]
struct Float {
    label: String,
    grab: (f64, f64),
    /// Its UI has mounted (it can hold the tab and be shown).
    ready: bool,
    shown: bool,
    at: Option<PhysicalPosition<i32>>,
}

/// Where the dragged tab is, or is on its way to.
#[derive(Debug, Clone, PartialEq)]
enum Held {
    /// In the strip of window `label`, at this slot.
    Strip(Slot),
    /// In the window following the cursor.
    Float,
}

/// Where the window holding the tab puts it: a slot (in its own strips a move, else a send), or
/// the window following the cursor.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
enum To {
    Slot(Slot),
    Window { label: String },
}

#[derive(Debug, PartialEq)]
enum Effect {
    Over(String, Option<Over>),
    Slide(String, Option<Slide>),
    Tear(String),
    Drop(String, To),
    /// To every window: the drag is over (markers go, emptied windows close).
    End,
    Move(String, PhysicalPosition<i32>),
    Show(String),
    Hide(String),
    Focus(String),
}

struct Session {
    id: u64,
    source: String,
    /// Where the tab was in the source, for Escape.
    origin: Slot,
    grip: Grip,
    /// Where the source window was, when it is the one that follows the cursor.
    home: Option<PhysicalPosition<i32>>,
    wins: Vec<Geom>,
    float: Option<Float>,
    held: Held,
    /// The tab was sent or torn off to the window `held` names, which has not said it has it yet.
    moving: bool,
    /// The tab has not left the source: its other panes' strips and bodies are marked, not moved to.
    stayed: bool,
    /// The window told to tear the tab off, until the new window exists.
    tearing: Option<String>,
    /// The slot or zone the source marks.
    over: Option<Slot>,
    /// The last slide sent, and to which window.
    slid: Option<(String, Slide)>,
    last: Point,
    /// The button came up: `Some(true)` with Escape.
    released: Option<bool>,
    /// `tab-drag-end` went out.
    done: bool,
}

impl Session {
    fn new(id: u64, source: Geom, origin: (u64, usize), grip: Grip, at: Point, alone: Option<PhysicalPosition<i32>>) -> Self {
        let label = source.label.clone();
        let float = alone.map(|o| Float { label: label.clone(), grab: (at.x - o.x as f64, at.y - o.y as f64), ready: true, shown: true, at: Some(o) });
        let origin = Slot { label: label.clone(), pane: origin.0, at: At::Index(origin.1) };
        let held = if alone.is_some() {
            Held::Float
        } else {
            Held::Strip(origin.clone())
        };
        Session {
            id,
            source: label,
            origin,
            grip,
            home: alone,
            wins: vec![source],
            float,
            held,
            moving: false,
            stayed: true,
            tearing: None,
            over: None,
            slid: None,
            last: at,
            released: None,
            done: false,
        }
    }

    /// The window that has the tab, or is getting it.
    fn holder(&self) -> Option<String> {
        match &self.held {
            Held::Strip(s) => Some(s.label.clone()),
            Held::Float => self.float.as_ref().map(|f| f.label.clone()),
        }
    }

    fn strips(&mut self, g: Geom) {
        match self.wins.iter_mut().find(|w| w.label == g.label) {
            Some(w) => *w = g,
            None => self.wins.push(g),
        }
    }

    fn step(&mut self, p: Point) -> Vec<Effect> {
        if self.released.is_some() {
            return vec![];
        }
        self.last = p;
        // While the tab is on its way, the window getting it catches up with the cursor (`held_by`).
        if self.moving {
            return vec![];
        }
        self.chase()
    }

    /// The tab goes where the cursor is: along its strip, into the strip under the cursor, or off
    /// every strip into the window following the cursor. One window at a time: the next move waits
    /// for this one.
    fn chase(&mut self) -> Vec<Effect> {
        let p = self.last;
        let skip = self.float.as_ref().map(|f| f.label.clone());
        let attached = match &self.held {
            Held::Strip(s) => Some(s.clone()),
            Held::Float => None,
        };
        let at = slot_at(p, &self.wins, skip.as_deref(), attached.as_ref(), self.grip).or_else(|| self.body_at(p));
        let Some(from) = self.holder() else {
            return vec![];
        };
        let marked = at.clone().filter(|a| self.marks(a));
        let mut fx = self.mark(marked.clone());
        fx.extend(match (self.held.clone(), at.clone()) {
            (_, Some(_)) if marked.is_some() => vec![],
            (Held::Strip(s), Some(a)) if a == s => vec![],
            (Held::Strip(_), Some(a)) => self.send(&from, a),
            (Held::Strip(_), None) if self.stayed && self.between_panes(p) => vec![],
            (Held::Strip(_), None) => self.float_off(&from),
            (Held::Float, Some(a)) => {
                let mut fx = self.hide();
                fx.extend(self.send(&from, a));
                fx
            }
            (Held::Float, None) => self.follow(),
        });
        let along = matches!((&self.held, &at), (Held::Strip(s), Some(a)) if a == s);
        fx.extend(self.slide(along));
        fx
    }

    /// While the tab has not left the source, another of its panes is only marked: moving the tab
    /// there at once could empty and remove the pane it came from.
    fn marks(&self, a: &Slot) -> bool {
        let pane = match &self.held {
            Held::Strip(s) => Some(s.pane),
            Held::Float => None,
        };
        self.stayed && a.label == self.source && (matches!(a.at, At::Zone(_)) || Some(a.pane) != pane)
    }

    fn mark(&mut self, over: Option<Slot>) -> Vec<Effect> {
        if over == self.over {
            return vec![];
        }
        self.over = over.clone();
        vec![Effect::Over(self.source.clone(), over.map(|o| Over { pane: o.pane, at: o.at }))]
    }

    /// The tab in a strip follows the cursor along it while the cursor is `along` that strip; else
    /// it sits in its slot.
    fn slide(&mut self, along: bool) -> Vec<Effect> {
        let next = match &self.held {
            Held::Strip(s) if along && !self.moving => {
                let w = self.wins.iter().find(|w| w.label == s.label);
                w.and_then(|w| {
                    let strip = w.strips.iter().find(|t| t.pane == s.pane)?;
                    let x = (w.client(self.last).x - strip.x - self.grip.grab).round();
                    Some((s.label.clone(), Slide { pane: s.pane, x }))
                })
            }
            _ => None,
        };
        if next == self.slid {
            return vec![];
        }
        let mut fx = vec![];
        if let Some((l, _)) = self.slid.as_ref().filter(|(l, _)| next.as_ref().is_none_or(|(n, _)| n != l)) {
            fx.push(Effect::Slide(l.clone(), None));
        }
        if let Some((l, s)) = &next {
            fx.push(Effect::Slide(l.clone(), Some(s.clone())));
        }
        self.slid = next;
        fx
    }

    /// Window `from`, which has the tab, puts it at `to`: a move in its own strips, else a send
    /// that `to`'s window confirms.
    fn send(&mut self, from: &str, to: Slot) -> Vec<Effect> {
        self.moving = to.label != from;
        self.stayed &= !self.moving;
        self.held = Held::Strip(to.clone());
        vec![Effect::Drop(from.to_string(), To::Slot(to))]
    }

    /// Off every strip: the tab goes into the window following the cursor, made the first time.
    fn float_off(&mut self, from: &str) -> Vec<Effect> {
        self.held = Held::Float;
        self.moving = true;
        self.stayed = false;
        match &self.float {
            Some(f) => vec![Effect::Drop(from.to_string(), To::Window { label: f.label.clone() })],
            None => {
                self.tearing = Some(from.to_string());
                vec![Effect::Tear(from.to_string())]
            }
        }
    }

    /// In a source split into panes, the way from one pane's strip to another's crosses the panes:
    /// there the tab comes out only when the cursor leaves the window.
    fn between_panes(&self, p: Point) -> bool {
        let source = &self.wins[0];
        source.strips.len() > 1 && source.contains(p)
    }

    /// The pane body under `p` while the tab has not left a source split into panes. The center
    /// of the tab's own pane is where it already is.
    fn body_at(&self, p: Point) -> Option<Slot> {
        let Held::Strip(held) = &self.held else {
            return None;
        };
        if !self.stayed || !self.between_panes(p) {
            return None;
        }
        let w = &self.wins[0];
        let c = w.client(p);
        let (pane, zone) = w.strips.iter().find_map(|s| Some((s.pane, s.body.zone(c)?)))?;
        (pane != held.pane || zone != Zone::Center).then(|| Slot { label: w.label.clone(), pane, at: At::Zone(zone) })
    }

    /// Where `slot`'s window says the tab sits in that strip.
    fn held_index(&self, slot: &Slot) -> Option<usize> {
        let w = self.wins.iter().find(|w| w.label == slot.label)?;
        w.strips.iter().find(|s| s.pane == slot.pane)?.held
    }

    fn hide(&mut self) -> Vec<Effect> {
        match self.float.as_mut().filter(|f| f.shown) {
            Some(f) => {
                f.shown = false;
                vec![Effect::Hide(f.label.clone())]
            }
            None => vec![],
        }
    }

    fn place(&mut self, to: PhysicalPosition<i32>) -> Vec<Effect> {
        let Some(f) = self.float.as_mut() else {
            return vec![];
        };
        f.at = Some(to);
        let mut fx = vec![Effect::Move(f.label.clone(), to)];
        if !f.shown {
            f.shown = true;
            fx.push(Effect::Show(f.label.clone()));
        }
        fx
    }

    /// The following window goes to the cursor once it has loaded, and shows there. Until then it
    /// may not exist yet: a move would be lost and the window would show where Windows put it.
    fn follow(&mut self) -> Vec<Effect> {
        let p = self.last;
        let Some(f) = self.float.as_ref().filter(|f| f.ready) else {
            return vec![];
        };
        let to = PhysicalPosition::new((p.x - f.grab.0).round() as i32, (p.y - f.grab.1).round() as i32);
        if f.at == Some(to) && f.shown {
            return vec![];
        }
        self.place(to)
    }

    /// Window `label` says it has the tab it was sent: the tab catches up with the cursor, or the
    /// drag ends if the button came up meanwhile.
    fn held_by(&mut self, label: &str) -> Vec<Effect> {
        if self.done || !self.moving || self.holder().as_deref() != Some(label) {
            return vec![];
        }
        self.moving = false;
        if self.released.is_some() {
            self.finish()
        } else {
            self.chase()
        }
    }

    /// The button came up; with `cancel` (Escape) the tab goes back where it started.
    fn release(&mut self, cancel: bool) -> Vec<Effect> {
        if self.released.is_some() {
            return vec![];
        }
        self.released = Some(cancel);
        // The source marks another of its panes: the tab moves there now.
        if let Some(o) = self.over.clone().filter(|_| !cancel) {
            self.done = true;
            return vec![Effect::Drop(self.source.clone(), To::Slot(o)), Effect::End];
        }
        if self.moving {
            return vec![];
        }
        self.finish()
    }

    /// The button is up and no window is waiting for the tab: with Escape it goes back first; then
    /// the window holding it comes to the front and the drag ends.
    fn finish(&mut self) -> Vec<Effect> {
        let cancel = self.released == Some(true);
        let mut fx = if cancel {
            self.back()
        } else {
            vec![]
        };
        if self.moving {
            return fx;
        }
        if self.held == Held::Float {
            fx.extend(match self.home.filter(|_| cancel) {
                Some(home) => self.place(home),
                None => self.follow(),
            });
        }
        fx.extend(self.holder().map(Effect::Focus));
        fx.push(Effect::End);
        self.done = true;
        fx
    }

    /// Escape: the tab goes back to its slot, or to the window dragged by it, which goes home.
    fn back(&mut self) -> Vec<Effect> {
        let Some(from) = self.holder() else {
            return vec![];
        };
        match (self.home, self.held.clone()) {
            (Some(_), Held::Strip(_)) => self.float_off(&from),
            (None, Held::Strip(s)) if s == self.origin => vec![],
            (None, Held::Strip(s)) => {
                let mut to = self.origin.clone();
                // Back along its own strip: a move counts the tab itself among the tabs it goes before.
                if let (true, At::Index(i), Some(h)) = (s.label == to.label && s.pane == to.pane, to.at, self.held_index(&s))
                    && i > h
                {
                    to.at = At::Index(i + 1);
                }
                self.send(&from, to)
            }
            (None, Held::Float) => {
                let mut fx = self.hide();
                fx.extend(self.send(&from, self.origin.clone()));
                fx
            }
            _ => vec![],
        }
    }

    /// No window said it has the tab: the drag ends anyway rather than holding every window in it.
    fn give_up(&mut self) -> Vec<Effect> {
        if self.done {
            return vec![];
        }
        self.done = true;
        vec![Effect::End]
    }

    /// Window `label` has mounted its UI: None unless it is this drag's following window, which
    /// then has the tab torn off into it.
    fn ready(&mut self, label: &str) -> Option<Vec<Effect>> {
        if !self.follows(label) {
            return None;
        }
        let f = self.float.as_mut()?;
        if f.ready {
            return Some(vec![]);
        }
        f.ready = true;
        Some(self.held_by(label))
    }

    /// Window `label` follows the cursor in this drag. Once the drag is over the label is free: a
    /// later window of the same name is not this drag's.
    fn follows(&self, label: &str) -> bool {
        !self.done && self.float.as_ref().is_some_and(|f| f.label == label)
    }

    /// The tab was torn off into new window `label`, not loaded yet, on a monitor of `scale`.
    fn floated(&mut self, label: String, scale: f64) {
        let grab = ((FIRST_TAB.0 + self.grip.grab) * scale, (FIRST_TAB.1 + self.grip.grab_y) * scale);
        self.float = Some(Float { label, grab, ready: false, shown: false, at: None });
        self.tearing = None;
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
            Effect::Slide(l, s) => app.emit_to(l.as_str(), "tab-drag-slide", s),
            Effect::Tear(l) => app.emit_to(l.as_str(), "tab-drag-tear", ()),
            Effect::Drop(l, to) => app.emit_to(l.as_str(), "tab-drag-drop", to),
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
    // SAFETY: `p` is a local the call writes into.
    unsafe { GetCursorPos(&mut p) }.ok()?;
    // SAFETY: takes a key code by value and reads global state only.
    let down = |k: VIRTUAL_KEY| unsafe { GetAsyncKeyState(i32::from(k.0)) } as u16 & 0x8000 != 0;
    // The async state is the physical button: swapped buttons make the right one primary.
    // SAFETY: reads a system setting, no pointers.
    let primary = if unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0 {
        VK_RBUTTON
    } else {
        VK_LBUTTON
    };
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
        let mut released = None;
        loop {
            thread::sleep(TICK);
            let s = sample(&app);
            let drag = app.state::<TabDrag>();
            let mut g = lock(&drag.0);
            let Some(d) = g.now.as_mut().filter(|d| d.id == id && !d.done) else {
                break;
            };
            let fx = match s {
                // Up: the drag ends once the window getting the tab has it, or after `SETTLE` without.
                _ if d.released.is_some() => {
                    if released.get_or_insert_with(Instant::now).elapsed() > SETTLE {
                        d.give_up()
                    } else {
                        vec![]
                    }
                }
                None => vec![],
                Some(s) if s.escape => d.release(true),
                Some(s) if !s.down => d.release(false),
                Some(s) => d.step(s.at),
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
    pane: u64,
    index: usize,
    /// The window is a document window and this is its only tab: the window follows the cursor.
    alone: bool,
    /// Where in the tab the pointer went down, in CSS px from its corner.
    grab: (f64, f64),
    /// The tab's width in CSS px.
    width: f64,
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
    let home = if start.alone && popout::is_doc(&label) {
        Some(w.outer_position().map_err(err)?)
    } else {
        None
    };
    let source = Geom { label, ..start.geom };
    let id = {
        let mut g = lock(&drag.0);
        g.seq += 1;
        g.now = Some(Session::new(g.seq, source, (start.pane, start.index), Grip { grab: start.grab.0, grab_y: start.grab.1, width: start.width }, at, home));
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
    if let Some(d) = lock(&drag.0).now.as_mut().filter(|d| !d.done) {
        d.strips(Geom { label, ..geom });
    }
    Ok(())
}

/// The window told to tear the tab off did, into a new document window `label` whose layout it
/// has stored: the window is created hidden and follows the cursor, shown once it has loaded.
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
        let d = g.now.as_mut().filter(|d| d.tearing.as_deref() == Some(source.as_str())).ok_or("no tab is being torn off")?;
        // Before the window exists, so that its `window_ready` finds it.
        d.floated(label.clone(), scale);
    }
    popout::create(&app, &loc, &label).map(|_| ())
}

/// The calling window has the tab it was sent during the drag (or torn off into it, `window_ready`).
#[tauri::command]
pub async fn tab_drag_held(app: AppHandle, drag: State<'_, TabDrag>, webview: Webview) -> Result<(), String> {
    let label = webview.window().label().to_string();
    if let Some(d) = lock(&drag.0).now.as_mut() {
        apply(&app, d.held_by(&label));
    }
    Ok(())
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
    fn strip(pane: u64, y: f64, width: f64, tabs: &[(f64, f64)], body: f64) -> Strip {
        Strip { pane, x: 0.0, y, width, height: 34.0, tabs: tabs.to_vec(), held: None, body: Rect { x: 0.0, y: y + 34.0, width, height: body } }
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
            strips: vec![strip(1, 32.0, 1200.0, &[(10.0, 110.0), (110.0, 210.0)], 354.0), strip(2, 420.0, 1200.0, &[], 346.0)],
        }
    }
    fn doc_win() -> Geom {
        Geom {
            label: "doc-1".into(),
            x: 1300.0,
            y: 100.0,
            width: 960.0,
            height: 720.0,
            scale: 2.0,
            strips: vec![strip(1, 32.0, 480.0, &[(10.0, 110.0)], 294.0)],
        }
    }
    fn over(pane: u64, index: usize) -> Option<Over> {
        Some(Over { pane, at: At::Index(index) })
    }
    fn over_body(pane: u64, z: Zone) -> Option<Over> {
        Some(Over { pane, at: At::Zone(z) })
    }
    /// Grabbed at the center of a tab 100 wide, 14 px down: a torn-off window at scale 1 has that
    /// spot at (56, 19), and in a strip without it the tab's center is the cursor.
    const GRIP: Grip = Grip { grab: 50.0, grab_y: 14.0, width: 100.0 };
    /// A drag of main's second tab (pane 1, index 1), with doc-1's strips reported.
    fn from_main() -> Session {
        let mut main = main_win();
        main.strips[0].held = Some(1);
        let mut s = Session::new(1, main, (1, 1), GRIP, p(160.0, 40.0), None);
        s.strips(doc_win());
        s
    }

    #[test]
    fn a_strip_is_found_in_its_own_windows_scale_and_the_source_is_on_top() {
        let wins = [main_win(), doc_win()];
        assert_eq!(slot_at(p(100.0, 40.0), &wins, None, None, GRIP), Some(slot("main", 1, 1)));
        assert_eq!(slot_at(p(300.0, 430.0), &wins, None, None, GRIP), Some(slot("main", 2, 0)));
        assert_eq!(slot_at(p(300.0, 300.0), &wins, None, None, GRIP), None, "over the content, not a strip");
        // Physical (1400, 180) is client (50, 40) of doc-1 at scale 2: before its one tab's center.
        assert_eq!(slot_at(p(1400.0, 180.0), &wins, None, None, GRIP), Some(slot("doc-1", 1, 0)));
        assert_eq!(slot_at(p(1600.0, 180.0), &wins, None, None, GRIP), Some(slot("doc-1", 1, 1)));
        assert_eq!(slot_at(p(3000.0, 40.0), &wins, None, None, GRIP), None, "outside every window");
        let mut above = doc_win();
        (above.label, above.x, above.y) = ("doc-2".into(), 1000.0, 0.0);
        assert_eq!(slot_at(p(1100.0, 40.0), &[main_win(), above.clone()], None, None, GRIP), Some(slot("main", 1, 2)), "main is dragging, so it is on top");
        assert_eq!(slot_at(p(1100.0, 40.0), &[above, main_win()], None, None, GRIP), None, "doc-2 is dragging: its content, above its strip");
        assert_eq!(slot_at(p(100.0, 40.0), &wins, Some("main"), None, GRIP), None, "the window following the cursor is never a target");
    }

    #[test]
    fn a_tab_stays_in_its_strip_until_it_is_pulled_detach_px_above_or_below_it() {
        let wins = [main_win()];
        let a = slot("main", 1, 1);
        // Main's first strip spans y 32..66.
        assert_eq!(slot_at(p(100.0, 66.0 + 29.0), &wins, None, Some(&a), GRIP), Some(slot("main", 1, 1)));
        assert_eq!(slot_at(p(100.0, 3.0), &wins, None, Some(&a), GRIP), Some(slot("main", 1, 1)), "up into the title bar");
        assert_eq!(slot_at(p(500.0, 66.0 + 31.0), &wins, None, Some(&a), GRIP), None);
        assert_eq!(slot_at(p(100.0, 66.0 + 29.0), &wins, None, None, GRIP), None, "only the strip it is in holds it");
        assert_eq!(slot_at(p(1250.0, 40.0), &wins, None, Some(&a), GRIP), None, "sideways out of the strip");
    }

    fn claim(s: &mut Session, label: &str) -> Vec<Effect> {
        s.ready(label).expect("the following window")
    }

    fn to(label: &str, pane: u64, index: usize) -> To {
        To::Slot(slot(label, pane, index))
    }

    fn into(label: &str) -> To {
        To::Window { label: label.into() }
    }

    fn slid(label: &str, pane: u64, x: f64) -> Effect {
        Effect::Slide(label.into(), Some(Slide { pane, x }))
    }

    #[test]
    fn in_its_own_strip_a_neighbour_changes_sides_once_the_dragged_tabs_near_edge_passes_its_center() {
        // Tabs 100 wide, centers 60, 160, 260; the middle one is dragged, grabbed at its center.
        let s = Strip { held: Some(1), ..strip(1, 32.0, 400.0, &[(10.0, 110.0), (110.0, 210.0), (210.0, 310.0)], 300.0) };
        assert_eq!(index_in(&s, 160.0, GRIP), 1, "where it is");
        assert_eq!(index_in(&s, 205.0, GRIP), 1, "its right edge (255) short of the next center");
        assert_eq!(index_in(&s, 215.0, GRIP), 3, "past it (265): after it, counting itself");
        assert_eq!(index_in(&s, 111.0, GRIP), 1, "its left edge (61) short of the previous center");
        assert_eq!(index_in(&s, 109.0, GRIP), 0, "past it (59): before it");
        let other = strip(1, 32.0, 400.0, &[(10.0, 110.0), (110.0, 210.0)], 300.0);
        assert_eq!(index_in(&other, 105.0, GRIP), 1, "another strip: before the first center past its own center");
        assert_eq!(index_in(&other, 165.0, GRIP), 2);
        assert_eq!(index_in(&strip(2, 0.0, 400.0, &[], 300.0), 165.0, GRIP), 0, "an empty strip takes the tab first");
    }

    #[test]
    fn over_another_windows_strip_the_tab_moves_there_at_once_and_out_again_into_a_window_of_its_own() {
        let mut s = from_main();
        assert_eq!(s.step(p(170.0, 45.0)), vec![slid("main", 1, 120.0)], "along its own strip it follows the cursor");
        assert_eq!(s.step(p(105.0, 45.0)), vec![Effect::Drop("main".into(), to("main", 1, 0)), slid("main", 1, 55.0)], "past the first tab's center");
        assert_eq!(s.step(p(106.0, 45.0)), vec![slid("main", 1, 56.0)], "moved once");
        assert_eq!(
            s.step(p(1400.0, 180.0)),
            vec![Effect::Drop("main".into(), to("doc-1", 1, 0)), Effect::Slide("main".into(), None)],
            "doc-1's strip: the tab goes there"
        );
        assert_eq!(s.step(p(1600.0, 180.0)), vec![], "one move at a time");
        assert_eq!(s.held_by("main"), vec![], "only the window it went to confirms");
        assert_eq!(s.held_by("doc-1"), vec![Effect::Drop("doc-1".into(), to("doc-1", 1, 1)), slid("doc-1", 1, 100.0)], "then it catches up");
        assert_eq!(s.step(p(1610.0, 180.0)), vec![slid("doc-1", 1, 105.0)], "the same slot");
        assert_eq!(s.step(p(1400.0, 600.0)), vec![Effect::Tear("doc-1".into()), Effect::Slide("doc-1".into(), None)], "off every strip: doc-1 tears it off");
        s.floated("doc-2".into(), 1.0);
        assert_eq!(s.step(p(1410.0, 600.0)), vec![], "until it has loaded it may not exist: a move would be lost");
        assert_eq!(
            claim(&mut s, "doc-2"),
            vec![Effect::Move("doc-2".into(), pos(1354, 581)), Effect::Show("doc-2".into())],
            "under the cursor where the tab was grabbed"
        );
        assert_eq!(s.ready("doc-1"), None, "another window shows itself");
        assert_eq!(s.step(p(100.0, 40.0)), vec![Effect::Hide("doc-2".into()), Effect::Drop("doc-2".into(), to("main", 1, 0))], "back over main's strip");
        assert_eq!(s.held_by("main"), vec![slid("main", 1, 50.0)], "already where the cursor is");
        assert_eq!(
            s.step(p(100.0, 300.0)),
            vec![Effect::Drop("main".into(), into("doc-2")), Effect::Slide("main".into(), None)],
            "off again: back into its window, kept hidden"
        );
        assert_eq!(s.held_by("doc-2"), vec![Effect::Move("doc-2".into(), pos(44, 281)), Effect::Show("doc-2".into())]);
        assert_eq!(s.release(false), vec![Effect::Focus("doc-2".into()), Effect::End], "it stays where it is");
        assert_eq!(s.step(p(0.0, 0.0)), vec![]);
        assert_eq!(s.ready("doc-2"), None, "done: a later doc-2 is a window of its own");
    }

    #[test]
    fn a_release_while_a_window_is_getting_the_tab_ends_the_drag_once_it_has_it() {
        let mut s = from_main();
        s.step(p(1400.0, 180.0));
        assert_eq!(s.release(false), vec![], "doc-1 has not confirmed");
        assert_eq!(s.held_by("doc-1"), vec![Effect::Focus("doc-1".into()), Effect::End]);

        let mut s = from_main();
        assert_eq!(s.step(p(1250.0, 300.0)), vec![Effect::Tear("main".into())]);
        assert_eq!(s.release(false), vec![], "the tab is on its way to a window not created yet");
        s.floated("doc-2".into(), 1.0);
        assert_eq!(
            claim(&mut s, "doc-2"),
            vec![Effect::Move("doc-2".into(), pos(1194, 281)), Effect::Show("doc-2".into()), Effect::Focus("doc-2".into()), Effect::End]
        );

        let mut s = from_main();
        s.step(p(1400.0, 180.0));
        s.release(false);
        assert_eq!(s.give_up(), vec![Effect::End], "a window that never confirms does not hold the drag open");
        assert_eq!(s.held_by("doc-1"), vec![]);
    }

    #[test]
    fn escape_puts_the_tab_back_where_it_started() {
        let mut s = from_main();
        s.step(p(105.0, 45.0));
        s.strips(Geom { strips: vec![Strip { held: Some(0), ..strip(1, 32.0, 1200.0, &[(10.0, 110.0), (110.0, 210.0)], 354.0) }], ..main_win() });
        assert_eq!(
            s.release(true),
            vec![Effect::Drop("main".into(), to("main", 1, 2)), Effect::Focus("main".into()), Effect::End],
            "back along its strip: a move counts the tab itself"
        );

        let mut s = from_main();
        s.step(p(1250.0, 300.0));
        s.floated("doc-2".into(), 1.0);
        claim(&mut s, "doc-2");
        s.step(p(1400.0, 180.0));
        s.held_by("doc-1");
        assert_eq!(s.release(true), vec![Effect::Drop("doc-1".into(), to("main", 1, 1))], "from doc-1 back to its slot in main");
        assert_eq!(s.held_by("main"), vec![Effect::Focus("main".into()), Effect::End]);
        assert_eq!(s.release(false), vec![], "once");

        let mut s = from_main();
        s.step(p(1250.0, 300.0));
        s.floated("doc-2".into(), 1.0);
        claim(&mut s, "doc-2");
        assert_eq!(s.release(true), vec![Effect::Hide("doc-2".into()), Effect::Drop("doc-2".into(), to("main", 1, 1))], "from its own window");
        assert_eq!(s.held_by("main"), vec![Effect::Focus("main".into()), Effect::End]);
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
    fn in_a_window_split_into_panes_another_pane_is_marked_and_the_tab_comes_out_only_outside_it() {
        let mut s = from_main();
        // Pane 1's body spans y 66..420, pane 2's 454..800, both x 0..1200.
        assert_eq!(s.step(p(600.0, 200.0)), vec![], "its own pane's center: where it is");
        assert_eq!(s.step(p(300.0, 430.0)), vec![Effect::Over("main".into(), over(2, 0))], "another pane's strip is marked, not moved to");
        assert_eq!(s.step(p(600.0, 600.0)), vec![Effect::Over("main".into(), over_body(2, Zone::Center))], "the other pane's body");
        assert_eq!(s.step(p(100.0, 600.0)), vec![Effect::Over("main".into(), over_body(2, Zone::Left))]);
        assert_eq!(s.step(p(600.0, 380.0)), vec![Effect::Over("main".into(), over_body(1, Zone::Bottom))], "its own pane's edge");
        assert_eq!(s.step(p(600.0, 200.0)), vec![Effect::Over("main".into(), None)]);
        assert_eq!(s.release(false), vec![Effect::Focus("main".into()), Effect::End], "dropped on its own pane's center: it stays");
        let mut s = from_main();
        s.step(p(1100.0, 600.0));
        assert_eq!(s.release(false), vec![Effect::Drop("main".into(), To::Slot(zone("main", 2, Zone::Right))), Effect::End]);
        let mut s = from_main();
        s.step(p(600.0, 600.0));
        assert_eq!(s.release(true), vec![Effect::Focus("main".into()), Effect::End], "Escape over a body: it never left its slot");
        let mut s = from_main();
        s.step(p(600.0, 600.0));
        assert_eq!(s.step(p(1250.0, 300.0)), vec![Effect::Over("main".into(), None), Effect::Tear("main".into())], "out of the window");
        s.floated("doc-2".into(), 1.0);
        claim(&mut s, "doc-2");
        assert_eq!(s.step(p(600.0, 600.0)), vec![Effect::Move("doc-2".into(), pos(544, 581))], "torn off: a body is no target, the window follows");
        let one = Geom { strips: vec![Strip { held: Some(1), ..strip(1, 32.0, 1200.0, &[(10.0, 110.0), (110.0, 210.0)], 734.0) }], ..main_win() };
        let mut s = Session::new(1, one, (1, 1), GRIP, p(160.0, 40.0), None);
        assert_eq!(s.step(p(170.0, 300.0)), vec![Effect::Tear("main".into())], "one pane: as soon as it is off the strip");
    }

    #[test]
    fn released_over_another_panes_strip_in_its_own_window_the_tab_moves_there() {
        let mut s = from_main();
        s.step(p(170.0, 300.0));
        assert_eq!(s.step(p(300.0, 430.0)), vec![Effect::Over("main".into(), over(2, 0))], "the empty pane's strip marks its slot");
        assert_eq!(s.release(false), vec![Effect::Drop("main".into(), to("main", 2, 0)), Effect::End]);
    }

    #[test]
    fn a_window_dragged_by_its_only_tab_follows_the_cursor_gives_the_tab_to_a_strip_and_escape_brings_both_back() {
        let mut d = doc_win();
        (d.x, d.y, d.scale) = (500.0, 500.0, 1.0);
        let mut s = Session::new(1, d, (1, 0), GRIP, p(560.0, 549.0), Some(pos(500, 500)));
        s.strips(main_win());
        assert_eq!(s.step(p(560.0, 549.0)), vec![], "its own strip is under the cursor, but it is the window that moves");
        assert_eq!(s.step(p(600.0, 600.0)), vec![Effect::Move("doc-1".into(), pos(540, 551))]);
        assert_eq!(s.step(p(100.0, 40.0)), vec![Effect::Hide("doc-1".into()), Effect::Drop("doc-1".into(), to("main", 1, 1))]);
        s.held_by("main");
        assert_eq!(s.release(true), vec![Effect::Drop("main".into(), into("doc-1"))], "Escape: the tab goes back to its window");
        assert_eq!(
            s.held_by("doc-1"),
            vec![Effect::Move("doc-1".into(), pos(500, 500)), Effect::Show("doc-1".into()), Effect::Focus("doc-1".into()), Effect::End]
        );

        let mut s = Session::new(1, doc_win(), (1, 0), GRIP, p(1400.0, 180.0), Some(pos(1300, 100)));
        s.strips(main_win());
        s.step(p(100.0, 40.0));
        s.held_by("main");
        assert_eq!(s.release(false), vec![Effect::Focus("main".into()), Effect::End], "doc-1 is left empty and closes when the drag ends");
    }

    #[test]
    fn the_ui_reports_plain_numbers() {
        let g: Geom = serde_json::from_str(
            r#"{"label":"x","x":-1920,"y":0.5,"width":800,"height":600,"scale":1.25,"strips":[{"pane":3,"x":0,"y":32,"width":800,"height":34,"tabs":[[6,107.5]],"held":0,"body":{"x":0,"y":66,"width":800,"height":534}}]}"#,
        )
        .unwrap();
        assert_eq!((g.x, g.strips[0].pane, g.strips[0].tabs.clone(), g.strips[0].held), (-1920.0, 3, vec![(6.0, 107.5)], Some(0)));
        let g: Geom = serde_json::from_str(r#"{"x":0,"y":0,"width":8,"height":6,"scale":1,"strips":[{"pane":1,"x":0,"y":0,"width":8,"height":3,"tabs":[],"held":null,"body":{"x":0,"y":3,"width":8,"height":3}}]}"#).unwrap();
        assert_eq!(g.strips[0].held, None, "a strip without the dragged tab");
        assert_eq!(serde_json::to_value(Over { pane: 1, at: At::Index(2) }).unwrap(), json!({ "pane": 1, "index": 2 }));
        assert_eq!(serde_json::to_value(over_body(2, Zone::Left)).unwrap(), json!({ "pane": 2, "zone": "left" }));
        assert_eq!(serde_json::to_value(Slide { pane: 1, x: 120.0 }).unwrap(), json!({ "pane": 1, "x": 120.0 }));
        assert_eq!(serde_json::to_value(To::Slot(zone("main", 2, Zone::Center))).unwrap(), json!({ "label": "main", "pane": 2, "zone": "center" }));
        assert_eq!(serde_json::to_value(to("main", 1, 0)).unwrap(), json!({ "label": "main", "pane": 1, "index": 0 }));
        assert_eq!(serde_json::to_value(into("doc-2")).unwrap(), json!({ "label": "doc-2" }), "the following window's focused pane");
    }
}
