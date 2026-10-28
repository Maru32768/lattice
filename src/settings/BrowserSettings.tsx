import { useEffect, useState } from "react";
import { SetRow } from "../ui/SetRow";
import { api } from "../api";
import { ENGINES, getEngine, setEngine, validTemplate, type EngineId, type SearchEngine } from "../browser/engines";
import { useT } from "../i18n";

export function BrowserSettings() {
  const t = useT();
  const [engine, setState] = useState(getEngine);
  const save = (e: SearchEngine) => {
    setState(e);
    setEngine(e);
  };
  const [sites, setSites] = useState("");
  const [savedSites, setSavedSites] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .pageTranslateSkipSites()
      .then((s) => {
        setSites(s);
        setSavedSites(s);
      })
      .catch((e: unknown) => setError(String(e)));
  }, []);
  async function saveSites() {
    setError(null);
    try {
      const stored = await api.setPageTranslateSkipSites(sites);
      setSites(stored);
      setSavedSites(stored);
      setStatus(t("common.saved"));
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="grp">
      <SetRow title={t("browserSettings.engine")} htmlFor="search-engine" desc={t("browserSettings.engineDesc")}>
        <select id="search-engine" className="select" value={engine.id} onChange={(e) => save({ ...engine, id: e.target.value as EngineId })}>
          {ENGINES.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
          <option value="custom">{t("browserSettings.custom")}</option>
        </select>
      </SetRow>
      {engine.id === "custom" && (
        <SetRow
          title={t("browserSettings.template")}
          htmlFor="search-template"
          desc={<>{t.rich("browserSettings.templateDesc", { code: <code>%s</code>, code2: <code>https://example.com/search?q=%s</code> })}</>}
        >
          <input
            id="search-template"
            className="input"
            value={engine.custom}
            spellCheck={false}
            placeholder="https://…?q=%s"
            onChange={(e) => save({ ...engine, custom: e.target.value })}
          />
        </SetRow>
      )}
      {engine.id === "custom" && !validTemplate(engine.custom) && (
        <p className="msg error-text" role="alert">
          {t.rich("browserSettings.invalidTemplate", { code: <code>%s</code> })}
        </p>
      )}
      <div className="set wide">
        <label className="h" htmlFor="skip-sites">
          {t("browserSettings.skipSites")}
        </label>
        <div className="d">{t("browserSettings.skipSitesDesc")}</div>
        <textarea
          id="skip-sites"
          value={sites}
          rows={5}
          spellCheck={false}
          placeholder={t("common.none")}
          onChange={(e) => {
            setSites(e.target.value);
            setStatus(null);
          }}
        />
        <div className="acts">
          <button className="btn sm" onClick={saveSites} disabled={sites === savedSites}>
            {t("common.save")}
          </button>
          {status && <span className="muted">{status}</span>}
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
