import { useState } from "react";
import { DndContext, closestCenter, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { api, type FolderRow } from "../api";
import { SortableRow, rowDndText, useRowSensors } from "../ui/SortableRow";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Icon } from "../ui/Icon";
import { useT } from "../i18n";

/** The Feeds screen's folder list (H25): create, rename, reorder and delete feed folders. */
export function FeedFoldersCard({ folders, onChanged, onError }: { folders: FolderRow[]; onChanged: () => void; onError: (e: unknown) => void }) {
  const t = useT();
  const [name, setName] = useState("");
  const [deleting, setDeleting] = useState<FolderRow | null>(null);
  const sensors = useRowSensors();

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
    if (value.trim() && value.trim() !== f.name) {
      void act(() => api.renameFeedFolder(f.id, value.trim()));
    }
  };
  const drop = ({ active, over }: DragEndEvent) => {
    const ids = folders.map((x) => x.id);
    const [from, to] = [ids.indexOf(Number(active.id)), over ? ids.indexOf(Number(over.id)) : -1];
    if (from >= 0 && to >= 0 && from !== to) {
      void act(() => api.reorderFeedFolders(arrayMove(ids, from, to)));
    }
  };

  return (
    <section className="card folders" aria-label={t("feedsView.folders")}>
      <form
        className="line"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) {
            void act(() => api.createFeedFolder(name.trim())).then((ok) => ok && setName(""));
          }
        }}
      >
        <h2>{t("feedsView.folders")}</h2>
        <input
          className="input sm"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("nav.folderName")}
          aria-label={t("nav.folderName")}
          maxLength={100}
        />
        <button type="submit" className="btn sm" disabled={!name.trim()}>
          <Icon name="plus" size="sm" />
          {t("feedsView.newFolder")}
        </button>
      </form>
      {folders.length === 0 && <p className="muted">{t("feedsView.noFolders")}</p>}
      {folders.length > 0 && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={drop} accessibility={rowDndText(t)}>
          <SortableContext items={folders.map((f) => f.id)} strategy={verticalListSortingStrategy}>
            <ul>
              {folders.map((f) => (
                <SortableRow key={`${f.id}:${f.name}`} id={f.id} as="li" label={t("feedsView.dragFolder", { name: f.name })}>
                  {(grip) => (
                    <>
                      {grip}
                      <Icon name="folder" />
                      <input
                        className="input sm"
                        defaultValue={f.name}
                        aria-label={t("feedsView.folderNameOf", { name: f.name })}
                        maxLength={100}
                        onBlur={(e) => rename(f, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.currentTarget.blur();
                          }
                          if (e.key === "Escape") {
                            e.currentTarget.value = f.name;
                            e.currentTarget.blur();
                          }
                        }}
                      />
                      <span className="muted">{t("feedsView.folderFeeds", { n: f.feeds })}</span>
                      <button className="btn sm ghost" onClick={() => setDeleting(f)} aria-label={t("feedsView.deleteFolderOf", { name: f.name })}>
                        {t("common.delete")}
                      </button>
                    </>
                  )}
                </SortableRow>
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}
      {deleting && (
        <ConfirmDialog
          title={t("nav.deleteFolder", { name: deleting.name })}
          confirm={t("common.delete")}
          onConfirm={() => {
            const f = deleting;
            setDeleting(null);
            void act(() => api.deleteFeedFolder(f.id));
          }}
          onCancel={() => setDeleting(null)}
        >
          <p>{t("nav.deleteFolderDesc")}</p>
        </ConfirmDialog>
      )}
    </section>
  );
}
