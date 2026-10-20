import { useEffect, useState } from "react";
import { SetRow, Switch } from "./SetRow";
import { api } from "./api";

const MAX_INSTRUCTIONS = 2000;

export function TranslationSettings() {
  const [on, setOn] = useState(true);
  const [instructions, setInstructions] = useState("");
  const [saved, setSaved] = useState("");
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.translateKeepTerms().then(setOn).catch((e) => setError(String(e)));
    api.translateInstructions().then((t) => { setInstructions(t); setSaved(t); }).catch((e) => setError(String(e)));
  }, []);
  // The built-in prompt depends on the term mode.
  useEffect(() => { api.translationPrompt().then(setPrompt).catch(() => {}); }, [on]);

  async function toggle(value: boolean) {
    setOn(value);
    setError(null);
    try {
      await api.setTranslateKeepTerms(value);
    } catch (e) {
      setError(String(e));
    }
  }

  async function saveInstructions() {
    setError(null);
    setStatus(null);
    try {
      await api.setTranslateInstructions(instructions);
      setSaved(instructions.trim());
      setInstructions(instructions.trim());
      setStatus("保存しました");
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="grp">
      <SetRow title="専門用語を英語のまま残す" htmlFor="keep-terms"
        desc="MVCC、WAL、snapshot isolation、write skew など。日本語の記事を英語に訳すときは、オンで定着した英語の用語を、オフで平易な言い換えを優先します。訳文は設定ごとに別に保存するので、切り替えた後の記事は翻訳し直す必要があります（元の設定に戻せば以前の訳文が表示されます）。">
        <Switch id="keep-terms" checked={on} onChange={toggle} />
      </SetRow>
      <div className="set wide">
        <label className="h" htmlFor="tr-instructions">追加の指示</label>
        <div className="d">
          翻訳の prompt の末尾に付け加えます（例:「です・ます調で訳す」「Kubernetes の用語は公式ドキュメントの訳語に合わせる」）。記事の翻訳とページ表示の翻訳の両方に効きます。
          訳文は指示ごとに別に保存するので、変えた後の記事は翻訳し直す必要があります。
        </div>
        <textarea id="tr-instructions" value={instructions} rows={4} maxLength={MAX_INSTRUCTIONS} placeholder="なし"
          onChange={(e) => { setInstructions(e.target.value); setStatus(null); }} />
        <div className="acts">
          <button className="btn sm" onClick={saveInstructions} disabled={instructions.trim() === saved}>保存</button>
          <span className="muted">{status ?? `${instructions.length} / ${MAX_INSTRUCTIONS}`}</span>
        </div>
        <details>
          <summary>組み込みの prompt（英語→日本語）を見る</summary>
          <pre aria-label="組み込みの prompt">{prompt}</pre>
        </details>
      </div>
      {error && <p className="msg error-text" role="alert">{error}</p>}
    </div>
  );
}
