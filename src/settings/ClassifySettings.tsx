import { useEffect, useState } from "react";
import { SetRow, Switch } from "../ui/SetRow";
import { api } from "../api";
import { useT } from "../i18n";

export function ClassifySettings() {
  const t = useT();
  const [on, setOn] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.autoClassify().then(setOn).catch((e) => setError(String(e))); }, []);

  async function toggle(value: boolean) {
    setOn(value);
    setError(null);
    try {
      await api.setAutoClassify(value);
    } catch (e) {
      setError(String(e));
    }
  }

  async function classifyAll() {
    setError(null);
    try {
      setStatus(t("classifySettings.queued", { x: await api.classifyUnclassified() }));
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="grp">
      <SetRow title={t("classifySettings.auto")} htmlFor="auto-classify"
        desc={t("classifySettings.autoDesc")}>
        <Switch id="auto-classify" checked={on} onChange={toggle} />
      </SetRow>
      <SetRow title={t("classifySettings.unclassified")} desc={t("classifySettings.unclassifiedDesc")}>
        <button className="btn" onClick={classifyAll}>{t("classifySettings.classifyAll")}</button>
      </SetRow>
      {status && <p role="status" className="msg">{status}</p>}
      {error && <p className="msg error-text" role="alert">{t.msg(error)}</p>}
    </div>
  );
}
