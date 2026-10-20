import { useEffect, useState } from "react";
import { api, type CustomInstructions } from "./api";

const MAX_CHARS = 2000;

const FIELDS: { key: keyof CustomInstructions; label: string; desc: string; placeholder: string }[] = [
  {
    key: "profile",
    label: "自分について",
    desc: "関心のある分野、前提にしてよい知識、重視してほしいことなど。要約と対話の回答の両方に使います。",
    placeholder: "例: バックエンドエンジニア。PostgreSQL と Kubernetes の運用経験がある。性能の数値と運用上の注意点を重視する。",
  },
  {
    key: "summary",
    label: "要約の追加の指示",
    desc: "要約だけに付け加える指示。変えると、作成済みの要約に「作り直すと反映されます」と表示します。",
    placeholder: "なし",
  },
  {
    key: "chat",
    label: "対話の追加の指示",
    desc: "対話の回答だけに付け加える指示。次の質問から効きます。",
    placeholder: "なし",
  },
];

const EMPTY: CustomInstructions = { profile: "", summary: "", chat: "" };

export function InstructionSettings() {
  const [value, setValue] = useState(EMPTY);
  const [saved, setSaved] = useState(EMPTY);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.customInstructions().then((v) => { setValue(v); setSaved(v); }).catch((e) => setError(String(e)));
  }, []);

  async function save() {
    setError(null);
    setStatus(null);
    const trimmed = { profile: value.profile.trim(), summary: value.summary.trim(), chat: value.chat.trim() };
    try {
      await api.setCustomInstructions(trimmed);
      setValue(trimmed);
      setSaved(trimmed);
      setStatus("保存しました");
    } catch (e) {
      setError(String(e));
    }
  }

  const changed = FIELDS.some(({ key }) => value[key].trim() !== saved[key]);
  return (
    <div className="grp">
      {FIELDS.map(({ key, label, desc, placeholder }) => (
        <div className="set wide" key={key}>
          <label className="h" htmlFor={`ci-${key}`}>{label}</label>
          <div className="d">{desc}</div>
          <textarea id={`ci-${key}`} value={value[key]} rows={key === "profile" ? 5 : 3} maxLength={MAX_CHARS} placeholder={placeholder}
            onChange={(e) => { setValue((v) => ({ ...v, [key]: e.target.value })); setStatus(null); }} />
          <div className="acts"><span className="muted">{value[key].length} / {MAX_CHARS}</span></div>
        </div>
      ))}
      <div className="set wide">
        <div className="acts">
          <button className="btn sm" onClick={save} disabled={!changed}>保存</button>
          {status && <span className="muted" role="status">{status}</span>}
        </div>
      </div>
      {error && <p className="msg error-text" role="alert">{error}</p>}
    </div>
  );
}
