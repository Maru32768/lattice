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

/** The free-text instructions `fields` names: 自分について has its own section, the summary and chat ones share 要約・対話. */
export function InstructionSettings({ fields }: { fields: (keyof CustomInstructions)[] }) {
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
    // Each section saves only its own fields: the others keep what is stored, as read when this section opened.
    const trimmed = { ...saved };
    for (const key of fields) {
      trimmed[key] = value[key].trim();
    }
    try {
      await api.setCustomInstructions(trimmed);
      setValue(trimmed);
      setSaved(trimmed);
      setStatus(t("common.saved"));
    } catch (e) {
      setError(String(e));
    }
  }

  const shown = FIELDS.filter(({ key }) => fields.includes(key));
  const changed = shown.some(({ key }) => value[key].trim() !== saved[key]);
  return (
    <div className="grp">
      {shown.map(({ key, label, desc, placeholder }) => (
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
