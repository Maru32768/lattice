import { useEffect, useState } from "react";
import { SetRow, Switch } from "../ui/SetRow";
import { api } from "../api";
import { setTranslateOnSwitch, translateOnSwitch } from "../reader/mixed";
import { useT } from "../i18n";

const MAX_INSTRUCTIONS = 2000;
/** `translate::MAX_PARALLEL`. */
const MAX_PARALLEL = 8;

export function TranslationSettings() {
  const t = useT();
  const [on, setOn] = useState(true);
  const [onSwitch, setOnSwitch] = useState(translateOnSwitch);
  const [onSave, setOnSave] = useState(false);
  const [parallel, setParallel] = useState(3);
  const [ownLanguage, setOwnLanguage] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [saved, setSaved] = useState("");
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [sites, setSites] = useState("");
  const [savedSites, setSavedSites] = useState("");
  const [sitesStatus, setSitesStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .translateKeepTerms()
      .then(setOn)
      .catch((e: unknown) => setError(String(e)));
    api
      .autoTranslate()
      .then(setOnSave)
      .catch((e: unknown) => setError(String(e)));
    api
      .autoTranslateOwnLanguage()
      .then(setOwnLanguage)
      .catch((e: unknown) => setError(String(e)));
    api
      .translateParallel()
      .then(setParallel)
      .catch((e: unknown) => setError(String(e)));
    api
      .translateInstructions()
      .then((text) => {
        setInstructions(text);
        setSaved(text);
      })
      .catch((e: unknown) => setError(String(e)));
    api
      .pageTranslateSkipSites()
      .then((s) => {
        setSites(s);
        setSavedSites(s);
      })
      .catch((e: unknown) => setError(String(e)));
    api
      .translationPrompt()
      .then(setPrompt)
      .catch(() => {});
  }, []);

  async function toggle(value: boolean) {
    setOn(value);
    setError(null);
    try {
      await api.setTranslateKeepTerms(value);
      // The built-in prompt depends on the term mode.
      setPrompt(await api.translationPrompt().catch(() => prompt));
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

  async function toggleOwnLanguage(value: boolean) {
    setOwnLanguage(value);
    setError(null);
    try {
      await api.setAutoTranslateOwnLanguage(value);
    } catch (e) {
      setError(String(e));
    }
  }

  async function saveParallel(n: number) {
    setParallel(n);
    setError(null);
    try {
      await api.setTranslateParallel(n);
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

  async function saveSites() {
    setError(null);
    try {
      const stored = await api.setPageTranslateSkipSites(sites);
      setSites(stored);
      setSavedSites(stored);
      setSitesStatus(t("common.saved"));
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="grp">
      <SetRow title={t("translationSettings.onSwitch")} htmlFor="tr-on-switch" desc={t("translationSettings.onSwitchDesc")}>
        <Switch
          id="tr-on-switch"
          checked={onSwitch}
          onChange={(v) => {
            setOnSwitch(v);
            setTranslateOnSwitch(v);
          }}
        />
      </SetRow>
      <SetRow title={t("translationSettings.onSave")} htmlFor="tr-on-save" desc={t("translationSettings.onSaveDesc")}>
        <Switch id="tr-on-save" checked={onSave} onChange={toggleOnSave} />
      </SetRow>
      <SetRow title={t("translationSettings.onSaveOwn")} htmlFor="tr-on-save-own" desc={t("translationSettings.onSaveOwnDesc")}>
        <Switch id="tr-on-save-own" checked={ownLanguage} disabled={!onSave} onChange={toggleOwnLanguage} />
      </SetRow>
      <SetRow title={t("translationSettings.parallel")} htmlFor="tr-parallel" desc={t("translationSettings.parallelDesc")}>
        <select id="tr-parallel" className="select" value={parallel} onChange={(e) => void saveParallel(Number(e.target.value))}>
          {Array.from({ length: MAX_PARALLEL }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </SetRow>
      <SetRow title={t("translationSettings.keepTerms")} htmlFor="keep-terms" desc={t("translationSettings.keepTermsDesc")}>
        <Switch id="keep-terms" checked={on} onChange={toggle} />
      </SetRow>
      <div className="set wide">
        <label className="h" htmlFor="tr-instructions">
          {t("translationSettings.instructions")}
        </label>
        <div className="d">{t("translationSettings.instructionsDesc")}</div>
        <textarea
          id="tr-instructions"
          value={instructions}
          rows={4}
          maxLength={MAX_INSTRUCTIONS}
          placeholder={t("common.none")}
          onChange={(e) => {
            setInstructions(e.target.value);
            setStatus(null);
          }}
        />
        <div className="acts">
          <button className="btn sm" onClick={saveInstructions} disabled={instructions.trim() === saved}>
            {t("common.save")}
          </button>
          <span className="muted">{status ?? `${instructions.length} / ${MAX_INSTRUCTIONS}`}</span>
        </div>
        <details>
          <summary>{t("translationSettings.showPrompt")}</summary>
          <pre aria-label={t("translationSettings.prompt")}>{prompt}</pre>
        </details>
      </div>
      <div className="set wide">
        <label className="h" htmlFor="tr-skip-sites">
          {t("translationSettings.skipSites")}
        </label>
        <div className="d">
          {t.rich("translationSettings.skipSitesDesc", {
            code: <code>*</code>,
            code2: <code>www.google.*</code>,
            code3: <code>https://example.com/docs/*</code>,
            code4: <code>!x.com/*/status/*</code>,
          })}
        </div>
        <textarea
          id="tr-skip-sites"
          value={sites}
          rows={5}
          spellCheck={false}
          placeholder={t("common.none")}
          onChange={(e) => {
            setSites(e.target.value);
            setSitesStatus(null);
          }}
        />
        <div className="acts">
          <button className="btn sm" onClick={saveSites} disabled={sites === savedSites}>
            {t("common.save")}
          </button>
          {sitesStatus && <span className="muted">{sitesStatus}</span>}
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
