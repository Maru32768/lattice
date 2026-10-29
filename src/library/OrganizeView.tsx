import { useState } from "react";
import type { GroupRow } from "../api";
import { GenreSettings } from "./GenreSettings";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { useT, type PlainKey } from "../i18n";
import "../ui/manage.css";

export type OrganizeTab = "groups" | "genres";

const TABS: [OrganizeTab, PlainKey, PlainKey][] = [
  ["groups", "nav.groups", "organizeView.groupsLead"],
  ["genres", "organizeView.genres", "organizeView.genresLead"],
];

/** The library's own categories, one tab each, every one listed with its count and managed the same way. Feeds keep their own screen. */
export function OrganizeView({
  tab,
  onTab,
  groups,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  onChanged,
}: {
  tab: OrganizeTab;
  onTab: (t: OrganizeTab) => void;
  groups: GroupRow[];
  onCreateGroup: (name: string) => Promise<unknown>;
  onRenameGroup: (id: number, name: string) => Promise<unknown>;
  onDeleteGroup: (id: number) => Promise<void>;
  onChanged: () => void;
}) {
  const t = useT();
  const lead = TABS.find(([id]) => id === tab)![2];
  return (
    <main className="manage organize">
      <div className="wrap">
        {/* The lead sits under the header row, so the tabs stay put whatever its length. */}
        <header className="head">
          <h1>{t("organizeView.title")}</h1>
          <div className="acts">
            <div className="seg" role="group" aria-label={t("organizeView.kind")}>
              {TABS.map(([id, label]) => (
                <button key={id} className={tab === id ? "on" : ""} aria-pressed={tab === id} onClick={() => onTab(id)}>
                  {t(label)}
                </button>
              ))}
            </div>
          </div>
        </header>
        <p className="sub organize-lead">{t(lead)}</p>
        {tab === "groups" ? (
          <Groups groups={groups} onCreate={onCreateGroup} onRename={onRenameGroup} onDelete={onDeleteGroup} />
        ) : (
          <GenreSettings onChanged={onChanged} />
        )}
      </div>
    </main>
  );
}

/** Groups with counts: create, rename, delete (the articles stay). Laid out like the genres. */
function Groups({
  groups,
  onCreate,
  onRename,
  onDelete,
}: {
  groups: GroupRow[];
  onCreate: (name: string) => Promise<unknown>;
  onRename: (id: number, name: string) => Promise<unknown>;
  onDelete: (id: number) => Promise<void>;
}) {
  const t = useT();
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [adding, setAdding] = useState("");
  const [deleting, setDeleting] = useState<GroupRow | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const taken = (name: string, except?: number) => groups.find((g) => g.id !== except && g.name.toLowerCase() === name.toLowerCase());

  async function act(task: Promise<unknown>, done: string) {
    setError(null);
    setStatus(null);
    try {
      await task;
      setStatus(done);
      setDrafts({});
    } catch (e) {
      setError(String(e));
    }
  }

  function row(g: GroupRow) {
    const to = (drafts[g.id] ?? g.name).trim();
    const clash = taken(to, g.id);
    const changed = to !== "" && to !== g.name && !clash;
    return (
      <form
        key={g.id}
        className="set"
        onSubmit={(e) => {
          e.preventDefault();
          if (changed) {
            void act(onRename(g.id, to), t("genreSettings.renamed", { name: g.name, to }));
          }
        }}
      >
        <div className="h">
          <input
            className="input sm"
            value={drafts[g.id] ?? g.name}
            aria-label={t("genreSettings.newName", { name: g.name })}
            onChange={(e) => setDrafts((d) => ({ ...d, [g.id]: e.target.value }))}
          />
        </div>
        <div className="d">
          {t("genreSettings.count", { count: g.count })}
          {clash && t("organizeView.groupExists", { name: clash.name })}
        </div>
        <div className="ctl">
          <button type="submit" className="btn" disabled={!changed}>
            {t("genreSettings.rename")}
          </button>
          <button type="button" className="btn ghost" onClick={() => setDeleting(g)} aria-label={t("genreSettings.deleteLabel", { name: g.name })}>
            {t("common.delete")}
          </button>
        </div>
      </form>
    );
  }

  const name = adding.trim();
  const existing = taken(name);
  return (
    <>
      <form
        className="set"
        onSubmit={(e) => {
          e.preventDefault();
          if (name && !existing) {
            setAdding("");
            void act(onCreate(name), t("genreSettings.added", { name }));
          }
        }}
      >
        <div className="h">
          <input
            className="input sm"
            value={adding}
            placeholder={t("organizeView.addGroupPlaceholder")}
            aria-label={t("nav.createGroup")}
            onChange={(e) => setAdding(e.target.value)}
          />
        </div>
        <div className="d">{existing ? t("genreSettings.exists", { name: existing.name }) : t("organizeView.addGroupDesc")}</div>
        <div className="ctl">
          <button type="submit" className="btn" disabled={!name || !!existing}>
            {t("genreSettings.add")}
          </button>
        </div>
      </form>
      {groups.length === 0 && <p className="muted">{t("organizeView.noGroups")}</p>}
      <div className="grp">{groups.map(row)}</div>
      {status && (
        <p role="status" className="msg">
          {status}
        </p>
      )}
      {error && (
        <p className="msg error-text" role="alert">
          {t.msg(error)}
        </p>
      )}
      {deleting && (
        <ConfirmDialog
          title={t("nav.deleteGroup", { name: deleting.name })}
          confirm={t("common.delete")}
          onConfirm={() => {
            const g = deleting;
            setDeleting(null);
            void act(onDelete(g.id), t("genreSettings.deleted", { name: g.name }));
          }}
          onCancel={() => setDeleting(null)}
        >
          <p>{t("nav.deleteGroupDesc")}</p>
        </ConfirmDialog>
      )}
    </>
  );
}
