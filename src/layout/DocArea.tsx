import { Fragment, useContext, useEffect, useEffectEvent, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { MIN_SIZE, activate, close, closePane, dropOn, focusedPane, move, panes, resize, split, tabById, type Dir, type Id, type Layout, type Node, type Pane, type Tab } from "./layout";
import { TabStrip, type DropTarget, type TabDrag, type TabLabel, type WindowAction } from "./TabStrip";
import { TAB_DRAG_DROP, TAB_DRAG_END, TAB_DRAG_OVER, TAB_DRAG_START, TAB_DRAG_TEAR, measure, type Incoming, type Over, type Slot, type ZoneTarget } from "./tabDrag";
import { tabDrag } from "../api";
import { CoverContext } from "../ui/Popover";
import { Favicon } from "../ui/Favicon";
import { useT } from "../i18n";
import { topStrips } from "./chrome";
import { WindowControls, dragWindow } from "../app/TitleBar";

type Update = (f: (l: Layout) => Layout) => void;

/**
 * Drag handle between two children of a split (the pane splitters' look and keys). Sets child
 * `i` to the fraction the pointer asks for; the next child takes the difference.
 */
function SplitHandle({ dir, size, onSize }: { dir: Dir; size: number; onSize: (size: number) => void }) {
  const t = useT();
  const [drag, setDrag] = useState<{ at: number; size: number; len: number } | null>(null);
  const row = dir === "row";
  const onMove = useEffectEvent((d: { at: number; size: number; len: number }, e: MouseEvent) => onSize(d.size + ((row ? e.clientX : e.clientY) - d.at) / d.len));
  useEffect(() => {
    if (!drag) return;
    const moveM = (e: MouseEvent) => onMove(drag, e);
    const up = () => setDrag(null);
    window.addEventListener("mousemove", moveM);
    window.addEventListener("mouseup", up);
    window.addEventListener("blur", up);
    return () => {
      window.removeEventListener("mousemove", moveM);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("blur", up);
    };
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

function NodeView({ n, layout, onLayout, labelOf, renderPane, onNew, windowAction, drop, body, dragging, onDrag, onDrop, index, title }: {
  n: Node;
  layout: Layout;
  onLayout: Update;
  labelOf: (t: Tab) => TabLabel;
  renderPane: (p: Pane) => React.ReactNode;
  onNew: (pane: Id) => void;
  windowAction: WindowAction;
  drop: Incoming | null;
  /** The pane body a drag is over, and which zone of it. */
  body: ZoneTarget | null;
  dragging: Id | null;
  onDrag: (d: TabDrag) => void;
  onDrop: () => void;
  /** Reading-order number of the first pane in this node, for the panes' labels. */
  index: number;
  /** A pop-out's title bar: these strips (H19). */
  title: ReturnType<typeof topStrips> | null;
}) {
  const t = useT();
  if (n.kind === "split") {
    const firsts = [index];
    for (const c of n.children) firsts.push(firsts[firsts.length - 1] + panes(c).length);
    return (
      <div className={`split ${n.dir === "row" ? "across" : "down"}`}>
        {n.children.map((c, i) => {
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
                <NodeView n={c} layout={layout} onLayout={onLayout} labelOf={labelOf} renderPane={renderPane} onNew={onNew} windowAction={windowAction} drop={drop} body={body} dragging={dragging} onDrag={onDrag} onDrop={onDrop} index={firsts[i]} title={title} />
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
      <TabStrip pane={n} multi={multi} labelOf={labelOf} drop={drop} dragging={dragging} windowAction={windowAction}
        onActivate={(t) => onLayout((l) => activate(l, t))} onClose={(t) => onLayout((l) => close(l, t))} onNew={() => onNew(n.id)}
        onSplit={(dir) => onLayout((l) => split(l, n.id, dir))} onClosePane={() => onLayout((l) => closePane(l, n.id))}
        onDrag={onDrag} onDrop={onDrop} onTitleDrag={title?.top.has(n.id) ? dragWindow : undefined} end={title?.corner === n.id && <WindowControls />} />
      {renderPane(n)}
      {/* Over the page stills that stand in for the webviews during a drag. */}
      {body?.pane === n.id && <div className={`drop-zone ${body.zone}`} aria-hidden />}
    </section>
  );
}

/** This window's tab drag: the tab, and whether this window follows the cursor with it (its only tab). */
interface Own {
  tab: Id;
  alone: boolean;
}

/**
 * The document area: the layout tree as nested flex boxes with drag handles, a tab strip over each
 * pane. Tab drags across windows run in the backend (design-review §26): this window reports its
 * strips while any window drags, draws the slot it is told, and does what it is told with the tab.
 */
export function DocArea({ layout, onLayout, labelOf, renderPane, onNew, windowAction, movable, onSend, onTear }: {
  layout: Layout;
  onLayout: Update;
  labelOf: (t: Tab) => TabLabel;
  renderPane: (p: Pane) => React.ReactNode;
  /** The pane's + button: a new tab in that pane. */
  onNew: (pane: Id) => void;
  /** The strip's button that moves the active tab to another window (out of main, or back to it). */
  windowAction: WindowAction;
  /** A document window: dragged by its only tab, the window itself follows the cursor. */
  movable: boolean;
  /** The tab goes to window `label`, at slot `at` of its strips. */
  onSend: (tab: Id, label: string, at: DropTarget) => void;
  /** The tab was pulled off every strip: it leaves for a new document window, which the drag places. */
  onTear: (tab: Id) => void;
}) {
  const [drop, setDrop] = useState<Over | null>(null);
  const [ghost, setGhost] = useState<TabDrag | null>(null);
  const [own, setOwnState] = useState<Own | null>(null);
  // Read by the pointer moves that come before the next render.
  const ownRef = useRef<Own | null>(null);
  const setOwn = (o: Own | null) => setOwnState((ownRef.current = o));
  /** Some window is dragging a tab: this one reports its strips, again whenever its tabs change. */
  const [reporting, setReporting] = useState(false);
  const cover = useContext(CoverContext);
  const uncover = useRef<(() => void) | null>(null);
  const me = getCurrentWindow().label;

  /** The drag is over: the marker, the ghost and the page stills go. */
  function finish() {
    uncover.current?.();
    uncover.current = null;
    setOwn(null);
    setGhost(null);
    setDrop(null);
    setReporting(false);
  }

  /** Where the drag ended, told to the window holding the tab: this window's dragged tab, or a torn-off window's only one. */
  function dropped(to: Slot) {
    const all = panes(layout.root).flatMap((p) => p.tabs);
    const tab = ownRef.current?.tab ?? (all.length === 1 ? all[0].id : null);
    if (tab == null) return;
    // A pane body is a target only in the window dragging the tab.
    if ("zone" in to) onLayout((l) => (to.label === me ? dropOn(l, tab, to.pane, to.zone) : l));
    else if (to.label === me) onLayout((l) => move(l, tab, to.pane, to.index));
    else onSend(tab, to.label, { pane: to.pane, index: to.index });
  }

  const onEnd = useEffectEvent(finish);
  const onDropped = useEffectEvent(dropped);
  const onTorn = useEffectEvent(() => ownRef.current && onTear(ownRef.current.tab));
  useEffect(() => {
    const win = getCurrentWindow();
    const subs = [
      listen(TAB_DRAG_START, () => {
        setDrop(null);
        setReporting(true);
      }),
      listen(TAB_DRAG_END, () => onEnd()),
      win.listen<Over | null>(TAB_DRAG_OVER, (e) => setDrop(e.payload)),
      win.listen(TAB_DRAG_TEAR, () => onTorn()),
      win.listen<Slot>(TAB_DRAG_DROP, (e) => onDropped(e.payload)),
    ];
    return () => subs.forEach((s) => void s.then((f) => f()));
  }, []);

  useEffect(() => {
    if (!reporting) return;
    void getCurrentWindow().innerPosition().then((p) => tabDrag.strips(measure(me, p))).catch(() => {});
  // oxlint-disable-next-line react/exhaustive-effect-dependencies -- measure reads the strips from the DOM, which follows the layout
  }, [reporting, layout, me]);

  // Escape puts the tab back (on Windows the backend sees the key too); it is the drag's, not the app's.
  useEffect(() => {
    if (!own) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      void tabDrag.release(true).catch(() => {});
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [own]);

  function drag(d: TabDrag) {
    let o = ownRef.current;
    if (!o) {
      const hit = tabById(layout, d.tab);
      if (!hit) return;
      o = { tab: d.tab, alone: movable && panes(layout.root).flatMap((p) => p.tabs).length === 1 };
      setOwn(o);
      // The page webviews are drawn above this document: a still of each stands in so the ghost stays visible.
      if (!o.alone) uncover.current = cover(new DOMRect(0, 0, window.innerWidth, window.innerHeight));
      const start = { tab: labelOf(hit.tab), pane: hit.pane.id, index: hit.pane.tabs.indexOf(hit.tab), alone: o.alone };
      void getCurrentWindow().innerPosition().then((p) => tabDrag.start({ ...start, geom: measure(me, p) })).catch(() => finish());
    }
    // A window that follows the cursor carries its tab along: no ghost.
    if (!o.alone) setGhost(d);
  }

  const ghostTab = ghost && tabById(layout, ghost.tab)?.tab;
  const ghostLabel = ghostTab && labelOf(ghostTab);
  return (
    <div className={`doc-area${layout.root.kind === "split" ? " multi" : ""}`}>
      <NodeView n={layout.root} layout={layout} onLayout={onLayout} labelOf={labelOf} renderPane={renderPane} onNew={onNew} windowAction={windowAction}
        drop={drop && "index" in drop ? drop : null} body={drop && "zone" in drop ? drop : null} dragging={own && !own.alone ? own.tab : null} onDrag={drag} onDrop={() => void tabDrag.release(false).catch(() => {})} index={0}
        title={movable ? topStrips(layout.root) : null} />
      {ghost && ghostTab && ghostLabel && (
        <div className="tab-ghost" aria-hidden style={{ left: ghost.x - ghost.dx, top: ghost.y - ghost.dy }}>
          <Favicon domain={ghostLabel.domain} feed={ghostTab.kind === "page" ? undefined : ghostLabel.feed} />
          <span className="tab-t">{ghostLabel.title}</span>
        </div>
      )}
    </div>
  );
}
