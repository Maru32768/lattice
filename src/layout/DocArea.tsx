import { Fragment, useContext, useEffect, useEffectEvent, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  MIN_SIZE,
  activate,
  close,
  closePane,
  dropOn,
  focusedPane,
  move,
  open,
  panes,
  resize,
  split,
  tabById,
  type Dir,
  type Id,
  type Layout,
  type Node,
  type Pane,
  type Tab,
} from "./layout";
import { TabStrip, type DropTarget, type TabDrag, type TabLabel, type WindowAction } from "./TabStrip";
import {
  TAB_DRAG_DROP,
  TAB_DRAG_END,
  TAB_DRAG_OVER,
  TAB_DRAG_SLIDE,
  TAB_DRAG_START,
  TAB_DRAG_TAKE,
  TAB_DRAG_TEAR,
  measure,
  type DragStart,
  type Over,
  type Slide,
  type Slot,
  type Take,
  type ZoneTarget,
} from "./tabDrag";
import { tabDrag } from "../api";
import { CoverContext } from "../ui/Popover";
import { useT } from "../i18n";
import { topStrips } from "./chrome";
import { WindowControls, dragWindow } from "../app/TitleBar";
import { withStarts } from "../lib/runs";

type Update = (f: (l: Layout) => Layout) => void;

/**
 * Drag handle between two children of a split (the pane splitters' look and keys). Sets child
 * `i` to the fraction the pointer asks for; the next child takes the difference.
 */
function SplitHandle({ dir, size, onSize }: { dir: Dir; size: number; onSize: (size: number) => void }) {
  const t = useT();
  const [drag, setDrag] = useState<{ at: number; size: number; len: number } | null>(null);
  const row = dir === "row";
  const onMove = useEffectEvent((d: { at: number; size: number; len: number }, e: MouseEvent) =>
    onSize(d.size + ((row ? e.clientX : e.clientY) - d.at) / d.len),
  );
  useEffect(() => {
    if (!drag) {
      return;
    }
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
    if (e.button !== 0) {
      return;
    }
    e.preventDefault();
    const r = e.currentTarget.parentElement!.getBoundingClientRect();
    // Counted on mousedown, as the pane splitters do: a double-click evens the two out.
    if (e.detail === 2) {
      onSize(NaN);
    } else {
      setDrag({ at: row ? e.clientX : e.clientY, size, len: row ? r.width : r.height });
    }
  }

  function keys(e: React.KeyboardEvent) {
    const d = row ? { ArrowLeft: -1, ArrowRight: 1 }[e.key] : { ArrowUp: -1, ArrowDown: 1 }[e.key];
    if (!d) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    onSize(size + d * (e.shiftKey ? 0.08 : 0.02));
  }

  const label = row ? t("docArea.paneWidth") : t("docArea.paneHeight");
  return (
    <div
      className={`splitter at-pane${row ? "" : " h"}${drag ? " on" : ""}`}
      role="separator"
      aria-orientation={row ? "vertical" : "horizontal"}
      aria-label={label}
      aria-valuenow={Math.round(size * 100)}
      aria-valuemin={Math.round(MIN_SIZE * 100)}
      aria-valuemax={Math.round((1 - MIN_SIZE) * 100)}
      tabIndex={0}
      title={t("docArea.handle", { label, x: row ? "← →" : "↑ ↓" })}
      onMouseDown={down}
      onKeyDown={keys}
    >
      <span />
    </div>
  );
}

function NodeView({
  n,
  layout,
  onLayout,
  labelOf,
  renderPane,
  onNew,
  windowAction,
  drop,
  body,
  held,
  slide,
  onDrag,
  onDrop,
  index,
  title,
}: {
  n: Node;
  layout: Layout;
  onLayout: Update;
  labelOf: (t: Tab) => TabLabel;
  renderPane: (p: Pane) => React.ReactNode;
  onNew: (pane: Id) => void;
  windowAction: WindowAction;
  drop: DropTarget | null;
  /** The pane body a drag is over, and which zone of it. */
  body: ZoneTarget | null;
  /** The dragged tab, when it is in this window. */
  held: Id | null;
  slide: Slide | null;
  onDrag: (d: TabDrag) => void;
  onDrop: () => void;
  /** Reading-order number of the first pane in this node, for the panes' labels. */
  index: number;
  /** A pop-out's title bar: these strips (H19). */
  title: ReturnType<typeof topStrips> | null;
}) {
  const t = useT();
  if (n.kind === "split") {
    // `sizes` has one share per child (layout.ts keeps them together).
    const sizeOf = (i: number) => n.sizes[i] ?? 1 / n.children.length;
    return (
      <div className={`split ${n.dir === "row" ? "across" : "down"}`}>
        {withStarts(n.children, (c) => panes(c).length, index).map(({ item: c, start }, i) => {
          const size = sizeOf(i - 1);
          return (
            <Fragment key={c.id}>
              {i > 0 && (
                <SplitHandle
                  dir={n.dir}
                  size={size}
                  onSize={(s) =>
                    onLayout((l) => {
                      const even = (size + sizeOf(i)) / 2;
                      return resize(l, n.id, i - 1, Number.isNaN(s) ? even : s);
                    })
                  }
                />
              )}
              <div className="cell" style={{ flex: `${sizeOf(i)} 1 0px` }}>
                <NodeView
                  n={c}
                  layout={layout}
                  onLayout={onLayout}
                  labelOf={labelOf}
                  renderPane={renderPane}
                  onNew={onNew}
                  windowAction={windowAction}
                  drop={drop}
                  body={body}
                  held={held}
                  slide={slide}
                  onDrag={onDrag}
                  onDrop={onDrop}
                  index={start}
                  title={title}
                />
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
      <TabStrip
        pane={n}
        multi={multi}
        labelOf={labelOf}
        drop={drop}
        held={held}
        slide={slide?.pane === n.id ? slide.x : null}
        windowAction={windowAction}
        onActivate={(t) => onLayout((l) => activate(l, t))}
        onClose={(t) => onLayout((l) => close(l, t))}
        onNew={() => onNew(n.id)}
        onSplit={(dir) => onLayout((l) => split(l, n.id, dir))}
        onClosePane={() => onLayout((l) => closePane(l, n.id))}
        onDrag={onDrag}
        onDrop={onDrop}
        onTitleDrag={title?.top.has(n.id) ? dragWindow : undefined}
        end={title?.corner === n.id && <WindowControls />}
      />
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
export function DocArea({
  layout,
  onLayout,
  labelOf,
  renderPane,
  onNew,
  windowAction,
  movable,
  onSend,
  onTear,
}: {
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
  /** During a drag the tab goes to window `label`, at slot `at` of its strips or in its focused pane. */
  onSend: (tab: Id, label: string, at?: DropTarget) => void;
  /** The tab was pulled off every strip: it leaves for a new document window, which the drag places. */
  onTear: (tab: Id) => void;
}) {
  const [drop, setDrop] = useState<Over | null>(null);
  const [slide, setSlide] = useState<Slide | null>(null);
  const [own, setOwnState] = useState<Own | null>(null);
  // Read by the pointer moves that come before the next render.
  const ownRef = useRef<Own | null>(null);
  const setOwn = (o: Own | null) => setOwnState((ownRef.current = o));
  /** The dragged tab, when another window sent it here during the drag. */
  const [taken, setTakenState] = useState<Id | null>(null);
  const held = useRef<Id | null>(null);
  const setTaken = (id: Id | null) => setTakenState((held.current = id));
  /** The dragged tab, when it is in this window's strips. */
  const holding = own && !own.alone ? own.tab : taken;
  /** It was sent here and the backend hears so once the layout has it (`tab_drag_held`). */
  const taking = useRef(false);
  /** Some window is dragging a tab: this one reports its strips, again whenever its tabs change. */
  const [reporting, setReporting] = useState(false);
  const cover = useContext(CoverContext);
  const uncover = useRef<(() => void) | null>(null);
  const me = getCurrentWindow().label;

  /** The tab is no longer this window's to drag: the marker and the page stills go. */
  function letGo() {
    uncover.current?.();
    uncover.current = null;
    setOwn(null);
    setSlide(null);
    setDrop(null);
    setTaken(null);
  }

  /** The drag is over. */
  function finish() {
    letGo();
    taking.current = false;
    setReporting(false);
  }

  /** The dragged tab in this window: pressed here, sent here, or a torn-off window's only one. */
  function heldTab(): Id | null {
    const all = panes(layout.root).flatMap((p) => p.tabs);
    const only = all.length === 1 ? all[0] : undefined;
    return ownRef.current?.tab ?? held.current ?? only?.id ?? null;
  }

  /** Where the tab goes, told to the window holding it: a move in this window, else to another one. */
  function dropped(to: Slot) {
    const tab = heldTab();
    if (tab == null) {
      return;
    }
    // A pane body is a target only in the window dragging the tab.
    if ("zone" in to) {
      onLayout((l) => (to.label === me ? dropOn(l, tab, to.pane, to.zone) : l));
    } else if (to.label === me && "index" in to) {
      onLayout((l) => move(l, tab, to.pane, to.index));
    } else {
      letGo();
      onSend(tab, to.label, "index" in to ? { pane: to.pane, index: to.index } : undefined);
    }
  }

  /** The tab leaves for a new document window, which the drag places. */
  function torn() {
    const tab = heldTab();
    if (tab != null) {
      letGo();
      onTear(tab);
    }
  }

  /** Another window sent the dragged tab here: it opens at the slot, its content shown at once. */
  function take({ doc, at }: Take) {
    // `open` gives the new tab the layout's next id.
    setTaken(layout.next);
    onLayout((l) => open(l, doc, "new", at?.pane, at?.index));
    taking.current = true;
  }

  useEffect(() => {
    if (taking.current && held.current != null && tabById(layout, held.current)) {
      taking.current = false;
      void tabDrag.held().catch(() => {});
    }
  }, [layout]);

  const onEnd = useEffectEvent(finish);
  const onDropped = useEffectEvent(dropped);
  const onTorn = useEffectEvent(torn);
  const onTake = useEffectEvent(take);
  // react-doctor-disable-next-line react-doctor/effect-needs-cleanup -- `listen` resolves to the unlisten, which the cleanup calls
  useEffect(() => {
    const win = getCurrentWindow();
    const subs = [
      listen(TAB_DRAG_START, () => {
        setDrop(null);
        setReporting(true);
      }),
      listen(TAB_DRAG_END, () => onEnd()),
      win.listen<Over | null>(TAB_DRAG_OVER, (e) => setDrop(e.payload)),
      win.listen<Slide | null>(TAB_DRAG_SLIDE, (e) => setSlide(e.payload)),
      win.listen(TAB_DRAG_TEAR, () => onTorn()),
      win.listen<Slot>(TAB_DRAG_DROP, (e) => onDropped(e.payload)),
      win.listen<Take>(TAB_DRAG_TAKE, (e) => onTake(e.payload)),
    ];
    return () => subs.forEach((s) => void s.then((f) => f()));
  }, []);

  useEffect(() => {
    if (!reporting) {
      return;
    }
    void getCurrentWindow()
      .innerPosition()
      .then((p) => tabDrag.strips(measure(me, p, holding)))
      .catch(() => {});
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- measure reads the strips from the DOM, which follows the layout
  }, [reporting, layout, me, holding]);

  // Escape puts the tab back (on Windows the backend sees the key too); it is the drag's, not the app's.
  useEffect(() => {
    if (!own) {
      return;
    }
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") {
        return;
      }
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
      if (!hit) {
        return;
      }
      o = { tab: d.tab, alone: movable && panes(layout.root).flatMap((p) => p.tabs).length === 1 };
      setOwn(o);
      // A dragged tab shows its content, as in Chrome.
      onLayout((l) => activate(l, d.tab));
      // The page webviews are drawn above this document: stills stand in so the zones drawn over the panes show.
      if (!o.alone && layout.root.kind === "split") {
        uncover.current = cover(new DOMRect(0, 0, window.innerWidth, window.innerHeight));
      }
      const start: Omit<DragStart, "geom"> = {
        pane: hit.pane.id,
        index: hit.pane.tabs.indexOf(hit.tab),
        alone: o.alone,
        grab: [d.dx, d.dy],
        width: d.w,
      };
      void getCurrentWindow()
        .innerPosition()
        .then((p) => tabDrag.start({ ...start, geom: measure(me, p, d.tab) }))
        .catch(() => finish());
    }
  }

  return (
    <div className={`doc-area${layout.root.kind === "split" ? " multi" : ""}`}>
      <NodeView
        n={layout.root}
        layout={layout}
        onLayout={onLayout}
        labelOf={labelOf}
        renderPane={renderPane}
        onNew={onNew}
        windowAction={windowAction}
        drop={drop && "index" in drop ? drop : null}
        body={drop && "zone" in drop ? drop : null}
        held={holding}
        slide={slide}
        onDrag={drag}
        onDrop={() => void tabDrag.release(false).catch(() => {})}
        index={0}
        title={movable ? topStrips(layout.root) : null}
      />
    </div>
  );
}
