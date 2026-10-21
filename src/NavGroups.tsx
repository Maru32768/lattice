import { useState } from "react";
import type { GroupRow } from "./api";
import { sameScope, type Scope } from "./library";
import { Menu } from "./Popover";
import { Icon } from "./Icon";
import { ConfirmDialog } from "./ConfirmDialog";
import { useT } from "./i18n";

/** The sidebar's グループ section: each group is a scope; + creates one, ⋯ renames or deletes it. */
export function NavGroups({ groups, scope, onScope, onCreate, onRename, onDelete }: {
  groups: GroupRow[];
  scope: Scope | null;
  onScope: (s: Scope) => void;
  onCreate: (name: string) => void;
  onRename: (id: number, name: string) => void;
  onDelete: (id: number) => void;
}) {
  const t = useT();
  /** The group being named: `null` id for a new one. */
  const [naming, setNaming] = useState<{ id: number | null } | null>(null);
  const [deleting, setDeleting] = useState<GroupRow | null>(null);

  const nameField = (g: GroupRow | null) => {
    const commit = (value: string) => {
      setNaming(null);
      const name = value.trim();
      if (!name || name === g?.name) return;
      if (g) onRename(g.id, name);
      else onCreate(name);
    };
    return (
      <form key={g?.id ?? "new"} className="ni-edit" onSubmit={(e) => { e.preventDefault(); commit(new FormData(e.currentTarget).get("name") as string); }}>
        <input name="name" className="input sm" defaultValue={g?.name} autoFocus aria-label={t("nav.groupName")} placeholder={t("nav.groupName")}
          onBlur={() => setNaming(null)}
          onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setNaming(null); } }} />
      </form>
    );
  };

  return (
    <>
      <div className="sec">{t("nav.groups")}<button className="link" onClick={() => setNaming({ id: null })}>{t("nav.newGroup")}</button></div>
      {groups.map((g) => {
        if (naming?.id === g.id) return nameField(g);
        const s: Scope = { kind: "group", id: g.id };
        const on = !!scope && sameScope(scope, s);
        return (
          <div key={g.id} className="ni-row">
            <button className={`ni${on ? " on" : ""}`} onClick={() => onScope(s)} aria-current={on ? "page" : undefined}>
              <Icon name="folder" /><span className="label">{g.name}</span><span className="n">{g.count.toLocaleString()}</span>
            </button>
            <Menu className="ib ni-menu" label={t("nav.groupMenu", { name: g.name })} inPane={false} trigger={<Icon name="more" size="sm" />} items={[
              { label: t("nav.renameGroup"), onSelect: () => setNaming({ id: g.id }) },
              { label: <span className="error-text">{t("common.delete")}</span>, onSelect: () => setDeleting(g) },
            ]} />
          </div>
        );
      })}
      {naming?.id === null && nameField(null)}
      {groups.length === 0 && !naming && (
        <button className="ni dim" onClick={() => setNaming({ id: null })}><Icon name="plus" /><span className="label">{t("nav.createGroup")}</span></button>
      )}
      {deleting && (
        <ConfirmDialog title={t("nav.deleteGroup", { name: deleting.name })} confirm={t("common.delete")}
          onConfirm={() => { onDelete(deleting.id); setDeleting(null); }} onCancel={() => setDeleting(null)}>
          <p>{t("nav.deleteGroupDesc")}</p>
        </ConfirmDialog>
      )}
    </>
  );
}
