import { useState } from "react";
import { SetRow } from "../ui/SetRow";
import { api } from "../api";
import { LANGS, LANGUAGE_NAMES, isLang, setDisplayLang, useT } from "../i18n";

export function LanguageSettings() {
  const t = useT();
  const [error, setError] = useState<string | null>(null);

  async function choose(lang: string) {
    if (!isLang(lang)) return;
    setDisplayLang(lang);
    setError(null);
    try {
      await api.setUiLanguage(lang);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="grp">
      <SetRow title={t("language.title")} htmlFor="ui-language" desc={t("language.desc")}>
        <select id="ui-language" className="select" value={t.lang} onChange={(e) => void choose(e.target.value)}>
          {LANGS.map((l) => <option key={l} value={l}>{LANGUAGE_NAMES[l]}</option>)}
        </select>
      </SetRow>
      {error && <p className="msg error-text" role="alert">{t.msg(error)}</p>}
    </div>
  );
}
