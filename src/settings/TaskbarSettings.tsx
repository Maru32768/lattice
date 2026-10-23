import { useEffect, useState } from "react";
import { SetRow, Switch } from "../ui/SetRow";
import { api } from "../api";
import { useT, type PlainKey } from "../i18n";

export function TaskbarSettings() {
  return (
    <div className="grp">
      <Toggle
        id="autostart"
        title="taskbarSettings.autostart"
        desc="taskbarSettings.autostartDesc"
        initial={false}
        load={api.autostart}
        save={api.setAutostart}
      />
      <Toggle
        id="taskbar-badge"
        title="taskbarSettings.badge"
        desc="taskbarSettings.badgeDesc"
        initial={true}
        load={api.taskbarBadge}
        save={api.setTaskbarBadge}
      />
    </div>
  );
}

function Toggle({
  id,
  title,
  desc,
  initial,
  load,
  save,
}: {
  id: string;
  title: PlainKey;
  desc: PlainKey;
  initial: boolean;
  load: () => Promise<boolean>;
  save: (on: boolean) => Promise<void>;
}) {
  const t = useT();
  const [on, setOn] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    load()
      .then(setOn)
      .catch((e: unknown) => setError(String(e)));
  }, [load]);

  async function toggle(value: boolean) {
    setOn(value);
    setError(null);
    try {
      await save(value);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <>
      <SetRow title={t(title)} htmlFor={id} desc={t(desc)}>
        <Switch id={id} checked={on} onChange={toggle} />
      </SetRow>
      {error && (
        <p className="msg error-text" role="alert">
          {t.msg(error)}
        </p>
      )}
    </>
  );
}
