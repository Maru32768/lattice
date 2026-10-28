import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { DndContext, MeasuringStrategy, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy, type SortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { FeedRow, FolderRow } from "../api";
import { feedName } from "./groups";
import { feedDrop, feedGroups, feedStep, folderDrop, folderTree, loadCollapsed, moved, saveCollapsed, type FeedOrder, type NavRow } from "../feeds/feedFolders";
import { useBindings } from "../lib/keys";
import { keyOf } from "../lib/keyname";
import { sameScope, type Scope } from "./library";
import { Menu, type MenuItem } from "../ui/Popover";
import { Icon } from "../ui/Icon";
import { Favicon, hostOf } from "../ui/Favicon";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { useT } from "../i18n";

const FEEDS_SHOWN = 5;
const rowKey = (r: NavRow) => (r.kind === "loose" ? "loose" : `${r.kind}:${r.id}`);
/**
 * Silent: the moved row shows where it went, and Alt+↑ / ↓ is the keyboard's way. Its live region
 * goes to a node outside the page, so the sidebar adds no second empty `status` to every screen.
 */
const QUIET = {
  announcements: { onDragStart: () => "", onDragOver: () => "", onDragEnd: () => "", onDragCancel: () => "" },
  container: document.createElement("div"),
};
// A feed held over a folder (or the drop target) goes into it: the rows stay put and the folder lights up.
const strategy =
  (rows: NavRow[]): SortingStrategy =>
  (args) =>
    rows[args.activeIndex]?.kind === "feed" && rows[args.overIndex]?.kind !== "feed" ? null : verticalListSortingStrategy(args);

/** A draggable row; the pointer drags it once it moves a few pixels, so a click stays a click. */
function useRow(r: NavRow) {
  const { setNodeRef, listeners, transform, transition, isDragging, isOver, active } = useSortable({ id: rowKey(r) });
  const style: CSSProperties = { transform: CSS.Translate.toString(transform), transition };
  const into = isOver && String(active?.id).startsWith("feed:") && r.kind !== "feed";
  return { ref: setNodeRef, listeners, style, cls: `${isDragging ? " dragging" : ""}${into ? " drop" : ""}` };
}
type Drag = ReturnType<typeof useRow>["listeners"];

function FeedItem({ f, on, unread, onScope, onKey }: { f: FeedRow; on: boolean; unread: number; onScope: () => void; onKey: (e: KeyboardEvent) => void }) {
  const { ref, style, listeners, cls } = useRow({ kind: "feed", id: f.id, folder: f.folder_id });
  return (
    <button
      ref={ref}
      style={style}
      {...listeners}
      className={`ni sub${on ? " on" : ""}${cls}`}
      onClick={onScope}
      onKeyDown={onKey}
      aria-current={on ? "page" : undefined}
      data-feed={f.id}
    >
      <Favicon domain={hostOf(f.site_url ?? f.url)} feed={f.id} />
      <span className="label">{feedName(f)}</span>
      <span className="n">{unread.toLocaleString()}</span>
    </button>
  );
}

function FolderHeader({ id, children }: { id: number; children: (drag: Drag) => ReactNode }) {
  const { ref, style, listeners, cls } = useRow({ kind: "folder", id });
  return (
    <div ref={ref} style={style} className={`ni-row${cls}`}>
      {children(listeners)}
    </div>
  );
}

function LooseTarget() {
  const t = useT();
  const { ref, style, cls } = useRow({ kind: "loose" });
  return (
    <div ref={ref} style={style} className={`ni sub dim nav-drop${cls}`}>
      {t("nav.outOfFolders")}
    </div>
  );
}

/**
 * The sidebar's feeds (H25): each folder a collapsible scope summing its feeds' unread articles,
 * its feeds under it, then the feeds in no folder. ⋯ and the context menu rename or delete a folder.
 */
export function NavFolders({
  feeds,
  folders,
  unread,
  scope,
  onScope,
  onRename,
  onDelete,
  onMenu,
  onReorderFeeds,
  onReorderFolders,
}: {
  feeds: FeedRow[];
  folders: FolderRow[];
  unread: ReadonlyMap<number | null, number>;
  scope: Scope | null;
  onScope: (s: Scope) => void;
  onRename: (id: number, name: string) => void;
  onDelete: (id: number) => void;
  /** Sets the items of the app's context menu, which opens on the folder row's contextmenu event. */
  onMenu: (items: MenuItem[]) => void;
  /** A feed dragged or moved with Alt+↑ / ↓ (H26): its group's new order. */
  onReorderFeeds: (order: FeedOrder) => void;
  onReorderFolders: (ids: number[]) => void;
}) {
  const t = useT();
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [allFeeds, setAllFeeds] = useState(false);
  const [naming, setNaming] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<FolderRow | null>(null);
  const [draggingFeed, setDraggingFeed] = useState(false);
  const bindings = useBindings();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  /** The row to focus again once a keyboard move has changed the rows' order (`from`). */
  const refocus = useRef<{ row: string; from: string } | null>(null);
  const tree = folderTree(feeds, folders, unread);
  const loose = allFeeds ? tree.loose : tree.loose.slice(0, FEEDS_SHOWN);
  const groups = feedGroups(tree);
  const rows: NavRow[] = [
    ...tree.folders.flatMap(({ folder: f, feeds: mine }): NavRow[] => [
      { kind: "folder", id: f.id },
      ...(collapsed.has(f.id) || naming === f.id ? [] : mine.map((x): NavRow => ({ kind: "feed", id: x.id, folder: f.id }))),
    ]),
    ...loose.map((x): NavRow => ({ kind: "feed", id: x.id, folder: null })),
    ...(draggingFeed && loose.length === 0 ? [{ kind: "loose" } as const] : []),
  ];
  const keys = rows.map(rowKey);
  const rowOrder = keys.join(" ");
  useEffect(() => {
    if (!refocus.current || refocus.current.from === rowOrder) {
      return;
    }
    document.querySelector<HTMLElement>(refocus.current.row)?.focus();
    refocus.current = null;
  }, [rowOrder]);

  const drop = ({ active, over }: DragEndEvent) => {
    setDraggingFeed(false);
    const [from, to] = [keys.indexOf(String(active.id)), over ? keys.indexOf(String(over.id)) : -1];
    if (from < 0 || to < 0) {
      return;
    }
    const order = feedDrop(rows, groups, from, to);
    if (order) {
      return onReorderFeeds(order);
    }
    const ids = folderDrop(rows, from, to);
    if (ids) {
      onReorderFolders(ids);
    }
  };
  const toggle = (id: number) => {
    const next = new Set(collapsed);
    if (!next.delete(id)) {
      next.add(id);
    }
    saveCollapsed(next);
    setCollapsed(next);
  };
  /** Alt+↑ / ↓ (the `moveUp` / `moveDown` keys) on a focused row. */
  const step = (e: KeyboardEvent): -1 | 1 | 0 => {
    const k = keyOf(e.nativeEvent);
    const d = k && bindings.moveUp.includes(k) ? -1 : k && bindings.moveDown.includes(k) ? 1 : 0;
    if (d) {
      e.preventDefault();
      e.stopPropagation();
    }
    return d;
  };
  const stepFeed = (f: FeedRow) => (e: KeyboardEvent) => {
    const d = step(e);
    const order = d ? feedStep(groups, f.id, d) : null;
    if (!order) {
      return;
    }
    // Keep the moved feed in view: open its new folder, or show all the feeds in none.
    if (order.folder != null && collapsed.has(order.folder)) {
      toggle(order.folder);
    }
    if (order.folder == null && order.ids.indexOf(f.id) >= FEEDS_SHOWN) {
      setAllFeeds(true);
    }
    refocus.current = { row: `[data-feed="${f.id}"]`, from: rowOrder };
    onReorderFeeds(order);
  };
  const stepFolder = (f: FolderRow) => (e: KeyboardEvent) => {
    const d = step(e);
    const ids = folders.map((x) => x.id);
    const next = d ? moved(ids, f.id, d) : ids;
    if (next === ids) {
      return;
    }
    refocus.current = { row: `[data-folder="${f.id}"]`, from: rowOrder };
    onReorderFolders(next);
  };

  const menu = (f: FolderRow): MenuItem[] => [
    { label: t("nav.renameFolder"), onSelect: () => setNaming(f.id) },
    { label: t("common.delete"), danger: true, onSelect: () => setDeleting(f) },
  ];
  const isOn = (s: Scope) => !!scope && sameScope(scope, s);
  const feedItem = (f: FeedRow) => (
    <FeedItem
      key={f.id}
      f={f}
      on={isOn({ kind: "feed", id: f.id })}
      unread={unread.get(f.id) ?? 0}
      onScope={() => onScope({ kind: "feed", id: f.id })}
      onKey={stepFeed(f)}
    />
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      accessibility={QUIET}
      onDragStart={({ active }) => setDraggingFeed(String(active.id).startsWith("feed:"))}
      onDragEnd={drop}
      onDragCancel={() => setDraggingFeed(false)}
    >
      <SortableContext items={keys} strategy={strategy(rows)}>
        {tree.folders.map(({ folder: f, feeds: mine, unread: n, total }) => {
          const open = !collapsed.has(f.id);
          if (naming === f.id) {
            const commit = (value: string) => {
              setNaming(null);
              if (value.trim() && value.trim() !== f.name) {
                onRename(f.id, value.trim());
              }
            };
            return (
              <FolderHeader key={f.id} id={f.id}>
                {() => (
                  <form
                    className="ni-edit"
                    onSubmit={(e) => {
                      e.preventDefault();
                      commit(new FormData(e.currentTarget).get("name") as string);
                    }}
                  >
                    <input
                      name="name"
                      className="input sm"
                      defaultValue={f.name}
                      autoFocus
                      aria-label={t("nav.folderName")}
                      onBlur={() => setNaming(null)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          e.preventDefault();
                          e.stopPropagation();
                          setNaming(null);
                        }
                      }}
                    />
                  </form>
                )}
              </FolderHeader>
            );
          }
          const s: Scope = { kind: "folder", id: f.id };
          return (
            <div key={f.id} className="nav-folder">
              <FolderHeader id={f.id}>
                {(drag) => (
                  <>
                    <button className="ib ni-fold" onClick={() => toggle(f.id)} aria-expanded={open} aria-label={t("nav.toggleFolder", { name: f.name })}>
                      <Icon name={open ? "down" : "right"} size="sm" />
                    </button>
                    <button
                      {...drag}
                      className={`ni sub${isOn(s) ? " on" : ""}`}
                      onClick={() => onScope(s)}
                      aria-current={isOn(s) ? "page" : undefined}
                      data-folder={f.id}
                      title={t("nav.folderCount", { unread: n, total })}
                      onContextMenu={() => onMenu(menu(f))}
                      onKeyDown={stepFolder(f)}
                    >
                      <Icon name="folder" />
                      <span className="label">{f.name}</span>
                      <span className="n">{n.toLocaleString()}</span>
                    </button>
                    <Menu
                      className="ib ni-menu"
                      label={t("nav.folderMenu", { name: f.name })}
                      inPane={false}
                      trigger={<Icon name="more" size="sm" />}
                      items={menu(f)}
                    />
                  </>
                )}
              </FolderHeader>
              {open && mine.length > 0 && <div className="nav-sub">{mine.map(feedItem)}</div>}
            </div>
          );
        })}
        {loose.map(feedItem)}
        {draggingFeed && loose.length === 0 && <LooseTarget />}
      </SortableContext>
      {tree.loose.length > FEEDS_SHOWN && (
        <button className="ni sub dim" onClick={() => setAllFeeds((v) => !v)} aria-expanded={allFeeds}>
          {allFeeds ? t("nav.collapse") : t("nav.allFeeds")}
        </button>
      )}
      {deleting && (
        <ConfirmDialog
          title={t("nav.deleteFolder", { name: deleting.name })}
          confirm={t("common.delete")}
          onConfirm={() => {
            onDelete(deleting.id);
            setDeleting(null);
          }}
          onCancel={() => setDeleting(null)}
        >
          <p>{t("nav.deleteFolderDesc")}</p>
        </ConfirmDialog>
      )}
    </DndContext>
  );
}
