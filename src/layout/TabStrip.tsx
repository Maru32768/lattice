import { useRef } from "react";
import { Favicon } from "../ui/Favicon";
import { Icon, type IconName } from "../ui/Icon";
import type { Dir, Id, Pane, Tab } from "./layout";
import { useT } from "../i18n";
import type { Incoming } from "./tabDrag";

export interface TabLabel {
  title: string;
  domain: string;
  feed?: number | null;
}

/** The strip's window button: 別ウィンドウで開く in the main window, メインウィンドウに戻す in a pop-out (G52). */
export interface WindowAction {
  label: string;
  hint: string;
  icon: IconName;
  onSelect: (tab: Id) => void;
}

/** Where a dragged tab would land: before the `index`-th tab of pane `pane`. */
export interface DropTarget {
  pane: Id;
  index: number;
}

/** A drag in flight: the tab, where the pointer is (CSS px of this window), and the grab offset inside the tab. */
export interface TabDrag {
  tab: Id;
  x: number;
  y: number;
  dx: number;
  dy: number;
}

/** Moves of less than this many pixels are a click. */
const DRAG_PX = 4;

/**
 * One pane's tabs: title and favicon, × (middle-click closes too), drag to reorder, to another
 * pane's strip, to another window or out of every window (the backend runs the drag across
 * windows; see DocArea), + for a new tab, and the pane's split and close buttons.
 */
export function TabStrip({
  pane,
  multi,
  labelOf,
  drop,
  dragging,
  windowAction,
  onActivate,
  onClose,
  onNew,
  onSplit,
  onClosePane,
  onDrag,
  onDrop,
  onTitleDrag,
  end,
}: {
  pane: Pane;
  /** More than one pane: this one can be closed. */
  multi: boolean;
  labelOf: (t: Tab) => TabLabel;
  /** The slot a drag is over: a marker, or the dragged tab itself when it comes from another window. */
  drop: Incoming | null;
  /** This window's tab being dragged (drawn faded). */
  dragging: Id | null;
  windowAction: WindowAction;
  onActivate: (tab: Id) => void;
  onClose: (tab: Id) => void;
  onNew: () => void;
  onSplit: (dir: Dir) => void;
  onClosePane: () => void;
  /** Every pointer move of a drag (the first one starts it). */
  onDrag: (d: TabDrag) => void;
  /** The pointer was released after a drag. */
  onDrop: () => void;
  /** In a pop-out the strip is the title bar (H19): a press on its empty space. */
  onTitleDrag?: (e: React.MouseEvent) => void;
  /** After the strip's buttons: the window controls, on the pop-out's top-right strip. */
  end?: React.ReactNode;
}) {
  const t = useT();
  const press = useRef<(TabDrag & { moved: boolean }) | null>(null);

  function down(e: React.PointerEvent, tab: Id) {
    // A middle press would start Chromium's autoscroll (and then no auxclick comes); see middle.ts.
    if (e.button === 1) {
      return e.preventDefault();
    }
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) {
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    press.current = { tab, x: e.clientX, y: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function moveP(e: React.PointerEvent) {
    const p = press.current;
    if (!p) {
      return;
    }
    if (!p.moved && Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_PX) {
      return;
    }
    p.moved = true;
    p.x = e.clientX;
    p.y = e.clientY;
    onDrag({ ...p });
  }

  function up(e: React.PointerEvent, tab: Id) {
    if (e.button === 1) {
      return onClose(tab);
    }
    const p = press.current;
    press.current = null;
    if (!p) {
      return;
    }
    if (!p.moved) {
      return onActivate(p.tab);
    }
    onDrop();
  }

  // Also after a pointercancel, or when a torn-off tab's new window takes the activation: the backend ends that drag.
  const lost = () => void (press.current = null);

  const here = drop?.pane === pane.id ? drop.index : -1;
  const incoming = here >= 0 && drop?.tab;
  /** Another window's tab, drawn where it would land (it moves only when the drag ends). */
  const arriving = incoming && (
    <div key="incoming" className="tab on incoming" aria-hidden>
      <Favicon domain={incoming.domain} feed={incoming.feed} />
      <span className="tab-t">{incoming.title}</span>
    </div>
  );
  return (
    <div className="tabs" role="tablist" aria-label={t("tabStrip.tabs")} onMouseDown={onTitleDrag}>
      {pane.tabs.flatMap((tab, i) => {
        const { title, domain, feed } = labelOf(tab);
        const on = tab.id === pane.active;
        return [
          here === i && arriving,
          <div
            key={tab.id}
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            title={title}
            data-tab={tab.id}
            className={`tab${on && !incoming ? " on" : ""}${dragging === tab.id ? " dragging" : ""}${here === i && !incoming ? " drop-before" : ""}${here === i + 1 && i === pane.tabs.length - 1 && !incoming ? " drop-after" : ""}`}
            onPointerDown={(e) => down(e, tab.id)}
            onPointerMove={moveP}
            onPointerUp={(e) => up(e, tab.id)}
            onLostPointerCapture={lost}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onActivate(tab.id);
              }
            }}
          >
            {tab.kind === "page" ? <Favicon domain={domain} /> : <Favicon domain={domain} feed={feed} />}
            <span className="tab-t">{title}</span>
            {tab.kind === "page" && tab.translating && (
              <span className="tab-tr" role="status">
                {t("app.translating", { length: tab.translating.done, length2: tab.translating.total })}
              </span>
            )}
            <button
              className="x"
              onClick={() => onClose(tab.id)}
              aria-label={t("tabStrip.closeTitle", { title })}
              title={t("tabStrip.closeHint")}
              tabIndex={-1}
            >
              <Icon name="x" size="sm" />
            </button>
          </div>,
        ];
      })}
      {/* An empty pane (a fresh split) has no tab to draw the marker on. */}
      {here >= pane.tabs.length && (arriving || (!pane.tabs.length && <span className="tab-mark" aria-hidden />))}
      <button className="ib" onClick={onNew} aria-label={t("tabStrip.newTab")} title={t("tabStrip.newTabHint")}>
        <Icon name="plus" />
      </button>
      <span className="grow" />
      <button className="ib" onClick={() => onSplit("row")} aria-label={t("tabStrip.splitRight")} title={t("tabStrip.splitRightHint")}>
        <Icon name="vsplit" />
      </button>
      <button className="ib" onClick={() => onSplit("column")} aria-label={t("tabStrip.splitDown")} title={t("tabStrip.splitDownHint")}>
        <Icon name="hsplit" />
      </button>
      {pane.active != null && (
        <button className="ib" onClick={() => windowAction.onSelect(pane.active!)} aria-label={windowAction.label} title={windowAction.hint}>
          <Icon name={windowAction.icon} />
        </button>
      )}
      {multi && (
        <button className="ib" onClick={onClosePane} aria-label={t("tabStrip.closePane")} title={t("tabStrip.closePane")}>
          <Icon name="x" />
        </button>
      )}
      {end}
    </div>
  );
}
