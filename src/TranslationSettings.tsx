import { useEffect, useState } from "react";
import { SetRow, Switch } from "./SetRow";
import { api } from "./api";
import { setTranslateOnSwitch, translateOnSwitch } from "./mixed";
import { useT } from "./i18n";

const MAX_INSTRUCTIONS = 2000;

export function TranslationSettings() {
  const t = useT();
  const [on, setOn] = useState(true);
  const [onSwitch, setOnSwitch] = useState(translateOnSwitch);
  const [onSave, setOnSave] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [saved, setSaved] = useState("");
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.translateKeepTerms().then(setOn).catch((e) => setError(String(e)));
    api.autoTranslate().then(setOnSave).catch((e) => setError(String(e)));
    api.translateInstructions().then((text) => { setInstructions(text); setSaved(text); }).catch((e) => setError(String(e)));
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

  async function toggleOnSave(value: boolean) {
    setOnSave(value);
    setError(null);
    try {
      await api.setAutoTranslate(value);
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
      setStatus(t("common.saved"));
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="grp">
      <SetRow title={t("translationSettings.onSwitch")} htmlFor="tr-on-switch" desc={t("translationSettings.onSwitchDesc")}>
        <Switch id="tr-on-switch" checked={onSwitch} onChange={(v) => { setOnSwitch(v); setTranslateOnSwitch(v); }} />
      </SetRow>
      <SetRow title={t("translationSettings.onSave")} htmlFor="tr-on-save" desc={t("translationSettings.onSaveDesc")}>
        <Switch id="tr-on-save" checked={onSave} onChange={toggleOnSave} />
      </SetRow>
      <SetRow title={t("translationSettings.keepTerms")} htmlFor="keep-terms"
        desc={t("translationSettings.keepTermsDesc")}>
        <Switch id="keep-terms" checked={on} onChange={toggle} />
      </SetRow>
      <div className="set wide">
        <label className="h" htmlFor="tr-instructions">{t("translationSettings.instructions")}</label>
        <div className="d">
          {t("translationSettings.instructionsDesc")}
        </div>
        <textarea id="tr-instructions" value={instructions} rows={4} maxLength={MAX_INSTRUCTIONS} placeholder={t("common.none")}
          onChange={(e) => { setInstructions(e.target.value); setStatus(null); }} />
        <div className="acts">
          <button className="btn sm" onClick={saveInstructions} disabled={instructions.trim() === saved}>{t("common.save")}</button>
          <span className="muted">{status ?? `${instructions.length} / ${MAX_INSTRUCTIONS}`}</span>
        </div>
        <details>
          <summary>{t("translationSettings.showPrompt")}</summary>
          <pre aria-label={t("translationSettings.prompt")}>{prompt}</pre>
        </details>
      </div>
      {error && <p className="msg error-text" role="alert">{t.msg(error)}</p>}
    </div>
  );
}
