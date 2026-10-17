import { useEffect, useState } from "react";
import { api, type Settings } from "./api";
import { ModelSettings } from "./ModelSettings";
import { R2BackupSection } from "./R2BackupSection";
import { ClassifySettings } from "./ClassifySettings";
import { GenreSettings } from "./GenreSettings";
import { TranslationSettings } from "./TranslationSettings";
import { RenderSettings } from "./RenderSettings";
import { ImageSettings } from "./ImageSettings";

export function SettingsView({ onChanged }: { onChanged: () => void }) {
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
      <GenreSettings onChanged={onChanged} />
      <TranslationSettings />
      <RenderSettings />
      <ImageSettings />
      <div>
        <h3>バックアップ</h3>
        <div className="row"><button onClick={backup}>今すぐバックアップ</button><button onClick={exportJson}>JSON でエクスポート</button></div>
        <div className="row">
          <label htmlFor="backup-keep">残す世代数</label>
          <input id="backup-keep" type="number" min={1} max={1000} value={keep} onChange={(e) => setKeep(Number(e.target.value))} />
          <button onClick={saveKeep}>保存</button>
        </div>
        <p className="muted">保存先: <code>{settings?.backup_dir}</code>（バックアップを作るたびに、新しいものから指定した世代数だけ残して古い <code>lattice-*.db</code> を削除します。日数では消さないので、しばらく使わなくても消えません）<br />記事・訳・要約・画像・検索 index など、すべてのデータは 1 つの SQLite ファイルにあります: <code>{settings?.db_path}</code><br />
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
