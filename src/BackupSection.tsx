import { useEffect, useState } from "react";
import { api, type Settings } from "./api";
import { SetRow } from "./SetRow";

export function BackupSection() {
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
      setStatus(`バックアップを作成しました: ${b.path}`);
      if (b.warning) setError(b.warning);
    } catch (e) {
      setError(String(e));
    }
  }

  async function saveKeep() {
    setError(null);
    try {
      await api.setBackupKeep(keep);
      setStatus(`ローカルのバックアップを新しい ${keep} 世代まで残します`);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <>
      <div className="grp">
        <SetRow title="ローカルバックアップ" desc={<>保存先: <code>{settings?.backup_dir}</code></>}>
          <button className="btn" onClick={backup}>今すぐバックアップ</button>
        </SetRow>
        <SetRow title="残す世代数" htmlFor="backup-keep"
          desc={<>バックアップを作るたびに、新しいものから指定した世代数だけ残して古い <code>lattice-*.db</code> を削除します。日数では消さないので、しばらく使わなくても消えません。</>}>
          <input id="backup-keep" className="input sm num" type="number" min={1} max={1000} value={keep} onChange={(e) => setKeep(Number(e.target.value))} />
          <button className="btn" onClick={saveKeep}>保存</button>
        </SetRow>
      </div>
      {status && <p role="status" className="msg">{status}</p>}
      {error && <p role="alert" className="msg error-text">{error}</p>}
    </>
  );
}
