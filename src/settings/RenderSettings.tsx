import { useEffect, useState } from "react";
import { SetRow, Switch } from "../ui/SetRow";
import { api } from "../api";
import { useT } from "../i18n";

export function RenderSettings() {
  const t = useT();
  const [on, setOn] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .autoRender()
      .then(setOn)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  async function toggle(value: boolean) {
    setOn(value);
    setError(null);
    try {
      await api.setAutoRender(value);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="grp">
      <SetRow title={t("renderSettings.auto")} htmlFor="auto-render" desc={t("renderSettings.autoDesc")}>
        <Switch id="auto-render" checked={on} onChange={toggle} />
      </SetRow>
      {error && (
        <p className="msg error-text" role="alert">
          {t.msg(error)}
        </p>
      )}
    </div>
  );
}
