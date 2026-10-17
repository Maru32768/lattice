import { useEffect, useState } from "react";
import { SetRow, Switch } from "./SetRow";
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
    <div className="grp">
      <SetRow title="保存した記事を LLM でジャンル分けし、タグを付ける" htmlFor="auto-classify"
        desc="最大 20 件をまとめて 1 回の LLM 呼び出しで分類します。Reader で選んだジャンルは自動分類で上書きしません。">
        <Switch id="auto-classify" checked={on} onChange={toggle} />
      </SetRow>
      <SetRow title="未分類の記事" desc="ジャンルのない記事を分類キューに追加します。">
        <button className="btn" onClick={classifyAll}>未分類をすべて分類</button>
      </SetRow>
      {status && <p role="status" className="msg">{status}</p>}
      {error && <p className="msg error-text" role="alert">{error}</p>}
    </div>
  );
}
