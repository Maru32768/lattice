import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { MobileIndex } from "../bindings";
import { isLang, setDisplayLang, useT } from "../i18n";
import { ArticlePage } from "./ArticlePage";
import { ListPage } from "./ListPage";
import { PAGE, type ListView } from "./list";
import { articleInHash } from "./route";
import { Unauthorized, adoptToken, hasToken, loadIndex } from "./client";

const subscribeHash = (changed: () => void) => {
  addEventListener("hashchange", changed);
  return () => removeEventListener("hashchange", changed);
};

type Load = { state: "loading" } | { state: "failed" } | { state: "no-token" } | { state: "ready"; index: MobileIndex };

export function App() {
  const t = useT();
  const articleId = useSyncExternalStore(subscribeHash, () => articleInHash(location.hash));
  const [load, setLoad] = useState<Load>(() => (hasToken() ? { state: "loading" } : { state: "no-token" }));
  const [view, setView] = useState<ListView>({ filter: "unread", query: "", shown: PAGE });
  const [refreshFailed, setRefreshFailed] = useState(false);
  const listScroll = useRef(0);
  /** Only the latest request may change the screen: an older one can answer last. */
  const latest = useRef(0);

  const refresh = async () => {
    const request = ++latest.current;
    try {
      const index = await loadIndex();
      if (request !== latest.current) {
        return;
      }
      if (isLang(index.ui_language)) {
        setDisplayLang(index.ui_language);
      }
      setLoad({ state: "ready", index });
      setRefreshFailed(false);
    } catch (e) {
      if (request !== latest.current) {
        return;
      }
      const unauthorized = e instanceof Unauthorized;
      // What is on screen stays readable without a connection.
      setLoad((old) => (unauthorized ? { state: "no-token" } : old.state === "ready" ? old : { state: "failed" }));
      setRefreshFailed(true);
    }
  };

  const firstLoad = useEffectEvent(() => {
    if (hasToken()) {
      void refresh();
    }
  });
  // oxlint-disable-next-line react/set-state-in-effect -- fetching what the server has is why the effect exists
  useEffect(() => firstLoad(), []);

  // A new QR code opened in this tab changes only the fragment: no page load runs main.tsx.
  const onHashChange = useEffectEvent(() => {
    if (adoptToken()) {
      setLoad({ state: "loading" });
      void refresh();
    }
  });
  useEffect(() => {
    addEventListener("hashchange", onHashChange);
    return () => removeEventListener("hashchange", onHashChange);
  }, []);

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
        <button
          className="btn"
          onClick={() => {
            setLoad({ state: "loading" });
            void refresh();
          }}
        >
          {t("mobile.retry")}
        </button>
      </main>
    );
  }
  return (
    <ListPage
      index={load.index}
      view={view}
      onView={setView}
      refreshFailed={refreshFailed}
      onOpen={() => (listScroll.current = window.scrollY)}
      onRefresh={refresh}
    />
  );
}
