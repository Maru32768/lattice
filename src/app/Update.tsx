import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { updates, type UpdateInfo } from "../api";
import { SetRow } from "../ui/SetRow";
import { useT } from "../i18n";

const releaseUrl = (version: string) => `https://github.com/Maru32768/lattice/releases/tag/v${version}`;

/** Install state shared by the notice and the settings section; the app exits once it succeeds. */
function useInstall() {
  const [percent, setPercent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function install() {
    setError(null);
    setPercent(0);
    const off = await listen<{ downloaded: number; total: number | null }>("update-progress", (e) => {
      const { downloaded, total } = e.payload;
      setPercent(total ? Math.floor((downloaded / total) * 100) : 0);
    });
    try {
      await updates.install();
    } catch (e) {
      setError(String(e));
      setPercent(null);
    }
    off();
  }
  return { percent, error, install };
}

function InstallButton({ percent, onInstall }: { percent: number | null; onInstall: () => void }) {
  const t = useT();
  return percent == null ? (
    <button className="btn pri" onClick={onInstall}>
      {t("update.install")}
    </button>
  ) : (
    <span className="muted" role="status">
      {percent < 100 ? t("update.downloading", { percent }) : t("update.installing")}
    </span>
  );
}

/** Checks once at startup and, when a newer version exists, shows a bar under the title bar. */
export function UpdateNotice({ onOpenUrl }: { onOpenUrl: (url: string) => void }) {
  const t = useT();
  const [found, setFound] = useState<{ version: string; portable: boolean } | null>(null);
  const { percent, error, install } = useInstall();

  useEffect(() => {
    (async () => {
      const info = await updates.info();
      const version = info.configured ? await updates.check() : null;
      if (version) {
        setFound({ version, portable: info.portable });
      }
    })().catch((e: unknown) => console.warn("update check failed", e)); // offline at startup is normal; Settings shows errors
  }, []);

  if (!found) {
    return null;
  }
  return (
    <div className="update-bar" role="status">
      <span className="grow">
        {t("update.available", { version: found.version })}
        {found.portable && t("update.portableNote")}
      </span>
      {error && <span className="error-text">{t.msg(error)}</span>}
      <button className="btn ghost" onClick={() => onOpenUrl(releaseUrl(found.version))}>
        {found.portable ? t("update.downloadPage") : t("update.releaseNotes")}
      </button>
      {!found.portable && <InstallButton percent={percent} onInstall={install} />}
      {percent == null && (
        <button className="btn ghost" onClick={() => setFound(null)}>
          {t("update.later")}
        </button>
      )}
    </div>
  );
}

export function UpdateSection({ onOpenUrl }: { onOpenUrl: (url: string) => void }) {
  const t = useT();
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [result, setResult] = useState<{ version: string | null } | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { percent, error: installError, install } = useInstall();

  useEffect(() => {
    updates
      .info()
      .then(setInfo)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  async function check() {
    setError(null);
    setChecking(true);
    try {
      setResult({ version: await updates.check() });
    } catch (e) {
      setError(String(e));
    }
    setChecking(false);
  }

  const desc = !info ? null : !info.configured ? (
    t("update.notConfigured")
  ) : result?.version && info.portable ? (
    <>{t.rich("update.availablePortable", { version: result.version, code: <code>Lattice.exe</code>, code2: <code>data</code> })}</>
  ) : result?.version ? (
    <>{t("update.availableInstall", { version: result.version })}</>
  ) : result ? (
    t("update.latest")
  ) : (
    t("update.checkedAtStart")
  );

  return (
    <>
      <div className="grp">
        <SetRow title={t("update.version", { x: info?.current ?? "" })} desc={desc}>
          {result?.version && (
            <button className="btn ghost" onClick={() => onOpenUrl(releaseUrl(result.version!))}>
              {t("update.releaseNotes")}
            </button>
          )}
          {result?.version ? (
            !info?.portable && <InstallButton percent={percent} onInstall={install} />
          ) : (
            <button className="btn" onClick={check} disabled={!info?.configured || checking}>
              {checking ? t("update.checking") : t("update.check")}
            </button>
          )}
        </SetRow>
      </div>
      {(error ?? installError) && (
        <p role="alert" className="msg error-text">
          {t.msg(error ?? installError)}
        </p>
      )}
    </>
  );
}
