import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { browser, type ArticleRow, type Bounds, type OverlayLabels } from "./api";
import type { LanguageMode } from "./mixed";
import type { PageTab } from "./layout";
import { LangSeg, ViewSeg } from "./Reader";
import { Menu, intersects, useOverlays } from "./Popover";
import { Icon } from "./Icon";
import { getEngine, homeOf, toNavigation } from "./engines";
import { useT, type T } from "./i18n";

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
/** Panes whose popovers and menus stay inside the pane, off the page webview. */
const OFF_PAGE = new Set(["nav", "list", "chat"]);

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
export function BrowserView({ tab, saved, saving, lang, onNavigate, onLang, onSave, onReader, onFavorite, onDelete, onError }: {
  tab: PageTab;
  saved: ArticleRow | null;
  saving: boolean;
  lang: PageLang;
  /** Opens an http(s) URL typed in the URL bar or the home page. */
  onNavigate: (url: string) => void;
  onLang: (l: PageLang) => void;
  onSave: () => void;
  onReader: () => void;
  onFavorite: () => void;
  /** Asks for confirmation, then removes the saved article from the Index. */
  onDelete: () => void;
  onError: (e: string) => void;
}) {
  const t = useT();
  const id = tab.key;
  const host = useRef<HTMLDivElement>(null);
  const bounds = (): Bounds | null => {
    const r = host.current?.getBoundingClientRect();
    return r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null;
  };
  // Open app overlays (palette, popover, menu): the native webview would hide any it overlaps, so a still of it stands in.
  const overlays = useOverlays();
  const hostRect = host.current?.getBoundingClientRect();
  const covered = !!hostRect && overlays.some((r) => intersects(r, hostRect));
  const coveredRef = useRef(covered);
  coveredRef.current = covered;
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const [still, setStill] = useState<string | null>(null);
  /** The page as drawn now, decoded; null while it loads or off Windows. */
  const grab = async () => {
    const png = tabRef.current.loading ? null : await browser.capture(id).catch(() => null);
    if (png) {
      const img = new Image();
      img.src = png;
      await img.decode().catch(() => {});
    }
    return png;
  };
  /**
   * A capture takes a few hundred ms, and the overlay stays under the webview until it is done.
   * So a still is taken when the pointer reaches a control that opens one (`aria-haspopup`), and
   * the overlay that follows uses it (or waits for it, already under way) (H8).
   */
  const warm = useRef<{ png: Promise<string | null>; at: number } | null>(null);
  // While an open is in flight, setBounds would re-show the previous page before the backend
  // knows a new one is loading; the open places the webview itself.
  const opening = useRef(false);
  const open = (b: Bounds, focus?: string) => {
    opening.current = true;
    opened.set(id, tabRef.current.seq);
    return browser.open(id, tabRef.current.url, b, focus).catch((e) => onError(String(e))).finally(() => {
      opening.current = false;
      void sync();
    });
  };
  /** The bounds last sent; `follow` sends again only on a change. */
  const sent = useRef("");
  const sync = async () => {
    const b = bounds();
    if (!b || coveredRef.current || opening.current) return;
    sent.current = JSON.stringify(b);
    const exists = await browser.setBounds(id, b).catch(() => true); // also re-shows it
    // Evicted while hidden, or restored from the saved layout: the tab reopens its URL.
    if (!exists && !opening.current) await open(b);
  };
  /** The placeholder can move without resizing (a pane appearing beside it), which no ResizeObserver reports. */
  const followUntil = useRef(0);
  const follow = () => {
    const running = followUntil.current > performance.now();
    followUntil.current = performance.now() + FOLLOW_MS;
    if (running) return;
    const frame = () => {
      if (!host.current) return;
      if (JSON.stringify(bounds()) !== sent.current) void sync();
      if (performance.now() < followUntil.current) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  };

  useLayoutEffect(() => {
    // Open each navigation once: showing the tab again (or a StrictMode re-run) must not
    // reload the page, which would also cancel the first load and lose its scroll target.
    if ((opened.get(id) ?? -1) >= tab.seq) return;
    void open(bounds()!, tab.focus);
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- each navigation opens once; onError only reports
  }, [tab.seq]);

  useEffect(() => {
    let live = true;
    if (!covered) {
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
      const w = warm.current;
      warm.current = null;
      const png = await (w && performance.now() - w.at < WARM_MS ? w.png : grab());
      if (png && live) {
        setStill(png);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }
      if (live) await browser.hide(id).catch(() => {});
    })();
    return () => { live = false; };
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- the tab key is fixed per instance (keyed by id); sync reads refs
  }, [covered]);

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
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- the tab key is fixed per instance (keyed by id); sync reads refs
  }, []);
  useEffect(() => {
    const over = (e: PointerEvent) => {
      const el = (e.target as Element).closest?.("[aria-haspopup]");
      if (!el || coveredRef.current || OFF_PAGE.has(el.closest("[data-pane]")?.getAttribute("data-pane") ?? "")) return;
      if (warm.current && performance.now() - warm.current.at < WARM_MS / 2) return;
      warm.current = { png: grab(), at: performance.now() };
    };
    document.addEventListener("pointerover", over);
    return () => document.removeEventListener("pointerover", over);
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- the tab key is fixed per instance (keyed by id); grab reads refs
  }, []);
  // A still of the previous page must not stand in for the next one.
  useEffect(() => { warm.current = null; }, [tab.seq, tab.loading]);

  useLayoutEffect(() => {
    leaving.delete(id);
    return () => {
      leaving.add(id);
      queueMicrotask(() => { if (leaving.delete(id)) browser.hide(id).catch(() => {}); });
    };
  }, [id]);

  const { url, loading } = tab;
  const resave = saved && (saved.thin || saved.fetch_status === "failed" || saved.extraction_status === "failed");
  return (
    <div className="doc">
      <div className="docbar">
        <ViewSeg page onReader={onReader} onPage={() => {}} readerDisabled={!saved} />
        <div className="vsep" />
        <button className="ib" onClick={() => browser.go(id, "back")} disabled={tab.canGoBack === false} aria-label={t("browserView.back")} title={t("browserView.back")}><Icon name="left" /></button>
        <button className="ib" onClick={() => browser.go(id, "forward")} disabled={tab.canGoForward === false} aria-label={t("browserView.forward")} title={t("browserView.forward")}><Icon name="right" /></button>
        <button className="ib" onClick={() => browser.go(id, "reload")} aria-label={t("browserView.reload")} title={t("browserView.reload")}><Icon name="reload" /></button>
        <button className="ib" onClick={() => onNavigate(homeOf(getEngine()))} aria-label={t("browserView.home")} title={t("browserView.home")}><Icon name="home" /></button>
        <UrlBar url={url} onGo={(input) => {
          const next = toNavigation(input, getEngine());
          if (next) onNavigate(next);
        }} />
        <LangSeg mode={lang.mode} percent={lang.percent} onChange={(mode, percent) => onLang({ mode, percent })} label={t("browserView.translate")} />
        {saved ? (
          <>
            <span className="indexed"><Icon name="check" />{t("browserView.indexed")}</span>
            <button className={`tb${saved.favorite ? " on" : ""}`} onClick={onFavorite} aria-pressed={saved.favorite} aria-label={t("browserView.favorite")} title={t("browserView.favorite")}><Icon name="star" /></button>
            <Menu className="tb" label={t("browserView.more")} align="right" trigger={<Icon name="more" />} items={[
              ...(resave ? [{ label: saving ? t("browserView.saving") : t("browserView.saveRendered"), onSelect: onSave, disabled: saving || loading }, "-" as const] : []),
              { label: <span className="error-text">{t("browserView.remove")}</span>, onSelect: onDelete },
            ]} />
          </>
        ) : (
          <button className="tb pri" onClick={onSave} disabled={saving || loading}
            title={t("browserView.addHint")}><Icon name="import" />{saving ? t("browserView.adding") : t("browserView.add")}</button>
        )}
      </div>
      <div className={`page-progress${loading ? " on" : ""}`} role={loading ? "progressbar" : undefined} aria-label={loading ? t("browserView.loading") : undefined}><b /></div>
      {/* The native webview stays hidden until an opened page has loaded, uncovering this. */}
      <div ref={host} className="page-host">
        {still ? <img className="page-still" src={still} alt="" /> : loading && <span className="muted">{t("browserView.loadingEllipsis")}</span>}
      </div>
    </div>
  );
}
