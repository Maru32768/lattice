import { useEffect, useState } from "react";
import { api, type Settings } from "./api";
import { R2BackupSection } from "./R2BackupSection";

const PRESETS = [
  { value: "", label: "Claude CLI の既定" },
  { value: "haiku", label: "Haiku（速い・安い）" },
  { value: "sonnet", label: "Sonnet（バランス）" },
  { value: "opus", label: "Opus（高品質・高コスト）" },
];

export function SettingsView() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [model, setModel] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.settings().then((s) => {
      setSettings(s);
      setModel(s.claude_model ?? "");
    }).catch((e) => setError(String(e)));
  }, []);

  async function saveModel(value: string) {
    setModel(value);
    setError(null);
    try {
      await api.setClaudeModel(value.trim() || null);
      setStatus("モデルを保存しました");
    } catch (e) {
      setError(String(e));
    }
  }

  async function backup() {
    setError(null);
    try {
      setStatus(`バックアップを作成しました: ${await api.backup()}`);
    } catch (e) {
      setError(String(e));
    }
  }

  const custom = !PRESETS.some((p) => p.value === model);
  return (
    <section className="settings">
      <h2>設定・バックアップ</h2>
      <div>
        <h3>翻訳・要約に使うモデル</h3>
        <div className="row">
          <select value={custom ? "custom" : model} onChange={(e) => saveModel(e.target.value === "custom" ? model : e.target.value)} aria-label="モデル">
            {PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            <option value="custom">その他（モデル ID を入力）</option>
          </select>
          {custom && <input value={model} onChange={(e) => setModel(e.target.value)} onBlur={(e) => saveModel(e.target.value)} placeholder="claude-…" aria-label="モデル ID" />}
        </div>
        <p className="muted">Claude CLI の <code>--model</code> に渡します。大量に翻訳するなら Haiku か Sonnet がおすすめです。</p>
      </div>
      <div>
        <h3>バックアップ</h3>
        <div className="row"><button onClick={backup}>今すぐバックアップ</button></div>
        <p className="muted">保存先: <code>{settings?.backup_dir}</code><br />記事・訳・要約・検索 index など、すべてのデータは 1 つの SQLite ファイルにあります: <code>{settings?.db_path}</code></p>
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
