import { useEffect, useState } from "react";
import { mobile, type MobileServerMode, type MobileSettings as Settings, type MobileStatus, type SnapshotSettings, type TailscaleStatus } from "../api";
import { SetRow, Switch } from "../ui/SetRow";
import { locale, useT } from "../i18n";

const MIN_PORT = 1024;
const MAX_PORT = 65535;

const time = (secs: number) => new Date(secs * 1000).toLocaleString(locale());
const snapshotForm = (s: MobileStatus): SnapshotSettings => ({
  enabled: s.snapshot.enabled,
  account_id: s.snapshot.account_id,
  bucket: s.snapshot.bucket,
  access_key_id: s.snapshot.access_key_id,
  secret_access_key: "",
  worker_url: s.snapshot.worker_url,
});

/** A QR code on white, with the 4-module margin the standard asks for. */
function Qr({ qr, label }: { qr: NonNullable<MobileStatus["qr"]>; label: string }) {
  return (
    <svg viewBox={`-4 -4 ${qr.width + 8} ${qr.width + 8}`} role="img" aria-label={label} width={240} height={240}>
      <rect x={-4} y={-4} width={qr.width + 8} height={qr.width + 8} fill="#fff" />
      <path d={qr.path} fill="#000" shapeRendering="crispEdges" />
    </svg>
  );
}

/** Settings section for reading on a phone (G47). */
export function MobileSettings() {
  const t = useT();
  const [status, setStatus] = useState<MobileStatus | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  const [snapshot, setSnapshot] = useState<SnapshotSettings | null>(null);
  /** Leaving a bucket waits for a running pass, and reaches across the network. */
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Null until Tailscale has answered: it takes a moment, and the rest of the screen does not wait for it. */
  const [tailscale, setTailscale] = useState<TailscaleStatus | null>(null);
  const [serving, setServing] = useState(false);

  useEffect(() => {
    mobile
      .tailscale()
      .then(setTailscale)
      .catch(() => {});
    mobile
      .status()
      .then((s) => {
        setStatus(s);
        setForm(s.settings);
        setSnapshot(snapshotForm(s));
      })
      .catch((e: unknown) => setError(String(e)));
  }, []);

  // A pass starts a moment after the command returns, and can take minutes or start on its schedule.
  const following = status?.snapshot.enabled;
  useEffect(() => {
    if (!following) {
      return;
    }
    const timer = setInterval(
      () =>
        mobile
          .status()
          .then(setStatus)
          .catch(() => {}),
      3000,
    );
    return () => clearInterval(timer);
  }, [following]);

  /** `abandon`: the reader has read why the old bucket cannot be left, and saves anyway. */
  async function saveSnapshot(abandon: boolean) {
    setError(null);
    setSaving(true);
    try {
      const s = await mobile.saveSnapshot(snapshot!, abandon);
      setStatus(s);
      setSnapshot(snapshotForm(s));
    } catch (e) {
      setError(String(e));
    }
    setSaving(false);
  }

  async function publish() {
    setError(null);
    try {
      setStatus(await mobile.publishNow());
    } catch (e) {
      setError(String(e));
    }
  }

  async function save(next = form!) {
    setError(null);
    try {
      const s = await mobile.save(next);
      setStatus(s);
      setForm(s.settings);
      // The port may have changed, and Serve forwards to one port.
      setTailscale(await mobile.tailscale());
    } catch (e) {
      setError(String(e));
    }
  }

  /** Turning Serve on also makes its address the one the phone opens, and serves for the tunnel if nothing is served yet. */
  async function serve(on: boolean) {
    setError(null);
    setServing(true);
    const ts = await mobile.tailscaleServe(on).catch((e: unknown) => {
      setError(String(e));
      return null;
    });
    setServing(false);
    if (ts) {
      setTailscale(ts);
    }
    if (on && ts?.serves_port && ts.address) {
      await save({ ...form!, public_url: ts.address, mode: form!.mode === "off" ? "local" : form!.mode });
    }
  }

  /** Leaves the form alone: what is typed there has not been saved yet. */
  async function regenerate() {
    setError(null);
    try {
      setStatus(await mobile.regenerateToken());
    } catch (e) {
      setError(String(e));
    }
  }

  const failure = error && (
    <p role="alert" className="msg error-text">
      {t.msg(error)}
    </p>
  );
  if (!form || !status || !snapshot) {
    return failure;
  }
  const editSnapshot = (patch: Partial<SnapshotSettings>) => setSnapshot({ ...snapshot, ...patch });
  const snapshotText = (id: string, key: "account_id" | "bucket" | "access_key_id" | "worker_url", placeholder?: string) => (
    <input
      id={id}
      className="input sm mono"
      value={snapshot[key]}
      onChange={(e) => editSnapshot({ [key]: e.target.value })}
      placeholder={placeholder}
      spellCheck={false}
    />
  );
  const edit = (patch: Partial<Settings>) => setForm({ ...form, ...patch });
  // The backend's type holds no more than this, and a value it cannot hold never reaches its own check.
  const portOk = Number.isInteger(form.port) && form.port >= MIN_PORT && form.port <= MAX_PORT;
  return (
    <>
      <section aria-labelledby="mobile-live">
        <h2 id="mobile-live">{t("mobileSettings.live")}</h2>
        <div className="grp">
          <SetRow title={t("mobileSettings.mode")} desc={t("mobileSettings.modeDesc")} htmlFor="mobile-mode">
            <select id="mobile-mode" className="input sm" value={form.mode} onChange={(e) => edit({ mode: e.target.value as MobileServerMode })}>
              <option value="off">{t("mobileSettings.off")}</option>
              <option value="lan">{t("mobileSettings.lan")}</option>
              <option value="local">{t("mobileSettings.local")}</option>
            </select>
          </SetRow>
          <SetRow title={t("mobileSettings.port")} htmlFor="mobile-port">
            <input
              id="mobile-port"
              className="input sm num"
              type="number"
              min={MIN_PORT}
              max={MAX_PORT}
              value={form.port}
              onChange={(e) => edit({ port: Number(e.target.value) })}
            />
          </SetRow>
          <SetRow title={t("mobileSettings.publicUrl")} desc={t("mobileSettings.publicUrlDesc", { port: String(form.port) })} htmlFor="mobile-url">
            <input
              id="mobile-url"
              className="input sm mono"
              value={form.public_url}
              onChange={(e) => edit({ public_url: e.target.value })}
              placeholder="https://pc.example.ts.net"
              spellCheck={false}
            />
          </SetRow>
          {tailscale && (
            <SetRow
              title={t("mobileSettings.tailscale")}
              desc={
                !tailscale.address
                  ? t("mobileSettings.tailscaleMissing")
                  : t(tailscale.serves_port ? "mobileSettings.tailscaleOn" : "mobileSettings.tailscaleOff", { address: tailscale.address })
              }
            >
              {tailscale.address && (
                // Serve forwards to the saved port: a port typed and not saved yet would go one way and the server the other.
                <button className="btn" onClick={() => void serve(!tailscale.serves_port)} disabled={serving || form.port !== status.settings.port}>
                  {t(tailscale.serves_port ? "mobileSettings.tailscaleStop" : "mobileSettings.tailscaleStart")}
                </button>
              )}
            </SetRow>
          )}
        </div>
        <div className="btn-row">
          <button className="btn pri" onClick={() => void save()} disabled={status.fell_back || !portOk}>
            {t("common.save")}
          </button>
          <button className="btn" onClick={() => void regenerate()} disabled={status.fell_back}>
            {t("mobileSettings.regenerate")}
          </button>
        </div>
        {!portOk && <p className="note err">{t("be.mobile.port", { min: String(MIN_PORT), max: String(MAX_PORT) })}</p>}
        {form.mode === "lan" && <p className="note warn">{t("mobileSettings.lanWarning")}</p>}
        {tailscale && !tailscale.serves_port && URL.parse(status.settings.public_url)?.hostname.endsWith(".ts.net") && (
          <p className="note warn">{t("mobileSettings.tailscaleNotServing")}</p>
        )}
        {status.fell_back && <p className="note warn">{t("be.mobile.fellBack")}</p>}
        {status.error && <p className="note err">{t.msg(status.error)}</p>}
        {status.running && !status.url && <p className="sec-d">{t("mobileSettings.needsUrl")}</p>}
        {status.url && (
          <div className="mobile-qr">
            {status.qr ? (
              <>
                <Qr qr={status.qr} label={t("mobileSettings.qr")} />
                <p className="sec-d">{t("mobileSettings.scan")}</p>
                <p className="sec-d">
                  <code>{status.url.split("#")[0]}</code>
                </p>
              </>
            ) : (
              <p className="sec-d">
                <code>{status.url}</code>
              </p>
            )}
          </div>
        )}
      </section>
      <section aria-labelledby="mobile-snapshot">
        <h2 id="mobile-snapshot">{t("mobileSettings.snapshot")}</h2>
        <p className="sec-d">{t.rich("mobileSettings.snapshotDesc", { code: <code>infra/mobile</code> })}</p>
        <div className="grp">
          <SetRow title={t("mobileSettings.snapshotEnabled")} htmlFor="snapshot-enabled">
            <Switch id="snapshot-enabled" checked={snapshot.enabled} onChange={(on) => editSnapshot({ enabled: on })} />
          </SetRow>
          <SetRow title="Account ID" htmlFor="snapshot-account">
            {snapshotText("snapshot-account", "account_id")}
          </SetRow>
          <SetRow title="Bucket" htmlFor="snapshot-bucket">
            {snapshotText("snapshot-bucket", "bucket", "lattice-mobile")}
          </SetRow>
          <SetRow title="Access Key ID" htmlFor="snapshot-key">
            {snapshotText("snapshot-key", "access_key_id")}
          </SetRow>
          <SetRow title="Secret Access Key" htmlFor="snapshot-secret">
            <input
              id="snapshot-secret"
              className="input sm"
              type="password"
              value={snapshot.secret_access_key ?? ""}
              onChange={(e) => editSnapshot({ secret_access_key: e.target.value })}
              placeholder={status.snapshot.has_secret ? t("r2BackupSection.secretSet") : t("common.notSet")}
              autoComplete="off"
            />
          </SetRow>
          <SetRow title={t("mobileSettings.workerUrl")} htmlFor="snapshot-worker">
            {snapshotText("snapshot-worker", "worker_url", "https://lattice-mobile.example.workers.dev")}
          </SetRow>
        </div>
        <div className="btn-row">
          <button className="btn pri" onClick={() => void saveSnapshot(false)} disabled={status.fell_back || saving}>
            {t("common.save")}
          </button>
          <button className="btn" onClick={() => void publish()} disabled={status.fell_back || !status.snapshot.enabled || status.snapshot.running}>
            {t("mobileSettings.publishNow")}
          </button>
        </div>
        <p className="sec-d">
          {status.snapshot.running
            ? t("mobileSettings.publishing")
            : status.snapshot.last_publish
              ? t("mobileSettings.lastPublish", { time: time(status.snapshot.last_publish) })
              : t("mobileSettings.neverPublished")}
        </p>
        {status.snapshot.last_error && <p className="note err">{t("mobileSettings.publishFailed", { error: t.msg(status.snapshot.last_error) })}</p>}
        {status.snapshot.last_rejected && <p className="note warn">{t("mobileSettings.opRejected", { error: t.msg(status.snapshot.last_rejected) })}</p>}
        {error?.includes("mobile.leaveFailed") && (
          <div className="note warn">
            <p id="snapshot-abandon-desc">{t("mobileSettings.abandonDesc")}</p>
            <button className="btn" onClick={() => void saveSnapshot(true)} disabled={saving} aria-describedby="snapshot-abandon-desc">
              {t("mobileSettings.abandon")}
            </button>
          </div>
        )}
        {status.snapshot_url && status.snapshot_qr && (
          <div className="mobile-qr">
            <Qr qr={status.snapshot_qr} label={t("mobileSettings.snapshotQr")} />
            <p className="sec-d">{t("mobileSettings.scan")}</p>
            <p className="sec-d">
              <code>{status.snapshot_url.split("#")[0]}</code>
            </p>
          </div>
        )}
      </section>
      {failure}
    </>
  );
}
