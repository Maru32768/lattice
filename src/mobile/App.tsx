import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { MobileIndex } from "../bindings";
import { isLang, setDisplayLang, useT } from "../i18n";
import { ArticlePage } from "./ArticlePage";
import { ListPage } from "./ListPage";
import type { ListView } from "./list";
import { articleInHash } from "./route";
import { Unauthorized, hasToken, loadIndex } from "./client";

const subscribeHash = (changed: () => void) => {
  addEventListener("hashchange", changed);
  return () => removeEventListener("hashchange", changed);
};

type Load = { state: "loading" } | { state: "failed" } | { state: "no-token" } | { state: "ready"; index: MobileIndex };

export function App() {
  const t = useT();
  const articleId = useSyncExternalStore(subscribeHash, () => articleInHash(location.hash));
  const [load, setLoad] = useState<Load>(() => (hasToken() ? { state: "loading" } : { state: "no-token" }));
  const [view, setView] = useState<ListView>({ filter: "unread", query: "", shown: 100 });
  const listScroll = useRef(0);

  const refresh = async () => {
    try {
      const index = await loadIndex();
      if (isLang(index.ui_language)) {
        setDisplayLang(index.ui_language);
      }
      setLoad({ state: "ready", index });
    } catch (e) {
      setLoad(e instanceof Unauthorized ? { state: "no-token" } : { state: "failed" });
    }
  };

  const firstLoad = useEffectEvent(() => {
    if (hasToken()) {
      void refresh();
    }
  });
  // oxlint-disable-next-line react/set-state-in-effect -- fetching what the server has is why the effect exists
  useEffect(() => firstLoad(), []);

  // Back from an article lands where the reader left the list.
  const reading = articleId != null;
  useLayoutEffect(() => {
    window.scrollTo(0, reading ? 0 : listScroll.current);
  }, [reading]);

  if (load.state === "no-token") {
    return (
      <main className="m-empty">
        <h1>Lattice</h1>
        <p>{t("mobile.noToken")}</p>
      </main>
    );
  }
  if (articleId != null) {
    return <ArticlePage key={articleId} id={articleId} />;
  }
  if (load.state === "loading") {
    return <p className="m-empty">{t("mobile.loading")}</p>;
  }
  if (load.state === "failed") {
    return (
      <main className="m-empty">
        <p role="alert">{t("mobile.loadFailed")}</p>
        <button className="btn" onClick={() => void refresh()}>
          {t("mobile.retry")}
        </button>
      </main>
    );
  }
  return <ListPage index={load.index} view={view} onView={setView} onOpen={() => (listScroll.current = window.scrollY)} onRefresh={refresh} />;
}
