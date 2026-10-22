import { useEffect, useState } from "react";
import { SetRow, Switch } from "../ui/SetRow";
import { api } from "../api";
import { useT } from "../i18n";

export function TaskbarSettings() {
  const t = useT();
  const [on, setOn] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.taskbarBadge().then(setOn).catch((e) => setError(String(e))); }, []);

  async function toggle(value: boolean) {
    setOn(value);
    setError(null);
    try {
      await api.setTaskbarBadge(value);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="grp">
      <SetRow title={t("taskbarSettings.badge")} htmlFor="taskbar-badge"
        desc={t("taskbarSettings.badgeDesc")}>
        <Switch id="taskbar-badge" checked={on} onChange={toggle} />
      </SetRow>
      {error && <p className="msg error-text" role="alert">{t.msg(error)}</p>}
    </div>
  );
}
