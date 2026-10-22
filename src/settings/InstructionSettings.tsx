import { useEffect, useState } from "react";
import { api, type CustomInstructions } from "../api";
import { useT, type PlainKey } from "../i18n";

const MAX_CHARS = 2000;

const FIELDS: { key: keyof CustomInstructions; label: PlainKey; desc: PlainKey; placeholder: PlainKey }[] = [
  {
    key: "profile",
    label: "instructionSettings.profile",
    desc: "instructionSettings.profileDesc",
    placeholder: "instructionSettings.profilePlaceholder",
  },
  {
    key: "summary",
    label: "instructionSettings.summary",
    desc: "instructionSettings.summaryDesc",
    placeholder: "common.none",
  },
  {
    key: "chat",
    label: "instructionSettings.chat",
    desc: "instructionSettings.chatDesc",
    placeholder: "common.none",
  },
];

const EMPTY: CustomInstructions = { profile: "", summary: "", chat: "" };

export function InstructionSettings() {
  const t = useT();
  const [value, setValue] = useState(EMPTY);
  const [saved, setSaved] = useState(EMPTY);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .customInstructions()
      .then((v) => {
        setValue(v);
        setSaved(v);
      })
      .catch((e: unknown) => setError(String(e)));
  }, []);

  async function save() {
    setError(null);
    setStatus(null);
    const trimmed = { profile: value.profile.trim(), summary: value.summary.trim(), chat: value.chat.trim() };
    try {
      await api.setCustomInstructions(trimmed);
      setValue(trimmed);
      setSaved(trimmed);
      setStatus(t("common.saved"));
    } catch (e) {
      setError(String(e));
    }
  }

  const changed = FIELDS.some(({ key }) => value[key].trim() !== saved[key]);
  return (
    <div className="grp">
      {FIELDS.map(({ key, label, desc, placeholder }) => (
        <div className="set wide" key={key}>
          <label className="h" htmlFor={`ci-${key}`}>
            {t(label)}
          </label>
          <div className="d">{t(desc)}</div>
          <textarea
            id={`ci-${key}`}
            value={value[key]}
            rows={key === "profile" ? 5 : 3}
            maxLength={MAX_CHARS}
            placeholder={t(placeholder)}
            onChange={(e) => {
              setValue((v) => ({ ...v, [key]: e.target.value }));
              setStatus(null);
            }}
          />
          <div className="acts">
            <span className="muted">
              {value[key].length} / {MAX_CHARS}
            </span>
          </div>
        </div>
      ))}
      <div className="set wide">
        <div className="acts">
          <button className="btn sm" onClick={save} disabled={!changed}>
            {t("common.save")}
          </button>
          {status && (
            <span className="muted" role="status">
              {status}
            </span>
          )}
        </div>
      </div>
      {error && (
        <p className="msg error-text" role="alert">
          {t.msg(error)}
        </p>
      )}
    </div>
  );
}
