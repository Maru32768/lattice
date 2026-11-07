import { useEffect, useState } from "react";
import { mobile, type MobileServerMode, type MobileSettings as Settings, type MobileStatus } from "../api";
import { SetRow } from "../ui/SetRow";
import { useT } from "../i18n";

const MIN_PORT = 1024;
const MAX_PORT = 65535;

/** Settings section for reading on a phone (G47). */
export function MobileSettings() {
  const t = useT();
  const [status, setStatus] = useState<MobileStatus | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    mobile
      .status()
      .then((s) => {
        setStatus(s);
        setForm(s.settings);
      })
      .catch((e: unknown) => setError(String(e)));
  }, []);

  async function run(action: () => Promise<MobileStatus>) {
    setError(null);
    try {
      const s = await action();
      setStatus(s);
      setForm(s.settings);
    } catch (e) {
      setError(String(e));
    }
  }

  const failure = error && (
    <p role="alert" className="msg error-text">
      {t.msg(error)}
    </p>
  );
  if (!form || !status) {
    return failure;
  }
  const edit = (patch: Partial<Settings>) => setForm({ ...form, ...patch });
  // The backend's type holds no more than this, and a value it cannot hold never reaches its own check.
  const portOk = Number.isInteger(form.port) && form.port >= MIN_PORT && form.port <= MAX_PORT;
  return (
    <>
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
        <SetRow title={t("mobileSettings.publicUrl")} desc={t("mobileSettings.publicUrlDesc")} htmlFor="mobile-url">
          <input
            id="mobile-url"
            className="input sm mono"
            value={form.public_url}
            onChange={(e) => edit({ public_url: e.target.value })}
            placeholder="https://pc.example.ts.net"
            spellCheck={false}
          />
        </SetRow>
      </div>
      <div className="btn-row">
        <button className="btn pri" onClick={() => void run(() => mobile.save(form))} disabled={status.fell_back || !portOk}>
          {t("common.save")}
        </button>
        <button className="btn" onClick={() => void run(mobile.regenerateToken)} disabled={status.fell_back}>
          {t("mobileSettings.regenerate")}
        </button>
      </div>
      {!portOk && <p className="note err">{t("be.mobile.port", { min: String(MIN_PORT), max: String(MAX_PORT) })}</p>}
      {form.mode === "lan" && <p className="note warn">{t("mobileSettings.lanWarning")}</p>}
      {status.fell_back && <p className="note warn">{t("be.mobile.fellBack")}</p>}
      {status.error && <p className="note err">{t.msg(status.error)}</p>}
      {status.running && !status.url && <p className="sec-d">{t("mobileSettings.needsUrl")}</p>}
      {status.url && status.qr && (
        <div className="mobile-qr">
          <svg viewBox={`-2 -2 ${status.qr.width + 4} ${status.qr.width + 4}`} role="img" aria-label={t("mobileSettings.qr")} width={220} height={220}>
            <rect x={-2} y={-2} width={status.qr.width + 4} height={status.qr.width + 4} fill="#fff" />
            <path d={status.qr.path} fill="#000" />
          </svg>
          <p className="sec-d">{t("mobileSettings.scan")}</p>
          <p className="sec-d">
            <code>{status.url.split("#")[0]}</code>
          </p>
        </div>
      )}
      {failure}
    </>
  );
}
