import { useEffect, useState } from "react";
import { api, type Settings } from "./api";
import { SetRow } from "./SetRow";
import { useT } from "./i18n";

export function BackupSection() {
  const t = useT();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [keep, setKeep] = useState(30);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.settings().then((s) => { setSettings(s); setKeep(s.backup_keep); }).catch((e) => setError(String(e)));
  }, []);

  async function backup() {
    setError(null);
    try {
      const b = await api.backup();
      setStatus(t("backupSection.created", { path: b.path }));
      if (b.warning) setError(b.warning);
    } catch (e) {
      setError(String(e));
    }
  }

  async function saveKeep() {
    setError(null);
    try {
      await api.setBackupKeep(keep);
      setStatus(t("backupSection.keepSaved", { keep }));
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <>
      <div className="grp">
        <SetRow title={t("backupSection.local")} desc={t.rich("backupSection.location", { path: <code>{settings?.backup_dir}</code> })}>
          <button className="btn" onClick={backup}>{t("backupSection.backUpNow")}</button>
        </SetRow>
        <SetRow title={t("backupSection.keep")} htmlFor="backup-keep"
          desc={<>{t.rich("backupSection.keepDesc", { code: <code>lattice-*.db</code> })}</>}>
          <input id="backup-keep" className="input sm num" type="number" min={1} max={1000} value={keep} onChange={(e) => setKeep(Number(e.target.value))} />
          <button className="btn" onClick={saveKeep}>{t("common.save")}</button>
        </SetRow>
      </div>
      {status && <p role="status" className="msg">{status}</p>}
      {error && <p role="alert" className="msg error-text">{t.msg(error)}</p>}
    </>
  );
}
