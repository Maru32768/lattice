import { useState } from "react";
import { api, type FolderRow } from "./api";
import { moved } from "./feedFolders";
import { ConfirmDialog } from "./ConfirmDialog";
import { Icon } from "./Icon";
import { useT } from "./i18n";

/** The Feeds screen's folder list (H25): create, rename, reorder and delete feed folders. */
export function FeedFoldersCard({ folders, onChanged, onError }: {
  folders: FolderRow[];
  onChanged: () => void;
  onError: (e: unknown) => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [deleting, setDeleting] = useState<FolderRow | null>(null);

  /** Whether the task succeeded; the list reloads either way. */
  async function act(task: () => Promise<unknown>): Promise<boolean> {
    let ok = true;
    try {
      await task();
    } catch (e) {
      onError(e);
      ok = false;
    }
    onChanged();
    return ok;
  }
  const rename = (f: FolderRow, value: string) => {
    if (value.trim() && value.trim() !== f.name) void act(() => api.renameFeedFolder(f.id, value.trim()));
  };
  const move = (f: FolderRow, d: -1 | 1) => act(() => api.reorderFeedFolders(moved(folders.map((x) => x.id), f.id, d)));

  return (
    <section className="card folders" aria-label={t("feedsView.folders")}>
      <form className="line" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void act(() => api.createFeedFolder(name.trim())).then((ok) => ok && setName("")); }}>
        <h2>{t("feedsView.folders")}</h2>
        <input className="input sm" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("nav.folderName")} aria-label={t("nav.folderName")} maxLength={100} />
        <button type="submit" className="btn sm" disabled={!name.trim()}><Icon name="plus" size="sm" />{t("feedsView.newFolder")}</button>
      </form>
      {folders.length === 0 && <p className="muted">{t("feedsView.noFolders")}</p>}
      {folders.length > 0 && (
        <ul>
          {folders.map((f, i) => (
            <li key={`${f.id}:${f.name}`}>
              <Icon name="folder" />
              <input className="input sm" defaultValue={f.name} aria-label={t("feedsView.folderNameOf", { name: f.name })} maxLength={100}
                onBlur={(e) => rename(f, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") { e.currentTarget.value = f.name; e.currentTarget.blur(); }
                }} />
              <span className="muted">{t("feedsView.folderFeeds", { n: f.feeds })}</span>
              <button className="ib" onClick={() => move(f, -1)} disabled={i === 0} aria-label={t("feedsView.folderUp", { name: f.name })}><Icon name="up" size="sm" /></button>
              <button className="ib" onClick={() => move(f, 1)} disabled={i === folders.length - 1} aria-label={t("feedsView.folderDown", { name: f.name })}><Icon name="down" size="sm" /></button>
              <button className="btn sm ghost" onClick={() => setDeleting(f)} aria-label={t("feedsView.deleteFolderOf", { name: f.name })}>{t("common.delete")}</button>
            </li>
          ))}
        </ul>
      )}
      {deleting && (
        <ConfirmDialog title={t("nav.deleteFolder", { name: deleting.name })} confirm={t("common.delete")}
          onConfirm={() => { const f = deleting; setDeleting(null); void act(() => api.deleteFeedFolder(f.id)); }} onCancel={() => setDeleting(null)}>
          <p>{t("nav.deleteFolderDesc")}</p>
        </ConfirmDialog>
      )}
    </section>
  );
}
