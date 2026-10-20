import { useEffect, useLayoutEffect, useRef } from "react";
import { browser, type ArticleRow, type Bounds } from "./api";
import type { LanguageMode } from "./mixed";
import { LangSeg, ViewSeg } from "./Reader";
import { Menu, intersects } from "./Popover";
import { Icon } from "./Icon";

let lastOpened: BrowseTarget | null = null;

export interface BrowseTarget {
  url: string;
  /** Text of a block to scroll to after load (search-result jumps). */
  focus?: string;
  /** Bumped to force re-navigation to the same URL. */
  seq: number;
}

export interface PageState {
  url: string;
  title: string;
  loading: boolean;
  /** From the page's Navigation API; unknown (undefined) leaves the button enabled. */
  canGoBack?: boolean;
  canGoForward?: boolean;
}

export interface PageLang {
  mode: LanguageMode;
  percent: number;
}

/** The overlay's switch and ratio for a language choice: 原文 = off, 訳文 = 100 %. */
export const overlayOf = (l: PageLang) => ({ enabled: l.mode !== "original", percent: l.mode === "translated" ? 100 : l.percent });

/** https:// + host emphasized + the rest. */
function UrlPill({ url }: { url: string }) {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/i.exec(url);
  return (
    <div className="url-pill" title={url}>
      <span className="vh">URL: </span>
      {m ? <>{m[1]}<b>{m[2]}</b>{m[3]}</> : url}
    </div>
  );
}

/**
 * Toolbar plus a placeholder box; the native browser webview is kept positioned over the
 * box. Page content never enters this (app) webview.
 */
export function BrowserView({ target, page, saved, saving, lang, overlays, onLang, onSave, onReader, onFavorite, onDelete, onError }: {
  target: BrowseTarget;
  page: PageState | null;
  saved: ArticleRow | null;
  saving: boolean;
  lang: PageLang;
  /** Open app overlays (palette, popover, menu); the native webview would hide any it overlaps, so it hides instead. */
  overlays: DOMRect[];
  onLang: (l: PageLang) => void;
  onSave: () => void;
  onReader: () => void;
  onFavorite: () => void;
  /** Asks for confirmation, then removes the saved article from the Index. */
  onDelete: () => void;
  onError: (e: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const bounds = (): Bounds | null => {
    const r = host.current?.getBoundingClientRect();
    return r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null;
  };
  const hostRect = host.current?.getBoundingClientRect();
  const covered = !!hostRect && overlays.some((r) => intersects(r, hostRect));
  const coveredRef = useRef(covered);
  coveredRef.current = covered;
  // While an open is in flight, setBounds would re-show the previous page before the backend
  // knows a new one is loading; the open places the webview itself.
  const opening = useRef(false);
  const sync = () => {
    const b = bounds();
    if (b && !coveredRef.current && !opening.current) browser.setBounds(b).catch(() => {}); // also re-shows it
  };

  useLayoutEffect(() => {
    // Open each target once: returning to the browser view (or a StrictMode re-run) must not
    // reload the page, which would also cancel the first load and lose its scroll target.
    if (target === lastOpened) return;
    lastOpened = target;
    opening.current = true;
    browser.open(target.url, bounds()!, target.focus).catch((e) => onError(String(e))).finally(() => {
      opening.current = false;
      sync();
    });
  }, [target]);

  useEffect(() => {
    if (covered) browser.hide().catch(() => {});
    else sync();
  }, [covered]);

  useEffect(() => {
    const ro = new ResizeObserver(sync);
    ro.observe(host.current!);
    window.addEventListener("resize", sync);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", sync);
      browser.hide().catch(() => {});
    };
  }, []);

  const url = page?.url ?? target.url;
  const loading = !!page?.loading;
  const resave = saved && (saved.thin || saved.fetch_status === "failed" || saved.extraction_status === "failed");
  return (
    <div className="doc">
      <div className="docbar">
        <ViewSeg page onReader={onReader} onPage={() => {}} readerDisabled={!saved} />
        <div className="vsep" />
        <button className="ib" onClick={() => browser.go("back")} disabled={page?.canGoBack === false} aria-label="戻る" title="戻る"><Icon name="left" /></button>
        <button className="ib" onClick={() => browser.go("forward")} disabled={page?.canGoForward === false} aria-label="進む" title="進む"><Icon name="right" /></button>
        <button className="ib" onClick={() => browser.go("reload")} aria-label="再読み込み" title="再読み込み"><Icon name="reload" /></button>
        <UrlPill url={url} />
        <LangSeg mode={lang.mode} percent={lang.percent} onChange={(mode, percent) => onLang({ mode, percent })} label="このページを翻訳" />
        {saved ? (
          <>
            <span className="indexed"><Icon name="check" />Index 済み</span>
            <button className={`tb${saved.favorite ? " on" : ""}`} onClick={onFavorite} aria-pressed={saved.favorite} aria-label="お気に入り (s)" title="お気に入り (s)"><Icon name="star" /></button>
            <Menu className="tb" label="その他（保存し直す・Index から削除）" align="right" trigger={<Icon name="more" />} items={[
              ...(resave ? [{ label: saving ? "保存中…" : "描画後のページで保存し直す", onSelect: onSave, disabled: saving || loading }, "-" as const] : []),
              { label: <span className="error-text">Index から削除…</span>, onSelect: onDelete },
            ]} />
          </>
        ) : (
          <button className="tb pri" onClick={onSave} disabled={saving || !page || loading}
            title="保存すると Reader・タグ・ジャンル・お気に入りが有効になります。取り込みは描画後の DOM を使います。"><Icon name="import" />{saving ? "追加中…" : "Index に追加"}</button>
        )}
      </div>
      <div className={`page-progress${loading ? " on" : ""}`} role={loading ? "progressbar" : undefined} aria-label={loading ? "読み込み中" : undefined}><b /></div>
      {/* The native webview stays hidden until an opened page has loaded, uncovering this. */}
      <div ref={host} className="page-host">
        {loading && <span className="muted">読み込み中…</span>}
      </div>
    </div>
  );
}
