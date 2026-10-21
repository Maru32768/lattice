import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { browser, type ArticleRow, type Bounds, type OverlayLabels } from "./api";
import type { LanguageMode } from "./mixed";
import type { PageTab } from "./layout";
import { LangSeg, ViewSeg } from "./Reader";
import { Menu, intersects } from "./Popover";
import { Icon } from "./Icon";
import { getEngine, homeOf, toNavigation } from "./engines";
import { useT, type T } from "./i18n";

/** The `seq` each tab's webview (by key) was last told to open: a tab shown again is not reloaded. */
const opened = new Map<string, number>();
/** The tab left this window with its webview: a return opens (attaches) it again rather than only resizing it. */
export const forgetOpened = (key: string) => void opened.delete(key);

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
export function BrowserView({ tab, saved, saving, lang, overlays, onNavigate, onLang, onSave, onReader, onFavorite, onDelete, onError }: {
  tab: PageTab;
  saved: ArticleRow | null;
  saving: boolean;
  lang: PageLang;
  /** Open app overlays (palette, popover, menu); the native webview would hide any it overlaps, so a still of it stands in. */
  overlays: DOMRect[];
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
  const hostRect = host.current?.getBoundingClientRect();
  const covered = !!hostRect && overlays.some((r) => intersects(r, hostRect));
  const coveredRef = useRef(covered);
  coveredRef.current = covered;
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const [still, setStill] = useState<string | null>(null);
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
  const sync = async () => {
    const b = bounds();
    if (!b || coveredRef.current || opening.current) return;
    const exists = await browser.setBounds(id, b).catch(() => true); // also re-shows it
    // Evicted while hidden, or restored from the saved layout: the tab reopens its URL.
    if (!exists && !opening.current) await open(b);
  };

  useLayoutEffect(() => {
    // Open each navigation once: showing the tab again (or a StrictMode re-run) must not
    // reload the page, which would also cancel the first load and lose its scroll target.
    if ((opened.get(id) ?? -1) >= tab.seq) return;
    void open(bounds()!, tab.focus);
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- each navigation opens once; onError only reports
  }, [tab.seq]);

  useEffect(() => {
    if (!covered) {
      void sync().then(() => setStill(null));
      return;
    }
    // The still is painted under the webview before it hides, so no blank frame shows in between.
    let live = true;
    void (async () => {
      const png = tabRef.current.loading ? null : await browser.capture(id).catch(() => null);
      if (png && live) {
        const img = new Image();
        img.src = png;
        await img.decode().catch(() => {});
        if (live) setStill(png);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }
      if (live) await browser.hide(id).catch(() => {});
    })();
    return () => { live = false; };
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- the tab key is fixed per instance (keyed by id); sync reads refs
  }, [covered]);

  useEffect(() => {
    const resize = () => void sync();
    const ro = new ResizeObserver(resize);
    ro.observe(host.current!);
    window.addEventListener("resize", resize);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", resize);
      browser.hide(id).catch(() => {});
    };
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- the tab key is fixed per instance (keyed by id); sync reads refs
  }, []);

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
