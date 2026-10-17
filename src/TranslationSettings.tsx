import { useEffect, useState } from "react";
import { SetRow, Switch } from "./SetRow";
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
    <div className="grp">
      <SetRow title="専門用語を英語のまま残す" htmlFor="keep-terms"
        desc="MVCC、WAL、snapshot isolation、write skew など。訳文は設定ごとに別に保存するので、切り替えた後の記事は翻訳し直す必要があります（元の設定に戻せば以前の訳文が表示されます）。">
        <Switch id="keep-terms" checked={on} onChange={toggle} />
      </SetRow>
      {error && <p className="msg error-text" role="alert">{error}</p>}
    </div>
  );
}
