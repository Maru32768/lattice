import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { browser, type ArticleRow, type ArticleView, type Bounds, type OverlayLabels } from "../api";
import type { LanguageMode } from "../reader/mixed";
import type { PageTab } from "../layout/layout";
import { ArticleTools, LangSeg, Summary, ViewSeg, type DocActions } from "../reader/Reader";
import { QuizPanel, useQuizOpen } from "../quiz/QuizPanel";
import { Menu, pageDrawn, useCovered } from "../ui/Popover";
import { Icon } from "../ui/Icon";
import { getEngine, homeOf, toNavigation } from "./engines";
import { useT, type T } from "../i18n";

/** The `seq` each tab's webview (by key) was last told to open: a tab shown again is not reloaded. */
const opened = new Map<string, number>();
/** The tab left this window with its webview: a return opens (attaches) it again rather than only resizing it. */
export const forgetOpened = (key: string) => void opened.delete(key);
/**
 * Tabs whose view just unmounted. Their webview is hidden after the current task unless the same
 * tab mounts again first (StrictMode's second mount, a move to another pane): a hide sent between
 * two shows could reach the backend last and leave the page blank until the next resize.
 */
const leaving = new Set<string>();
/** A WebView2 shown again needs a moment to draw; the still under it stays until then. */
const SHOW_SETTLE_MS = 150;
/** How long the bounds are checked every frame after the placeholder appears or resizes (layout settling, fonts, banners). */
const FOLLOW_MS = 600;
/** How long a still captured ahead of an overlay (see `warm`) may stand in for the page. */
const WARM_MS = 10_000;
/** Panes whose popovers and menus stay inside the pane, off the page webview (the nav's open beside it). */
const OFF_PAGE = new Set(["list", "chat"]);

function boundsOf(el: HTMLElement | null): Bounds | null {
  const r = el?.getBoundingClientRect();
  return r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null;
}

const failedOf = (v: ArticleView) => v.article.fetch_status === "failed" || v.article.extraction_status === "failed";
const SUMMARY_KEY = "lattice.pageSummary";
/** Whether the Page view shows the saved article's summary strip: a per-device choice. */
function summaryShown() {
  try {
    return localStorage.getItem(SUMMARY_KEY) === "1";
  } catch {
    return false;
  }
}
function showSummary(on: boolean) {
  try {
    localStorage.setItem(SUMMARY_KEY, on ? "1" : "0");
  } catch { /* the choice lasts for this view only */ }
  return on;
}

export interface PageLang {
  mode: LanguageMode;
  percent: number;
}

/** The overlay's switch and ratio for a language choice: 原文 = off, 訳文 = 100 %. */
export const overlayOf = (l: PageLang) => ({ enabled: l.mode !== "original", percent: l.mode === "translated" ? 100 : l.percent });

/** The overlay's tooltip text in the display language. */
export const overlayLabels = (t: T): OverlayLabels => ({
  original: t("reader.original"), translated: t("reader.translated"), flip: t("overlay.flip"),
  translating: t("reader.translatingEllipsis"), failed: t("overlay.failed"), retry: t("overlay.retry"),
  save_word: t("vocab.save"), saved_word: t("vocab.savedShort"),
});

/** https:// + host emphasized + the rest; a click edits it, with the whole URL selected. */
function UrlBar({ url, onGo }: { url: string; onGo: (input: string) => void }) {
  const t = useT();
  const [draft, setDraft] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const editing = draft != null;
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  if (editing) {
    return (
      <input ref={input} className="url-pill" value={draft} autoFocus spellCheck={false} aria-label={t("browserView.urlPlaceholder")}
        onChange={(e) => setDraft(e.target.value)} onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || (e.key !== "Enter" && e.key !== "Escape")) return;
          e.preventDefault();
          if (e.key === "Enter") onGo(draft);
          setDraft(null);
        }} />
    );
  }
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/i.exec(url);
  return (
    <button type="button" className="url-pill" title={url} onClick={() => setDraft(url)}>
      <span className="vh">{t("browserView.urlLabel")}</span>
      {m ? <>{m[1]}<b>{m[2]}</b>{m[3]}</> : url}
    </button>
  );
}

/**
 * Toolbar plus a placeholder box for one Page tab; the tab's native webview is kept positioned
 * over the box. Page content never enters this (app) webview.
 */
export function BrowserView({ tab, saved, view, act, saving, lang, onNavigate, onLang, onSave, onReader, onError }: {
  tab: PageTab;
  saved: ArticleRow | null;
  /** The saved article's view (its summary), once loaded. */
  view: ArticleView | null;
  /** The saved article's actions, shared with the Reader's toolbar (H14). */
  act: DocActions | null;
  saving: boolean;
  lang: PageLang;
  /** Opens an http(s) URL typed in the URL bar or the home page. */
  onNavigate: (url: string) => void;
  onLang: (l: PageLang) => void;
  onSave: () => void;
  onReader: () => void;
  onError: (e: string) => void;
}) {
  const t = useT();
  const id = tab.key;
  const host = useRef<HTMLDivElement>(null);
  // Open app overlays (palette, popover, menu): the native webview would hide any it overlaps, so a still of it stands in.
  const covered = useCovered(host);
  const [still, setStill] = useState<string | null>(null);
  const [summary, setSummary] = useState(summaryShown);
  const [quiz, setQuiz] = useQuizOpen(saved?.id ?? 0);
  /** The page as drawn now, decoded; null while it loads or off Windows. */
  const grab = useEffectEvent(async () => {
    const png = tab.loading ? null : await browser.capture(id).catch(() => null);
    if (png) {
      const img = new Image();
      img.src = png;
      await img.decode().catch(() => {});
    }
    return png;
  });
  /**
   * A capture takes a few hundred ms, and the overlay stays under the webview until it is done.
   * So a still is taken when the pointer reaches a control that opens one (`aria-haspopup`), and
   * the overlay that follows uses it (or waits for it, already under way) (H8).
   */
  const warm = useRef<{ png: Promise<string | null>; at: number; page: string } | null>(null);
  // A still of the previous page must not stand in for the next one.
  const page = `${tab.seq}:${tab.loading}`;
  const warmFor = (maxAge: number) => {
    const w = warm.current;
    return w && w.page === page && performance.now() - w.at < maxAge ? w : null;
  };
  const warmUp = useEffectEvent(() => {
    if (covered || warmFor(WARM_MS / 2)) return;
    warm.current = { png: grab(), at: performance.now(), page };
  });
  const takeStill = useEffectEvent(() => {
    const w = warmFor(WARM_MS);
    warm.current = null;
    return w ? w.png : grab();
  });
  // While an open is in flight, setBounds would re-show the previous page before the backend
  // knows a new one is loading; the open places the webview itself.
  const opening = useRef(false);
  /** Opens the tab's URL at `b`; the caller places the webview again once it is done. */
  const open = useEffectEvent((b: Bounds, focus?: string) => {
    opening.current = true;
    opened.set(id, tab.seq);
    return browser.open(id, tab.url, b, focus).catch((e: unknown) => onError(String(e))).finally(() => {
      opening.current = false;
    });
  });
  const placeable = useEffectEvent(() => !covered && !opening.current);
  /** The bounds last sent; `follow` sends again only on a change. */
  const sent = useRef("");
  const sync = useEffectEvent(async () => {
    while (true) {
      const b = boundsOf(host.current);
      if (!b || !placeable()) return;
      sent.current = JSON.stringify(b);
      const exists = await browser.setBounds(id, b).catch(() => true); // also re-shows it
      // Evicted while hidden, or restored from the saved layout: the tab reopens its URL.
      if (exists || opening.current) return;
      await open(b);
    }
  });
  /** The placeholder can move without resizing (a pane appearing beside it), which no ResizeObserver reports. */
  const followUntil = useRef(0);
  const follow = useEffectEvent(() => {
    const running = followUntil.current > performance.now();
    followUntil.current = performance.now() + FOLLOW_MS;
    if (running) return;
    const frame = () => {
      if (!host.current) return;
      if (JSON.stringify(boundsOf(host.current)) !== sent.current) void sync();
      if (performance.now() < followUntil.current) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });

  useLayoutEffect(() => {
    // Open each navigation once: showing the tab again (or a StrictMode re-run) must not
    // reload the page, which would also cancel the first load and lose its scroll target.
    if ((opened.get(id) ?? -1) >= tab.seq) return;
    void open(boundsOf(host.current)!, tab.focus).then(() => sync());
  }, [id, tab.seq, tab.focus]);

  useEffect(() => {
    let live = true;
    if (!covered) {
      pageDrawn(id, () => host.current?.getBoundingClientRect());
      void (async () => {
        await sync();
        follow();
        await new Promise((r) => setTimeout(r, SHOW_SETTLE_MS));
        if (live) setStill(null);
      })();
      return () => { live = false; };
    }
    // The still is painted under the webview before it hides, so no blank frame shows in between.
    void (async () => {
      const png = await takeStill();
      if (png && live) {
        setStill(png);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }
      if (!live) return;
      await browser.hide(id).catch(() => {});
      // Overlays over the page wait for this before they show (H22).
      if (live) pageDrawn(id, null);
    })();
    return () => { live = false; };
  }, [id, covered]);

  useEffect(() => {
    const resize = () => {
      warm.current = null;
      void sync();
      follow();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host.current!);
    window.addEventListener("resize", resize);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", resize);
      followUntil.current = 0;
    };
  }, []);
  useEffect(() => {
    const over = (e: PointerEvent) => {
      const el = (e.target as Element).closest?.("[aria-haspopup]");
      if (el && !OFF_PAGE.has(el.closest("[data-pane]")?.getAttribute("data-pane") ?? "")) warmUp();
    };
    // A context menu opens when the right button is released, anywhere a row or a tab is: start on the press.
    const press = (e: PointerEvent) => void (e.button === 2 && warmUp());
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerdown", press);
    return () => {
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerdown", press);
    };
  }, []);

  useLayoutEffect(() => {
    leaving.delete(id);
    return () => {
      pageDrawn(id, null);
      leaving.add(id);
      queueMicrotask(() => { if (leaving.delete(id)) browser.hide(id).catch(() => {}); });
    };
  }, [id]);

  const { url, loading } = tab;
  const shown = saved && view && act && view.article.id === saved.id ? view : null;
  const copyUrl = () => navigator.clipboard.writeText(url).catch((e: unknown) => onError(String(e)));
  return (
    <div className="doc">
      <div className="docbar pg">
        <ViewSeg page onReader={onReader} onPage={() => {}} readerDisabled={!saved} />
        <div className="vsep" />
        <LangSeg mode={lang.mode} percent={lang.percent} onChange={(mode, percent) => onLang({ mode, percent })} label={t("browserView.translate")} />
        <div className="vsep" />
        <button className="ib" onClick={() => browser.go(id, "back")} disabled={tab.canGoBack === false} aria-label={t("browserView.back")} title={t("browserView.back")}><Icon name="left" /></button>
        <button className="ib" onClick={() => browser.go(id, "forward")} disabled={tab.canGoForward === false} aria-label={t("browserView.forward")} title={t("browserView.forward")}><Icon name="right" /></button>
        <button className="ib" onClick={() => browser.go(id, "reload")} aria-label={t("browserView.reload")} title={t("browserView.reload")}><Icon name="reload" /></button>
        <button className="ib" onClick={() => onNavigate(homeOf(getEngine()))} aria-label={t("browserView.home")} title={t("browserView.home")}><Icon name="home" /></button>
        <UrlBar url={url} onGo={(input) => {
          const next = toNavigation(input, getEngine());
          if (next) onNavigate(next);
        }} />
        {saved && <span className="indexed" title={t("browserView.indexed")}><Icon name="check" /><span className="lbl">{t("browserView.indexed")}</span></span>}
        {shown && act ? (
          <ArticleTools view={shown} act={act} quizOpen={quiz} onQuiz={() => setQuiz((q) => !q)}
            rerender={{ label: saving ? t("browserView.saving") : t("browserView.saveRendered"), onSelect: onSave, disabled: saving || loading }}>
            {!failedOf(shown) && (
              <button className={`tb${summary ? " on" : ""}`} aria-pressed={summary} aria-label={t("reader.summary")} title={t("browserView.summaryHint")}
                onClick={() => setSummary(showSummary(!summary))}><Icon name="summary" /><span className="lbl">{t("reader.summary")}</span></button>
            )}
          </ArticleTools>
        ) : !saved && (
          <div className="docbar-r">
            <button className="tb pri" onClick={onSave} disabled={saving || loading}
              title={t("browserView.addHint")}><Icon name="import" />{saving ? t("browserView.adding") : t("browserView.add")}</button>
            <Menu className="tb" label={t("browserView.more")} align="right" trigger={<Icon name="more" />} items={[
              { label: t("articleMenu.copyUrl"), onSelect: () => void copyUrl() },
            ]} />
          </div>
        )}
      </div>
      <div className={`page-progress${loading ? " on" : ""}`} role={loading ? "progressbar" : undefined} aria-label={loading ? t("browserView.loading") : undefined}><b /></div>
      {/* A strip above the page; the webview shrinks to the placeholder below it. */}
      {summary && shown && !failedOf(shown) && <div className="page-summary"><Summary view={shown} onSummarize={act!.onSummarize} /></div>}
      <div className="doc-body">
      {/* The native webview stays hidden until an opened page has loaded, uncovering this. */}
      <div ref={host} className="page-host">
        {still ? <img className="page-still" src={still} alt="" /> : loading && <span className="muted">{t("browserView.loadingEllipsis")}</span>}
      </div>
      {quiz && shown && act && <QuizPanel view={shown} onSource={(b) => act.onFocusBlock(b, t("reader.quizSource"))} onReviewChanged={act.onReviewChanged} onClose={() => setQuiz(false)} />}
      </div>
    </div>
  );
}
