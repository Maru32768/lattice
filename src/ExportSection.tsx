import { useEffect, useState } from "react";
import { api, type GroupRow } from "./api";
import { SetRow } from "./SetRow";
import { useT } from "./i18n";

export function ExportSection() {
  const t = useT();
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [groups, setGroups] = useState<GroupRow[]>([]);
  /** Export only this group's articles; null for the whole library. */
  const [group, setGroup] = useState<number | null>(null);
  useEffect(() => { api.listGroups().then(setGroups).catch((e) => setError(String(e))); }, []);

  async function exportJson() {
    setError(null);
    setStatus(t("exportSection.exporting"));
    try {
      setStatus(t("exportSection.exported", { x: await api.exportJson(group) }));
    } catch (e) {
      setStatus(null);
      setError(String(e));
    }
  }

  return (
    <>
      <div className="grp">
        <SetRow title={t("exportSection.json")}
          desc={t.rich("exportSection.jsonDesc", { code: <code>exports</code> })}>
          {groups.length > 0 && (
            <select className="select" value={group ?? ""} onChange={(e) => setGroup(e.target.value ? Number(e.target.value) : null)} aria-label={t("exportSection.scope")}>
              <option value="">{t("common.allArticles")}</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{t("exportSection.group", { name: g.name })}</option>)}
            </select>
          )}
          <button className="btn" onClick={exportJson}>{t("exportSection.export")}</button>
        </SetRow>
      </div>
      {status && <p role="status" className="msg">{status}</p>}
      {error && <p role="alert" className="msg error-text">{t.msg(error)}</p>}
    </>
  );
}
