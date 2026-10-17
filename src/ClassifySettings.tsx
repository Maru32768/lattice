import { useEffect, useState } from "react";
import { api } from "./api";

export function ClassifySettings() {
  const [on, setOn] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.autoClassify().then(setOn).catch((e) => setError(String(e))); }, []);

  async function toggle(value: boolean) {
    setOn(value);
    setError(null);
    try {
      await api.setAutoClassify(value);
    } catch (e) {
      setError(String(e));
    }
  }

  async function classifyAll() {
    setError(null);
    try {
      setStatus(`${await api.classifyUnclassified()} 件を分類キューに追加しました`);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div>
      <h3>自動分類</h3>
      <label className="row">
        <input type="checkbox" checked={on} onChange={(e) => toggle(e.target.checked)} />
        保存した記事を LLM でジャンル分けし、タグを付ける
      </label>
      <div className="row"><button onClick={classifyAll}>未分類をすべて分類</button></div>
      <p className="muted">最大 20 件をまとめて 1 回の LLM 呼び出しで分類します。Reader で選んだジャンルは自動分類で上書きしません。</p>
      {status && <p role="status">{status}</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
    </div>
  );
}
