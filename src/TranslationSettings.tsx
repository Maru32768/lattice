import { useEffect, useState } from "react";
import { api } from "./api";

export function TranslationSettings() {
  const [on, setOn] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.translateKeepTerms().then(setOn).catch((e) => setError(String(e))); }, []);

  async function toggle(value: boolean) {
    setOn(value);
    setError(null);
    try {
      await api.setTranslateKeepTerms(value);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div>
      <h3>翻訳</h3>
      <label className="row">
        <input type="checkbox" checked={on} onChange={(e) => toggle(e.target.checked)} />
        専門用語を英語のまま残す（MVCC、WAL、snapshot isolation、write skew など）
      </label>
      <p className="muted">記事の翻訳とページ表示の翻訳の両方に効きます。訳文は設定ごとに別に保存するので、切り替えた後の記事は翻訳し直す必要があります（元の設定に戻せば以前の訳文が表示されます）。</p>
      {error && <p className="error-text" role="alert">{error}</p>}
    </div>
  );
}
