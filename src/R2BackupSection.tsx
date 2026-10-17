import { useEffect, useState } from "react";
import { r2, type R2Settings, type R2Status } from "./api";
import { SetRow, Switch } from "./SetRow";

const time = (secs: number) => new Date(secs * 1000).toLocaleString("ja-JP");

/** Settings section for the automatic Cloudflare R2 backup. */
export function R2BackupSection() {
  const [status, setStatus] = useState<R2Status | null>(null);
  const [form, setForm] = useState<R2Settings | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload(resetForm: boolean) {
    const s = await r2.status();
    setStatus(s);
    if (resetForm) {
      setForm({ enabled: s.enabled, account_id: s.account_id, bucket: s.bucket, access_key_id: s.access_key_id, interval_hours: s.interval_hours, keep_generations: s.keep_generations, secret_access_key: "" });
    }
  }

  useEffect(() => {
    reload(true).catch((e) => setError(String(e)));
  }, []);

  // A backup started by the scheduler or the button can take minutes; follow it until it ends.
  useEffect(() => {
    if (!status?.running) return;
    const t = setInterval(() => reload(false).catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [status?.running]);

  async function save() {
    if (!form) return;
    setError(null);
    try {
      await r2.save(form);
      await reload(true);
      setMessage("R2 の設定を保存しました");
    } catch (e) {
      setError(String(e));
    }
  }

  async function clearSecret() {
    setError(null);
    try {
      await r2.clearSecret();
      await reload(true);
      setMessage("Secret Access Key を削除しました（自動バックアップは無効にしました）");
    } catch (e) {
      setError(String(e));
    }
  }

  async function backupNow() {
    setError(null);
    setMessage("R2 にバックアップしています…");
    const poll = setTimeout(() => reload(false).catch(() => {}), 500);
    try {
      setMessage(`R2 にアップロードしました: ${await r2.backupNow()}`);
    } catch (e) {
      setMessage(null);
      setError(String(e));
    } finally {
      clearTimeout(poll);
      await reload(false).catch(() => {});
    }
  }

  if (!form) return error ? <p className="msg error-text" role="alert">{error}</p> : null;
  const edit = (patch: Partial<R2Settings>) => setForm({ ...form, ...patch });
  const text = (id: string, key: "account_id" | "bucket" | "access_key_id", placeholder?: string) => (
    <input id={id} className="input sm mono" value={form[key]} onChange={(e) => edit({ [key]: e.target.value })} placeholder={placeholder} spellCheck={false} />
  );
  return (
    <>
      <div className="grp">
        <SetRow title="自動バックアップ" htmlFor="r2-enabled">
          <Switch id="r2-enabled" checked={form.enabled} onChange={(on) => edit({ enabled: on })} />
        </SetRow>
        <SetRow title="Account ID" htmlFor="r2-account">{text("r2-account", "account_id")}</SetRow>
        <SetRow title="Bucket" htmlFor="r2-bucket">{text("r2-bucket", "bucket", "lattice-backup")}</SetRow>
        <SetRow title="Access Key ID" htmlFor="r2-key">{text("r2-key", "access_key_id")}</SetRow>
        <SetRow title="Secret Access Key" htmlFor="r2-secret">
          <input id="r2-secret" className="input sm" type="password" value={form.secret_access_key ?? ""} onChange={(e) => edit({ secret_access_key: e.target.value })} placeholder={status?.has_secret ? "設定済み（変更するときだけ入力）" : "未設定"} autoComplete="off" />
          <button className="btn ghost" onClick={clearSecret} disabled={!status?.has_secret || status.running} aria-label="Secret Access Key を削除">削除</button>
        </SetRow>
        <SetRow title="間隔（時間）" htmlFor="r2-interval">
          <input id="r2-interval" className="input sm num" type="number" min={1} max={720} value={form.interval_hours} onChange={(e) => edit({ interval_hours: Number(e.target.value) })} />
        </SetRow>
        <SetRow title="残す世代数" htmlFor="r2-keep">
          <input id="r2-keep" className="input sm num" type="number" min={1} max={1000} value={form.keep_generations} onChange={(e) => edit({ keep_generations: Number(e.target.value) })} />
        </SetRow>
      </div>
      <div className="btn-row">
        <button className="btn pri" onClick={save}>保存</button>
        <button className="btn" onClick={backupNow} disabled={status?.running}>今すぐ R2 にバックアップ</button>
      </div>
      <p className="sec-d">
        {status?.running ? "バックアップ中…" : status?.last_success ? `最終バックアップ: ${time(status.last_success)}` : "まだ R2 にバックアップしていません"}
        {status?.last_key && <><br />最新のオブジェクト: <code>{status.last_key}</code></>}
      </p>
      {status?.last_error && <p className="note err">前回の失敗: {status.last_error}</p>}
      {status?.last_prune_error && <p className="note warn">警告: バックアップは成功しましたが、古い世代の削除に失敗しました: {status.last_prune_error}</p>}
      {message && <p role="status" className="msg">{message}</p>}
      {error && <p role="alert" className="msg error-text">{error}</p>}
    </>
  );
}
