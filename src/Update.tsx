import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { updates, type UpdateInfo } from "./api";
import { SetRow } from "./SetRow";

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
    } finally {
      off();
    }
  }
  return { percent, error, install };
}

function InstallButton({ percent, onInstall }: { percent: number | null; onInstall: () => void }) {
  return percent == null
    ? <button className="btn pri" onClick={onInstall}>更新して再起動</button>
    : <span className="muted" role="status">{percent < 100 ? `ダウンロード中 ${percent}%` : "インストール中…"}</span>;
}

/** Checks once at startup and, when a newer version exists, shows a bar under the title bar. */
export function UpdateNotice({ onOpenUrl }: { onOpenUrl: (url: string) => void }) {
  const [found, setFound] = useState<{ version: string; portable: boolean } | null>(null);
  const { percent, error, install } = useInstall();

  useEffect(() => {
    (async () => {
      const info = await updates.info();
      const version = info.configured ? await updates.check() : null;
      if (version) setFound({ version, portable: info.portable });
    })().catch((e) => console.warn("update check failed", e)); // offline at startup is normal; Settings shows errors
  }, []);

  if (!found) return null;
  return (
    <div className="update-bar" role="status">
      <span className="grow">Lattice {found.version} が利用できます。{found.portable && "ポータブル版は新しい zip に置き換えて更新します。"}</span>
      {error && <span className="error-text">{error}</span>}
      <button className="btn ghost" onClick={() => onOpenUrl(releaseUrl(found.version))}>{found.portable ? "ダウンロードページ" : "リリースノート"}</button>
      {!found.portable && <InstallButton percent={percent} onInstall={install} />}
      {percent == null && <button className="btn ghost" onClick={() => setFound(null)}>後で</button>}
    </div>
  );
}

export function UpdateSection({ onOpenUrl }: { onOpenUrl: (url: string) => void }) {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [result, setResult] = useState<{ version: string | null } | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { percent, error: installError, install } = useInstall();

  useEffect(() => { updates.info().then(setInfo).catch((e) => setError(String(e))); }, []);

  async function check() {
    setError(null);
    setChecking(true);
    try {
      setResult({ version: await updates.check() });
    } catch (e) {
      setError(String(e));
    } finally {
      setChecking(false);
    }
  }

  const desc = !info ? null
    : !info.configured ? "このビルドでは自動更新が設定されていません（署名用の公開鍵がありません）。新しいバージョンは GitHub の Releases から入手してください。"
    : result?.version && info.portable ? <>Lattice {result.version} が利用できます。ポータブル版は、Releases の zip を展開して <code>Lattice.exe</code> を置き換えてください（<code>data</code> フォルダはそのまま使えます）。</>
    : result?.version ? <>Lattice {result.version} が利用できます。ダウンロードして署名を確かめ、インストール後に再起動します。</>
    : result ? "最新のバージョンです。"
    : "起動時にも確認し、新しいバージョンがあれば画面上部に表示します。";

  return (
    <>
      <div className="grp">
        <SetRow title={`バージョン ${info?.current ?? ""}`} desc={desc}>
          {result?.version && <button className="btn ghost" onClick={() => onOpenUrl(releaseUrl(result.version!))}>リリースノート</button>}
          {result?.version
            ? !info?.portable && <InstallButton percent={percent} onInstall={install} />
            : <button className="btn" onClick={check} disabled={!info?.configured || checking}>{checking ? "確認中…" : "更新を確認"}</button>}
        </SetRow>
      </div>
      {(error ?? installError) && <p role="alert" className="msg error-text">{error ?? installError}</p>}
    </>
  );
}
