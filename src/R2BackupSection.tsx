import { useEffect, useState } from "react";
import { r2, type R2Settings, type R2Status } from "./api";

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

  if (!form) return error ? <p className="error-text" role="alert">{error}</p> : null;
  const edit = (patch: Partial<R2Settings>) => setForm({ ...form, ...patch });
  return (
    <div>
      <h3>Cloudflare R2 への自動バックアップ</h3>
      <div className="fields">
        <label htmlFor="r2-enabled">自動バックアップ</label>
        <input id="r2-enabled" type="checkbox" checked={form.enabled} onChange={(e) => edit({ enabled: e.target.checked })} />
        <label htmlFor="r2-account">Account ID</label>
        <input id="r2-account" value={form.account_id} onChange={(e) => edit({ account_id: e.target.value })} spellCheck={false} />
        <label htmlFor="r2-bucket">Bucket</label>
        <input id="r2-bucket" value={form.bucket} onChange={(e) => edit({ bucket: e.target.value })} placeholder="lattice-backup" spellCheck={false} />
        <label htmlFor="r2-key">Access Key ID</label>
        <input id="r2-key" value={form.access_key_id} onChange={(e) => edit({ access_key_id: e.target.value })} spellCheck={false} />
        <label htmlFor="r2-secret">Secret Access Key</label>
        <div className="row">
          <input id="r2-secret" type="password" value={form.secret_access_key ?? ""} onChange={(e) => edit({ secret_access_key: e.target.value })} placeholder={status?.has_secret ? "設定済み（変更するときだけ入力）" : "未設定"} autoComplete="off" />
          <button onClick={clearSecret} disabled={!status?.has_secret || status.running}>削除</button>
        </div>
        <label htmlFor="r2-interval">間隔（時間）</label>
        <input id="r2-interval" type="number" min={1} max={720} value={form.interval_hours} onChange={(e) => edit({ interval_hours: Number(e.target.value) })} />
        <label htmlFor="r2-keep">残す世代数</label>
        <input id="r2-keep" type="number" min={1} max={1000} value={form.keep_generations} onChange={(e) => edit({ keep_generations: Number(e.target.value) })} />
      </div>
      <div className="row">
        <button onClick={save}>保存</button>
        <button onClick={backupNow} disabled={status?.running}>今すぐ R2 にバックアップ</button>
      </div>
      <p className="muted">
        {status?.running ? "バックアップ中…" : status?.last_success ? `最終バックアップ: ${time(status.last_success)}` : "まだ R2 にバックアップしていません"}
        {status?.last_key && <><br />最新のオブジェクト: <code>{status.last_key}</code></>}
        <br />DB のコピー（API キーは除く）を gzip 圧縮してアップロードします。アップロードに成功するたびに、この端末のバックアップを新しいものから指定した世代数だけ残して古いものを削除します（日数では消さないので、しばらく使わなくても消えません）。bucket は <code>infra/r2</code> の Terraform で管理します。
      </p>
      {status?.last_error && <p className="error-text">前回の失敗: {status.last_error}</p>}
      {status?.last_prune_error && <p className="error-text">警告: バックアップは成功しましたが、古い世代の削除に失敗しました: {status.last_prune_error}</p>}
      {message && <p role="status">{message}</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
    </div>
  );
}
