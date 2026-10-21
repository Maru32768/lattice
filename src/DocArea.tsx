import { Fragment, useEffect, useState } from "react";
import { MIN_SIZE, activate, close, closePane, focusedPane, move, panes, resize, split, type Dir, type Id, type Layout, type Node, type Pane, type Tab } from "./layout";
import { TabStrip, type DropTarget, type TabLabel, type WindowAction } from "./TabStrip";
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

function NodeView({ n, layout, onLayout, labelOf, renderPane, onNew, windowAction, drop, onDrag, index }: {
  n: Node;
  layout: Layout;
  onLayout: Update;
  labelOf: (t: Tab) => TabLabel;
  renderPane: (p: Pane) => React.ReactNode;
  onNew: (pane: Id) => void;
  windowAction: WindowAction;
  drop: DropTarget | null;
  onDrag: (t: DropTarget | null) => void;
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
                <NodeView n={c} layout={layout} onLayout={onLayout} labelOf={labelOf} renderPane={renderPane} onNew={onNew} windowAction={windowAction} drop={drop} onDrag={onDrag} index={first} />
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
        onDrag={onDrag} onDrop={(t, to) => onLayout((l) => move(l, t, to.pane, to.index))} />
      {renderPane(n)}
    </section>
  );
}

/** The document area: the layout tree as nested flex boxes with drag handles, a tab strip over each pane. */
export function DocArea({ layout, onLayout, labelOf, renderPane, onNew, windowAction }: {
  layout: Layout;
  onLayout: Update;
  labelOf: (t: Tab) => TabLabel;
  renderPane: (p: Pane) => React.ReactNode;
  /** The pane's + button (or Ctrl+T): the palette, whose pick opens in a new tab. */
  onNew: (pane: Id) => void;
  /** The strip's button that moves the active tab to another window (out of main, or back to it). */
  windowAction: WindowAction;
}) {
  const [drop, setDrop] = useState<DropTarget | null>(null);
  return (
    <div className={`doc-area${layout.root.kind === "split" ? " multi" : ""}`}>
      <NodeView n={layout.root} layout={layout} onLayout={onLayout} labelOf={labelOf} renderPane={renderPane} onNew={onNew} windowAction={windowAction} drop={drop} onDrag={setDrop} index={0} />
    </div>
  );
}
