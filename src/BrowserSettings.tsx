import { useState } from "react";
import { SetRow } from "./SetRow";
import { ENGINES, getEngine, setEngine, validTemplate, type EngineId, type SearchEngine } from "./engines";

export function BrowserSettings() {
  const [engine, setState] = useState(getEngine);
  const save = (e: SearchEngine) => {
    setState(e);
    setEngine(e);
  };

  return (
    <div className="grp">
      <SetRow title="検索エンジン" htmlFor="search-engine"
        desc="URL バーに URL でない語を入力したときの検索と、ホームボタンで開くページ。">
        <select id="search-engine" className="select" value={engine.id} onChange={(e) => save({ ...engine, id: e.target.value as EngineId })}>
          {ENGINES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          <option value="custom">カスタム</option>
        </select>
      </SetRow>
      {engine.id === "custom" && (
        <SetRow title="検索 URL" htmlFor="search-template"
          desc={<>検索語の位置に <code>%s</code> を書きます（例: <code>https://example.com/search?q=%s</code>）。ホームはこの URL のサイトのトップページです。</>}>
          <input id="search-template" className="input" value={engine.custom} spellCheck={false} placeholder="https://…?q=%s"
            onChange={(e) => save({ ...engine, custom: e.target.value })} />
        </SetRow>
      )}
      {engine.id === "custom" && !validTemplate(engine.custom) && (
        <p className="msg error-text" role="alert"><code>%s</code> を含む http(s) の URL を入力してください。それまでは DuckDuckGo を使います。</p>
      )}
    </div>
  );
}
