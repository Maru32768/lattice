import { useState } from "react";
import { api } from "./api";
import { SetRow } from "./SetRow";
import { useT } from "./i18n";

export function ExportSection() {
  const t = useT();
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function exportJson() {
    setError(null);
    setStatus(t("exportSection.exporting"));
    try {
      setStatus(t("exportSection.exported", { x: await api.exportJson() }));
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
          <button className="btn" onClick={exportJson}>{t("exportSection.export")}</button>
        </SetRow>
      </div>
      {status && <p role="status" className="msg">{status}</p>}
      {error && <p role="alert" className="msg error-text">{t.msg(error)}</p>}
    </>
  );
}
