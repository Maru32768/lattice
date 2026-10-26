import { useEffect, useState } from "react";
import { api, type NetworkSettings as Value } from "../api";
import { useT } from "../i18n";

export function NetworkSettings() {
  const t = useT();
  const [mode, setMode] = useState<Value["mode"]>("public");
  const [allow, setAllow] = useState("");
  const [deny, setDeny] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api.networkSettings().then(
      (value) => {
        if (active) {
          setMode(value.mode);
          setAllow(value.allow.join("\n"));
          setDeny(value.deny.join("\n"));
          setLoaded(true);
        }
      },
      (e: unknown) => {
        if (active) {
          setError(String(e));
        }
      },
    );
    return () => {
      active = false;
    };
  }, []);

  async function save() {
    setSaving(true);
    setSaved(false);
    setError(null);
    const lines = (text: string) =>
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    try {
      await api.setNetworkSettings({ mode, allow: lines(allow), deny: lines(deny) });
      setSaved(true);
    } catch (e) {
      setError(String(e));
    }
    setSaving(false);
  }

  return (
    <div className="grp network-settings">
      <p className="msg">{t("networkSettings.default")}</p>
      <fieldset disabled={!loaded || saving}>
        <div className="set wide">
          <label className="h" htmlFor="network-allow">
            {t("networkSettings.allow")}
          </label>
          <div className="d">{t("networkSettings.allowDesc")}</div>
          <textarea
            id="network-allow"
            className="input"
            rows={5}
            value={allow}
            onChange={(e) => {
              setAllow(e.target.value);
              setSaved(false);
            }}
          />
        </div>
        <div className="set wide">
          <label className="h" htmlFor="network-deny">
            {t("networkSettings.deny")}
          </label>
          <div className="d">{t("networkSettings.denyDesc")}</div>
          <textarea
            id="network-deny"
            className="input"
            rows={4}
            value={deny}
            onChange={(e) => {
              setDeny(e.target.value);
              setSaved(false);
            }}
          />
        </div>
        <p className="msg">{t("networkSettings.rules")}</p>
        <details className="set wide">
          <summary>{t("networkSettings.advanced")}</summary>
          <label className="h" htmlFor="network-mode">
            {t("networkSettings.mode")}
          </label>
          <select
            id="network-mode"
            className="input"
            value={mode}
            onChange={(e) => {
              const value = e.target.value;
              if (value === "public" || value === "allowlist" || value === "unrestricted") {
                setMode(value);
                setSaved(false);
              }
            }}
          >
            <option value="public">{t("networkSettings.public")}</option>
            <option value="allowlist">{t("networkSettings.allowlist")}</option>
            <option value="unrestricted">{t("networkSettings.unrestricted")}</option>
          </select>
          <p className="d">{t("networkSettings.modeDesc")}</p>
        </details>
        <p className="msg">{t("networkSettings.proxy")}</p>
        <p className="msg">{t("networkSettings.scope")}</p>
        <button className="btn" onClick={save}>
          {t(saving ? "networkSettings.saving" : "common.save")}
        </button>
      </fieldset>
      {saved && (
        <p className="msg" role="status">
          {t("common.saved")}
        </p>
      )}
      {error && (
        <p className="msg error-text" role="alert">
          {t.msg(error)}
        </p>
      )}
    </div>
  );
}
