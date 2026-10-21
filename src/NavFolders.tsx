import { useState } from "react";
import type { FeedRow, FolderRow } from "./api";
import { feedName } from "./groups";
import { folderTree, loadCollapsed, saveCollapsed } from "./feedFolders";
import { sameScope, type Scope } from "./library";
import { Menu, type MenuItem } from "./Popover";
import { Icon } from "./Icon";
import { Favicon, hostOf } from "./Favicon";
import { ConfirmDialog } from "./ConfirmDialog";
import { useT } from "./i18n";

const FEEDS_SHOWN = 5;

/**
 * The sidebar's feeds (H25): each folder a collapsible scope summing its feeds' unread articles,
 * its feeds under it, then the feeds in no folder. ⋯ and the context menu rename or delete a folder.
 */
export function NavFolders({ feeds, folders, unread, scope, onScope, onRename, onDelete, onMenu }: {
  feeds: FeedRow[];
  folders: FolderRow[];
  unread: ReadonlyMap<number | null, number>;
  scope: Scope | null;
  onScope: (s: Scope) => void;
  onRename: (id: number, name: string) => void;
  onDelete: (id: number) => void;
  /** Sets the items of the app's context menu, which opens on the folder row's contextmenu event. */
  onMenu: (items: MenuItem[]) => void;
}) {
  const t = useT();
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [allFeeds, setAllFeeds] = useState(false);
  const [naming, setNaming] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<FolderRow | null>(null);
  const tree = folderTree(feeds, folders, unread);
  const loose = allFeeds ? tree.loose : tree.loose.slice(0, FEEDS_SHOWN);

  const toggle = (id: number) => setCollapsed((c) => {
    const next = new Set(c);
    if (!next.delete(id)) next.add(id);
    saveCollapsed(next);
    return next;
  });
  const menu = (f: FolderRow): MenuItem[] => [
    { label: t("nav.renameFolder"), onSelect: () => setNaming(f.id) },
    { label: t("common.delete"), danger: true, onSelect: () => setDeleting(f) },
  ];
  const isOn = (s: Scope) => !!scope && sameScope(scope, s);
  const feedItem = (f: FeedRow) => {
    const s: Scope = { kind: "feed", id: f.id };
    return (
      <button key={f.id} className={`ni sub${isOn(s) ? " on" : ""}`} onClick={() => onScope(s)} aria-current={isOn(s) ? "page" : undefined}>
        <Favicon domain={hostOf(f.site_url ?? f.url)} feed={f.id} /><span className="label">{feedName(f)}</span><span className="n">{(unread.get(f.id) ?? 0).toLocaleString()}</span>
      </button>
    );
  };

  return (
    <>
      {tree.folders.map(({ folder: f, feeds: mine, unread: n, total }) => {
        const open = !collapsed.has(f.id);
        if (naming === f.id) {
          const commit = (value: string) => {
            setNaming(null);
            if (value.trim() && value.trim() !== f.name) onRename(f.id, value.trim());
          };
          return (
            <form key={f.id} className="ni-edit" onSubmit={(e) => { e.preventDefault(); commit(new FormData(e.currentTarget).get("name") as string); }}>
              <input name="name" className="input sm" defaultValue={f.name} autoFocus aria-label={t("nav.folderName")} onBlur={() => setNaming(null)}
                onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setNaming(null); } }} />
            </form>
          );
        }
        const s: Scope = { kind: "folder", id: f.id };
        return (
          <div key={f.id} className="nav-folder">
            <div className="ni-row">
              <button className="ib ni-fold" onClick={() => toggle(f.id)} aria-expanded={open} aria-label={t("nav.toggleFolder", { name: f.name })}>
                <Icon name={open ? "down" : "right"} size="sm" />
              </button>
              <button className={`ni sub${isOn(s) ? " on" : ""}`} onClick={() => onScope(s)} aria-current={isOn(s) ? "page" : undefined}
                data-folder={f.id} title={t("nav.folderCount", { unread: n, total })} onContextMenu={() => onMenu(menu(f))}>
                <Icon name="folder" /><span className="label">{f.name}</span><span className="n">{n.toLocaleString()}</span>
              </button>
              <Menu className="ib ni-menu" label={t("nav.folderMenu", { name: f.name })} inPane={false} trigger={<Icon name="more" size="sm" />} items={menu(f)} />
            </div>
            {open && mine.length > 0 && <div className="nav-sub">{mine.map(feedItem)}</div>}
          </div>
        );
      })}
      {loose.map(feedItem)}
      {tree.loose.length > FEEDS_SHOWN && (
        <button className="ni sub dim" onClick={() => setAllFeeds((v) => !v)} aria-expanded={allFeeds}>
          {allFeeds ? t("nav.collapse") : t("nav.allFeeds")}
        </button>
      )}
      {deleting && (
        <ConfirmDialog title={t("nav.deleteFolder", { name: deleting.name })} confirm={t("common.delete")}
          onConfirm={() => { onDelete(deleting.id); setDeleting(null); }} onCancel={() => setDeleting(null)}>
          <p>{t("nav.deleteFolderDesc")}</p>
        </ConfirmDialog>
      )}
    </>
  );
}
