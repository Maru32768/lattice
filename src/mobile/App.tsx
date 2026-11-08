import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { MobileIndex, MobileOp } from "../bindings";
import { isLang, setDisplayLang, useT } from "../i18n";
import { ArticlePage } from "./ArticlePage";
import { ListPage } from "./ListPage";
import { FIRST_VIEW, type ListView } from "./list";
import { keep, viewKey } from "../library/library";
import { articleInHash } from "./route";
import { Crashed } from "./ErrorBoundary";
import { QrScan, canScan } from "./QrScan";
import {
  FormatMismatch,
  Unauthorized,
  adoptToken,
  disconnect,
  flushOps,
  hasToken,
  loadIcons,
  loadIndex,
  localOps,
  submit,
  subscribeOps,
  whenRejected,
  withOps,
} from "./client";

const subscribeHash = (changed: () => void) => {
  addEventListener("hashchange", changed);
  return () => removeEventListener("hashchange", changed);
};

/** What a refusal should name, so that the reader knows what to do again. */
const whatOf = ({ op }: MobileOp) => (op.kind === "vocab_add" ? op.capture.surface : op.kind === "save_url" ? op.url : "");

/** Where the QR code cannot open the page (on iOS, the home screen's page has storage of its own): scan it here, or paste its link. */
function Connect({ onAdopted }: { onAdopted: (adopted: "same library" | "other library") => void }) {
  const t = useT();
  const [link, setLink] = useState("");
  const [bad, setBad] = useState(false);
  const [scanning, setScanning] = useState(false);
  const take = (text: string) => {
    const adopted = adoptToken(text);
    if (adopted) {
      onAdopted(adopted);
      return true;
    }
    setBad(true);
    return false;
  };
  return (
    <form
      className="m-paste"
      onSubmit={(e) => {
        e.preventDefault();
        take(link);
      }}
    >
      {scanning ? (
        <QrScan onCode={take} onStop={() => setScanning(false)} />
      ) : (
        canScan() && (
          <button type="button" className="btn pri m-scan-start" onClick={() => setScanning(true)}>
            {t("mobile.scanQr")}
          </button>
        )
      )}
      <input
        className="input"
        // Not type="url": the form would refuse a bare #t=… before it reached adoptToken.
        type="text"
        inputMode="url"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        value={link}
        onChange={(e) => {
          setLink(e.target.value);
          setBad(false);
        }}
        placeholder="https://…#t=…"
        aria-label={t("mobile.pasteLink")}
      />
      <button className="btn" type="submit" disabled={!link.trim()}>
        {t("mobile.connect")}
      </button>
      {bad && <p role="alert">{t("mobile.noTokenInLink")}</p>}
    </form>
  );
}

type Load = { state: "loading" } | { state: "failed" } | { state: "no-token" } | { state: "format" } | { state: "ready"; index: MobileIndex };

export function App() {
  const t = useT();
  const articleId = useSyncExternalStore(subscribeHash, () => articleInHash(location.hash));
  const [load, setLoad] = useState<Load>(() => (hasToken() ? { state: "loading" } : { state: "no-token" }));
  const [view, setView] = useState<ListView>(FIRST_VIEW);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [icons, setIcons] = useState<Record<string, string>>({});
  /** The icons are asked for once per page and library. */
  const iconsAsked = useRef(false);
  const ops = useSyncExternalStore(subscribeOps, localOps);
  const [rejected, setRejected] = useState<{ what: string; error: string }[]>([]);
  const listScroll = useRef(0);
  /** Set when the article on screen was opened from the list, so going back to the list is going back in history. */
  const fromList = useRef(false);
  /** Only the latest request may change the screen: an older one can answer last. */
  const latest = useRef(0);

  const refresh = async () => {
    const request = ++latest.current;
    // Not awaited: a sleeping PC would hold up the list by a second timeout, and the list shows what is pending anyway.
    void flushOps();
    try {
      const { index, saved } = await loadIndex();
      if (request !== latest.current) {
        return;
      }
      if (isLang(index.ui_language)) {
        setDisplayLang(index.ui_language);
      }
      setLoad({ state: "ready", index });
      // After the list, which says where the PC is: the icons come from the same place. Once per page: they rarely
      // change, and a refresh need not fetch them again on mobile data.
      if (!iconsAsked.current) {
        iconsAsked.current = true;
        // Not kept when another request has taken over, or when it failed: the next refresh asks again.
        const ask = () => {
          iconsAsked.current = false;
        };
        void loadIcons().then((got) => (request === latest.current ? setIcons(got) : ask()), ask);
      }
      setRefreshFailed(saved);
    } catch (e) {
      if (request !== latest.current) {
        return;
      }
      const fatal: Load | null = e instanceof Unauthorized ? { state: "no-token" } : e instanceof FormatMismatch ? { state: "format" } : null;
      // What is on screen stays readable without a connection.
      setLoad((old) => fatal ?? (old.state === "ready" ? old : { state: "failed" }));
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
    const adopted = adoptToken();
    if (adopted) {
      if (adopted === "other library") {
        iconsAsked.current = false;
        // Article ids mean something else in another library: nothing kept in the view may carry over.
        setView(FIRST_VIEW);
      }
      setLoad({ state: "loading" });
      void refresh();
    }
  });
  useEffect(() => {
    addEventListener("hashchange", onHashChange);
    return () => removeEventListener("hashchange", onHashChange);
  }, []);

  // What waits on this phone goes as soon as there may be a way: nothing tells the page when the PC wakes.
  useEffect(() => {
    const send = () => void flushOps();
    const sendIfShown = () => {
      if (document.visibilityState === "visible") {
        send();
      }
    };
    whenRejected((op, error) => setRejected((old) => [...old, { what: whatOf(op) || op.op.kind, error }]));
    addEventListener("online", send);
    document.addEventListener("visibilitychange", sendIfShown);
    return () => {
      removeEventListener("online", send);
      document.removeEventListener("visibilitychange", sendIfShown);
    };
  }, []);

  // Back from an article lands where the reader left the list.
  const reading = articleId != null;
  useLayoutEffect(() => {
    window.scrollTo(0, reading ? 0 : listScroll.current);
  }, [reading]);

  const notice = rejected.length > 0 && (
    <div role="alert" className="m-toast" onClick={() => setRejected([])}>
      {rejected.map((r, i) => (
        <p key={i}>{t("mobile.rejected", { what: r.what, error: t.msg(r.error) })}</p>
      ))}
    </div>
  );
  if (load.state === "format") {
    return <Crashed />;
  }
  if (load.state === "no-token") {
    return (
      <main className="m-empty">
        <h1>Lattice</h1>
        <p>{t("mobile.noToken")}</p>
        <Connect
          onAdopted={(adopted) => {
            if (adopted === "other library") {
              iconsAsked.current = false;
              setView(FIRST_VIEW);
            }
            setLoad({ state: "loading" });
            void refresh();
          }}
        />
        {/* A token just regenerated reaches the Worker a little later, and this may be another server on the port. */}
        {hasToken() && (
          <button
            className="btn"
            onClick={() => {
              setLoad({ state: "loading" });
              void refresh();
            }}
          >
            {t("mobile.retry")}
          </button>
        )}
      </main>
    );
  }
  const index = load.state === "ready" ? load.index : null;
  const unsent = ops.filter((o) => !o.sent).length;
  // Those the list on screen already shows: it may be the PC's, which settles nothing.
  const shownOps = ops.filter((o) => !index?.applied_ops.includes(o.id));
  if (articleId != null) {
    return (
      <>
        {notice}
        <ArticlePage
          key={articleId}
          id={articleId}
          row={index?.articles.find((a) => a.id === articleId)}
          ops={shownOps}
          unsent={unsent}
          writable={index != null && !index.read_only}
          onGone={() => void refresh()}
          onBack={(e) => {
            // Back and forth must not pile up in history, so the phone's back button leaves the list as it should.
            if (fromList.current) {
              e.preventDefault();
              fromList.current = false;
              history.back();
            }
          }}
        />
      </>
    );
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
    <>
      {notice}
      <ListPage
        articles={load.index.articles.map((a) => withOps(a, shownOps))}
        groups={load.index.groups ?? []}
        icons={icons}
        unsent={unsent}
        writable={!load.index.read_only}
        view={view}
        onView={setView}
        generatedAt={load.index.generated_at}
        refreshFailed={refreshFailed}
        onDisconnect={() => {
          latest.current++; // a late answer must not bring the list back
          void disconnect().then(() => {
            iconsAsked.current = false;
            setIcons({});
            setView(FIRST_VIEW);
            setLoad({ state: "no-token" });
          });
        }}
        onOpen={(a) => {
          listScroll.current = window.scrollY;
          fromList.current = true;
          setView((v) => ({ ...v, kept: keep(v.kept, viewKey(v.scope, v.facets), a.id) }));
          // Opening an article reads it, as on the PC. Only this: reloading the page must not undo 未読に戻す.
          if (a.read_status === "unread" && !load.index.read_only) {
            submit({ kind: "set_read", article_id: a.id, read: true });
          }
        }}
        onRefresh={refresh}
      />
    </>
  );
}
