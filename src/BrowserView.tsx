import { useEffect, useLayoutEffect, useRef } from "react";
import { browser, type ArticleRow, type Bounds } from "./api";

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
}

export interface OverlaySettings {
  enabled: boolean;
  percent: number;
}

/**
 * Toolbar plus a placeholder box; the native browser webview is kept positioned over the
 * box. Page content never enters this (app) webview.
 */
export function BrowserView({ target, page, saved, saving, overlay, covered, onOverlay, onSave, onReader, onFavorite, onError }: {
  target: BrowseTarget;
  /** An app overlay (palette, popover, menu) is open; the native webview would hide it, so hide the webview. */
  covered: boolean;
  page: PageState | null;
  saved: ArticleRow | null;
  saving: boolean;
  overlay: OverlaySettings;
  onOverlay: (o: OverlaySettings) => void;
  onSave: () => void;
  onReader: () => void;
  onFavorite: () => void;
  onError: (e: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const bounds = (): Bounds => {
    const r = host.current!.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  };

  useLayoutEffect(() => {
    // Open each target once: returning to the browser view (or a StrictMode re-run) must not
    // reload the page, which would also cancel the first load and lose its scroll target.
    if (target === lastOpened) return;
    lastOpened = target;
    browser.open(target.url, bounds(), target.focus).catch((e) => onError(String(e)));
  }, [target]);

  const coveredRef = useRef(covered);
  coveredRef.current = covered;
  useEffect(() => {
    if (covered) browser.hide().catch(() => {});
    else browser.setBounds(bounds()).catch(() => {}); // re-shows it
  }, [covered]);

  useEffect(() => {
    const sync = () => { if (!coveredRef.current) browser.setBounds(bounds()).catch(() => {}); };
    const ro = new ResizeObserver(sync);
    ro.observe(host.current!);
    window.addEventListener("resize", sync);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", sync);
      browser.hide().catch(() => {});
    };
  }, []);

  return (
    <div className="browser">
      <div className="browser-bar">
        <div className="nav">
          <button onClick={() => browser.go("back")} aria-label="戻る" title="戻る">←</button>
          <button onClick={() => browser.go("forward")} aria-label="進む" title="進む">→</button>
          <button onClick={() => browser.go("reload")} aria-label="再読み込み" title="再読み込み">⟳</button>
        </div>
        <div className="location" title={page?.url ?? target.url}>
          <span className="page-title">{page?.loading ? "読み込み中…" : page?.title || page?.url || target.url}</span>
          <span className="page-url">{page?.url ?? target.url}</span>
        </div>
        <div className="actions">
          <button className={overlay.enabled ? "on" : ""} aria-pressed={overlay.enabled}
            onClick={() => onOverlay({ ...overlay, enabled: !overlay.enabled })}>
            {overlay.enabled ? "翻訳中" : "このページを翻訳"}
          </button>
          {overlay.enabled && (
            <label className="ratio">
              日本語 {overlay.percent}%
              <input type="range" min={0} max={100} step={10} value={overlay.percent}
                onChange={(e) => onOverlay({ ...overlay, percent: Number(e.target.value) })} />
            </label>
          )}
          {saved
            ? <>
                <button onClick={onFavorite} aria-pressed={saved.favorite} title="お気に入り">{saved.favorite ? "★" : "☆"}</button>
                <span className="saved">Index 済み</span>
                {(saved.thin || saved.fetch_status === "failed" || saved.extraction_status === "failed") && (
                  <button onClick={onSave} disabled={saving || !page || page.loading}
                    title="本文を取得できなかった記事を、表示中のページから保存し直します">
                    {saving ? "保存中…" : "描画後のページで保存"}
                  </button>
                )}
                <button onClick={onReader}>リーダー表示</button>
              </>
            : <button onClick={onSave} disabled={saving || !page || page.loading}>{saving ? "追加中…" : "Index に追加"}</button>}
        </div>
      </div>
      {/* The native webview stays hidden until an opened page has loaded, uncovering this. */}
      <div ref={host} className="browser-host">
        {page?.loading && <div className="browser-loading" role="status"><span className="spinner" aria-hidden="true" />読み込み中…</div>}
      </div>
    </div>
  );
}
