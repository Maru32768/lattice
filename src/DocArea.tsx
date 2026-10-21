import { Fragment, useContext, useEffect, useRef, useState } from "react";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { MIN_SIZE, activate, close, closePane, focusedPane, move, panes, resize, split, tabById, type Dir, type Id, type Layout, type Node, type Pane, type Tab } from "./layout";
import { TabStrip, type DropTarget, type TabDrag, type TabLabel, type WindowAction } from "./TabStrip";
import { TAB_DRAG_OVER, TAB_DRAG_START, TAB_STRIPS, dropAt, measure, targetIn, toScreen, type Drop, type WindowGeom } from "./tabDrag";
import { CoverContext } from "./Popover";
import { Favicon } from "./Favicon";
import { useT } from "./i18n";

type Update = (f: (l: Layout) => Layout) => void;

/**
 * Drag handle between two children of a split (the pane splitters' look and keys). Sets child
 * `i` to the fraction the pointer asks for; the next child takes the difference.
 */
function SplitHandle({ dir, size, onSize }: { dir: Dir; size: number; onSize: (size: number) => void }) {
  const t = useT();
  const [drag, setDrag] = useState<{ at: number; size: number; len: number } | null>(null);
  const row = dir === "row";
  useEffect(() => {
    if (!drag) return;
    const moveM = (e: MouseEvent) => onSize(drag.size + ((row ? e.clientX : e.clientY) - drag.at) / drag.len);
    const up = () => setDrag(null);
    window.addEventListener("mousemove", moveM);
    window.addEventListener("mouseup", up);
    window.addEventListener("blur", up);
    return () => {
      window.removeEventListener("mousemove", moveM);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("blur", up);
    };
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- listeners live for one drag, during which dir and onSize do not change
  }, [drag]);

  function down(e: React.MouseEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const r = e.currentTarget.parentElement!.getBoundingClientRect();
    // Counted on mousedown, as the pane splitters do: a double-click evens the two out.
    if (e.detail === 2) onSize(NaN);
    else setDrag({ at: row ? e.clientX : e.clientY, size, len: row ? r.width : r.height });
  }

  function keys(e: React.KeyboardEvent) {
    const d = row ? { ArrowLeft: -1, ArrowRight: 1 }[e.key] : { ArrowUp: -1, ArrowDown: 1 }[e.key];
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    onSize(size + d * (e.shiftKey ? 0.08 : 0.02));
  }

  const label = row ? t("docArea.paneWidth") : t("docArea.paneHeight");
  return (
    <div className={`splitter at-pane${row ? "" : " h"}${drag ? " on" : ""}`} role="separator" aria-orientation={row ? "vertical" : "horizontal"} aria-label={label}
      aria-valuenow={Math.round(size * 100)} aria-valuemin={Math.round(MIN_SIZE * 100)} aria-valuemax={Math.round((1 - MIN_SIZE) * 100)} tabIndex={0}
      title={t("docArea.handle", { label, x: row ? "← →" : "↑ ↓" })} onMouseDown={down} onKeyDown={keys}>
      <span />
    </div>
  );
}

function NodeView({ n, layout, onLayout, labelOf, renderPane, onNew, windowAction, drop, onDrag, onDrop, index }: {
  n: Node;
  layout: Layout;
  onLayout: Update;
  labelOf: (t: Tab) => TabLabel;
  renderPane: (p: Pane) => React.ReactNode;
  onNew: (pane: Id) => void;
  windowAction: WindowAction;
  drop: DropTarget | null;
  onDrag: (d: TabDrag) => void;
  onDrop: (d: TabDrag | null) => void;
  /** Reading-order number of the first pane in this node, for the panes' labels. */
  index: number;
}) {
  const t = useT();
  if (n.kind === "split") {
    let at = index;
    return (
      <div className={`split ${n.dir === "row" ? "across" : "down"}`}>
        {n.children.map((c, i) => {
          const first = at;
          at += panes(c).length;
          const size = n.sizes[i - 1];
          return (
            <Fragment key={c.id}>
              {i > 0 && (
                <SplitHandle dir={n.dir} size={size}
                  onSize={(s) => onLayout((l) => {
                    const even = (size + n.sizes[i]) / 2;
                    return resize(l, n.id, i - 1, Number.isNaN(s) ? even : s);
                  })} />
              )}
              <div className="cell" style={{ flex: `${n.sizes[i]} 1 0px` }}>
                <NodeView n={c} layout={layout} onLayout={onLayout} labelOf={labelOf} renderPane={renderPane} onNew={onNew} windowAction={windowAction} drop={drop} onDrag={onDrag} onDrop={onDrop} index={first} />
              </div>
            </Fragment>
          );
        })}
      </div>
    );
  }
  const focused = focusedPane(layout).id === n.id;
  const multi = layout.root.kind === "split";
  return (
    <section className={`dpane${focused ? " focused" : ""}`} data-pane="doc" data-pane-id={n.id} aria-label={t("docArea.document", { x: index + 1 })}>
      <TabStrip pane={n} multi={multi} labelOf={labelOf} drop={drop} windowAction={windowAction}
        onActivate={(t) => onLayout((l) => activate(l, t))} onClose={(t) => onLayout((l) => close(l, t))} onNew={() => onNew(n.id)}
        onSplit={(dir) => onLayout((l) => split(l, n.id, dir))} onClosePane={() => onLayout((l) => closePane(l, n.id))}
        onDrag={onDrag} onDrop={onDrop} />
      {renderPane(n)}
    </section>
  );
}

/** A tab drag in flight: the strips of every window (as they report them), and the window whose slot is marked now. */
interface Session {
  tab: Id;
  geoms: Map<string, WindowGeom>;
  over: { label: string; key: string } | null;
  uncover: () => void;
}

/** The document area: the layout tree as nested flex boxes with drag handles, a tab strip over each pane. */
export function DocArea({ layout, onLayout, labelOf, renderPane, onNew, windowAction, onMoveOut }: {
  layout: Layout;
  onLayout: Update;
  labelOf: (t: Tab) => TabLabel;
  renderPane: (p: Pane) => React.ReactNode;
  /** The pane's + button (or Ctrl+T): the palette, whose pick opens in a new tab. */
  onNew: (pane: Id) => void;
  /** The strip's button that moves the active tab to another window (out of main, or back to it). */
  windowAction: WindowAction;
  /** A tab was dropped on another window's strip, or away from every strip (a new window there). */
  onMoveOut: (tab: Id, to: Drop) => void;
}) {
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const [ghost, setGhost] = useState<TabDrag | null>(null);
  const cover = useContext(CoverContext);
  const session = useRef<Session | null>(null);
  const me = getCurrentWindow().label;

  // Any window may be dragging: answer its request for this window's strips, and mark the slot it says.
  useEffect(() => {
    const win = getCurrentWindow();
    const learn = (g: WindowGeom) => void session.current?.geoms.set(g.label, g);
    const subs = [
      listen<{ source: string }>(TAB_DRAG_START, (e) => void win.innerPosition().then((p) => {
        const g = measure(me, p);
        return e.payload.source === me ? learn(g) : emitTo(e.payload.source, TAB_STRIPS, g);
      }).catch(() => {})),
      win.listen<WindowGeom>(TAB_STRIPS, (e) => learn(e.payload)),
      win.listen<DropTarget | null>(TAB_DRAG_OVER, (e) => setDrop(e.payload)),
    ];
    return () => subs.forEach((s) => void s.then((f) => f()));
  }, [me]);

  /** Where `d` would land now; the marker goes to the window it is over (this one, or another by event). */
  function resolve(s: Session, d: TabDrag): Drop | null {
    const own = s.geoms.get(me);
    const at = own ? dropAt(toScreen(own, d), s.geoms, me) : null;
    const other = at?.kind === "strip" && at.label !== me ? { label: at.label, key: `${at.pane}:${at.index}` } : null;
    if (s.over && (s.over.label !== other?.label || s.over.key !== other.key)) void emitTo(s.over.label, TAB_DRAG_OVER, null);
    if (other && (s.over?.label !== other.label || s.over.key !== other.key)) void emitTo(other.label, TAB_DRAG_OVER, targetIn(at, other.label));
    s.over = other;
    setDrop(targetIn(at, me));
    return at;
  }

  function drag(d: TabDrag) {
    if (!session.current) {
      // The page webviews are drawn above this document: a still of each stands in so the ghost stays visible.
      session.current = { tab: d.tab, geoms: new Map(), over: null, uncover: cover(new DOMRect(0, 0, window.innerWidth, window.innerHeight)) };
      void emit(TAB_DRAG_START, { source: me });
    }
    setGhost(d);
    resolve(session.current, d);
  }

  function dropTab(d: TabDrag | null) {
    const s = session.current;
    if (!s) return;
    const at = d && resolve(s, d);
    if (s.over) void emitTo(s.over.label, TAB_DRAG_OVER, null);
    s.uncover();
    session.current = null;
    setGhost(null);
    setDrop(null);
    if (!at) return;
    if (at.kind === "strip" && at.label === me) onLayout((l) => move(l, s.tab, at.pane, at.index));
    else onMoveOut(s.tab, at);
  }

  const ghostTab = ghost && tabById(layout, ghost.tab)?.tab;
  const ghostLabel = ghostTab && labelOf(ghostTab);
  return (
    <div className={`doc-area${layout.root.kind === "split" ? " multi" : ""}`}>
      <NodeView n={layout.root} layout={layout} onLayout={onLayout} labelOf={labelOf} renderPane={renderPane} onNew={onNew} windowAction={windowAction} drop={drop} onDrag={drag} onDrop={dropTab} index={0} />
      {ghost && ghostTab && ghostLabel && (
        <div className="tab-ghost" aria-hidden style={{ left: ghost.x - ghost.dx, top: ghost.y - ghost.dy }}>
          <Favicon domain={ghostLabel.domain} feed={ghostTab.kind === "page" ? undefined : ghostLabel.feed} />
          <span className="tab-t">{ghostLabel.title}</span>
        </div>
      )}
    </div>
  );
}
