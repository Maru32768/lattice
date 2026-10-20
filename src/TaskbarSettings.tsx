import { useEffect, useState } from "react";
import { SetRow, Switch } from "./SetRow";
import { api } from "./api";

export function TaskbarSettings() {
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
      <SetRow title="未読数をタスクバーに表示" htmlFor="taskbar-badge"
        desc="タスクバーのアプリのボタンに未読の記事数を重ねて表示します（100 件以上は 99+、0 件のときは表示しません）。">
        <Switch id="taskbar-badge" checked={on} onChange={toggle} />
      </SetRow>
      {error && <p className="msg error-text" role="alert">{error}</p>}
    </div>
  );
}
