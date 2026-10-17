import { useEffect, useState } from "react";
import { SetRow, Switch } from "./SetRow";
import { api } from "./api";

export function RenderSettings() {
  const [on, setOn] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.autoRender().then(setOn).catch((e) => setError(String(e))); }, []);

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
      <SetRow title="JS ページを自動で描画" htmlFor="auto-render"
        desc="一括インポート・RSS などで本文がほとんど取れなかった記事を、裏の非表示ブラウザで 1 件ずつ描画して取り込み直します（1 件あたり最大 20 秒ほど）。">
        <Switch id="auto-render" checked={on} onChange={toggle} />
      </SetRow>
      {error && <p className="msg error-text" role="alert">{error}</p>}
    </div>
  );
}
