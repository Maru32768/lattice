import { useEffect, useState } from "react";
import { api, type Settings } from "./api";
import { ModelSettings } from "./ModelSettings";
import { R2BackupSection } from "./R2BackupSection";
import { ClassifySettings } from "./ClassifySettings";
import { TranslationSettings } from "./TranslationSettings";
import { RenderSettings } from "./RenderSettings";

export function SettingsView() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.settings().then(setSettings).catch((e) => setError(String(e)));
  }, []);

  async function backup() {
    setError(null);
    try {
      setStatus(`バックアップを作成しました: ${await api.backup()}`);
    } catch (e) {
      setError(String(e));
    }
  }

  async function exportJson() {
    setError(null);
    setStatus("エクスポート中…");
    try {
      setStatus(`エクスポートしました: ${await api.exportJson()}`);
    } catch (e) {
      setStatus(null);
      setError(String(e));
    }
  }

  return (
    <section className="settings">
      <h2>設定・バックアップ</h2>
      <ModelSettings />
      <ClassifySettings />
      <TranslationSettings />
      <RenderSettings />
      <div>
        <h3>バックアップ</h3>
        <div className="row"><button onClick={backup}>今すぐバックアップ</button><button onClick={exportJson}>JSON でエクスポート</button></div>
        <p className="muted">保存先: <code>{settings?.backup_dir}</code><br />記事・訳・要約・検索 index など、すべてのデータは 1 つの SQLite ファイルにあります: <code>{settings?.db_path}</code><br />
          JSON エクスポート（<code>exports</code> フォルダ、1 行 1 オブジェクトの gzip）には記事・ブロック・訳・要約・タグ・ジャンル・フィード・対話が入ります。API キーなどの設定と取得した HTML は含まないので、HTML まで残すにはバックアップを使ってください。</p>
      </div>
      <R2BackupSection />
      <div>
        <h3>ログ</h3>
        <p className="muted">取得や翻訳ジョブの失敗はログに記録されます: <code>{settings?.log_dir}</code></p>
      </div>
      {status && <p role="status">{status}</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
    </section>
  );
}
