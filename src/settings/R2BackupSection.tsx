import { useEffect, useState } from "react";
import { r2, type R2Settings, type R2Status } from "../api";
import { SetRow, Switch } from "../ui/SetRow";
import { locale, useT } from "../i18n";

const time = (secs: number) => new Date(secs * 1000).toLocaleString(locale());
const formOf = (s: R2Status): R2Settings => ({ enabled: s.enabled, account_id: s.account_id, bucket: s.bucket, access_key_id: s.access_key_id, interval_hours: s.interval_hours, keep_generations: s.keep_generations, secret_access_key: "" });

/** Settings section for the automatic Cloudflare R2 backup. */
export function R2BackupSection() {
  const t = useT();
  const [status, setStatus] = useState<R2Status | null>(null);
  const [form, setForm] = useState<R2Settings | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload(resetForm: boolean) {
    const s = await r2.status();
    setStatus(s);
    if (resetForm) setForm(formOf(s));
  }

  useEffect(() => {
    r2.status().then((s) => { setStatus(s); setForm(formOf(s)); }).catch((e: unknown) => setError(String(e)));
  }, []);

  // A backup started by the scheduler or the button can take minutes; follow it until it ends.
  useEffect(() => {
    if (!status?.running) return;
    const t = setInterval(() => r2.status().then(setStatus).catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [status?.running]);

  async function save() {
    if (!form) return;
    setError(null);
    try {
      await r2.save(form);
      await reload(true);
      setMessage(t("r2BackupSection.saved"));
    } catch (e) {
      setError(String(e));
    }
  }

  async function clearSecret() {
    setError(null);
    try {
      await r2.clearSecret();
      await reload(true);
      setMessage(t("r2BackupSection.secretDeleted"));
    } catch (e) {
      setError(String(e));
    }
  }

  async function backupNow() {
    setError(null);
    setMessage(t("r2BackupSection.backingUpToR2"));
    const poll = setTimeout(() => reload(false).catch(() => {}), 500);
    try {
      setMessage(t("r2BackupSection.uploaded", { x: await r2.backupNow() }));
    } catch (e) {
      setMessage(null);
      setError(String(e));
    }
    clearTimeout(poll);
    await reload(false).catch(() => {});
  }

  if (!form) return error ? <p className="msg error-text" role="alert">{t.msg(error)}</p> : null;
  const edit = (patch: Partial<R2Settings>) => setForm({ ...form, ...patch });
  const text = (id: string, key: "account_id" | "bucket" | "access_key_id", placeholder?: string) => (
    <input id={id} className="input sm mono" value={form[key]} onChange={(e) => edit({ [key]: e.target.value })} placeholder={placeholder} spellCheck={false} />
  );
  return (
    <>
      <div className="grp">
        <SetRow title={t("r2BackupSection.auto")} htmlFor="r2-enabled">
          <Switch id="r2-enabled" checked={form.enabled} onChange={(on) => edit({ enabled: on })} />
        </SetRow>
        <SetRow title="Account ID" htmlFor="r2-account">{text("r2-account", "account_id")}</SetRow>
        <SetRow title="Bucket" htmlFor="r2-bucket">{text("r2-bucket", "bucket", "lattice-backup")}</SetRow>
        <SetRow title="Access Key ID" htmlFor="r2-key">{text("r2-key", "access_key_id")}</SetRow>
        <SetRow title="Secret Access Key" htmlFor="r2-secret">
          <input id="r2-secret" className="input sm" type="password" value={form.secret_access_key ?? ""} onChange={(e) => edit({ secret_access_key: e.target.value })} placeholder={status?.has_secret ? t("r2BackupSection.secretSet") : t("common.notSet")} autoComplete="off" />
          <button className="btn ghost" onClick={clearSecret} disabled={!status?.has_secret || status.running} aria-label={t("r2BackupSection.deleteSecret")}>{t("common.delete")}</button>
        </SetRow>
        <SetRow title={t("r2BackupSection.interval")} htmlFor="r2-interval">
          <input id="r2-interval" className="input sm num" type="number" min={1} max={720} value={form.interval_hours} onChange={(e) => edit({ interval_hours: Number(e.target.value) })} />
        </SetRow>
        <SetRow title={t("r2BackupSection.keep")} htmlFor="r2-keep">
          <input id="r2-keep" className="input sm num" type="number" min={1} max={1000} value={form.keep_generations} onChange={(e) => edit({ keep_generations: Number(e.target.value) })} />
        </SetRow>
      </div>
      <div className="btn-row">
        <button className="btn pri" onClick={save}>{t("common.save")}</button>
        <button className="btn" onClick={backupNow} disabled={status?.running}>{t("r2BackupSection.backUpNow")}</button>
      </div>
      <p className="sec-d">
        {status?.running ? t("r2BackupSection.backingUp") : status?.last_success ? t("r2BackupSection.last", { time: time(status.last_success) }) : t("r2BackupSection.never")}
        {status?.last_key && <><br />{t.rich("r2BackupSection.latest", { key: <code>{status.last_key}</code> })}</>}
      </p>
      {status?.last_error && <p className="note err">{t("r2BackupSection.lastFailure", { last_error: t.msg(status.last_error) })}</p>}
      {status?.last_prune_error && <p className="note warn">{t("r2BackupSection.pruneFailed", { last_prune_error: t.msg(status.last_prune_error) })}</p>}
      {message && <p role="status" className="msg">{message}</p>}
      {error && <p role="alert" className="msg error-text">{t.msg(error)}</p>}
    </>
  );
}
