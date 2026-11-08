import { useState } from "react";
import type { ArticleRow, GroupRow } from "../bindings";
import { useT } from "../i18n";
import { NO_KEPT, activeDims, facetLabel, scopeLabel } from "../library/library";
import { relTime } from "../lib/time";
import { Icon } from "../ui/Icon";
import { discardUnsent, inBrowser, showTokenInAddress, submit } from "./client";
import { FilterSheet } from "./FilterSheet";
import { savableUrl } from "./urls";
import { PAGE, type ListView, isOldList, visibleArticles } from "./list";

export function ListPage({
  articles,
  groups,
  unsent,
  writable,
  view,
  generatedAt,
  refreshFailed,
  onDisconnect,
  onView,
  onOpen,
  onRefresh,
}: {
  /** The list as this phone's operations will leave it. */
  articles: ArticleRow[];
  groups: GroupRow[];
  unsent: number;
  writable: boolean;
  view: ListView;
  /** When the list was made, in Unix seconds. */
  generatedAt: number;
  refreshFailed: boolean;
  onDisconnect: () => void;
  onView: (v: ListView) => void;
  onOpen: (a: ArticleRow) => void;
  onRefresh: () => Promise<void>;
}) {
  const t = useT();
  const [refreshing, setRefreshing] = useState(false);
  const { base, rows } = visibleArticles(articles, view);
  const [filtering, setFiltering] = useState(false);
  const dims = activeDims(view.facets);
  const summary = [scopeLabel(view.scope, articles, groups, t), ...dims.map((d) => facetLabel(view.facets, d, articles, groups, t))].join(" · ");
  const [url, setUrl] = useState("");
  const [saved, setSaved] = useState(false);
  const [addingHome, setAddingHome] = useState(false);
  const typed = url.trim();
  const save = () => {
    if (savableUrl(typed)) {
      submit({ kind: "save_url", url: typed });
      setUrl("");
      setSaved(true);
    }
  };
  /** A different list starts at its top. */
  const change = (v: ListView) => {
    onView(v);
    window.scrollTo(0, 0);
  };
  const refresh = async () => {
    setRefreshing(true);
    await onRefresh();
    setRefreshing(false);
  };
  return (
    <>
      <header className="m-bar m-find">
        <div className="m-search" role="search">
          <Icon name="search" />
          <input
            type="search"
            value={view.query}
            onChange={(e) => change({ ...view, query: e.target.value, shown: PAGE })}
            placeholder={t("mobile.searchTitles")}
            aria-label={t("mobile.searchTitles")}
          />
          {view.query && (
            <button
              className="m-icon"
              // Keeps the keyboard up: the field keeps focus.
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => change({ ...view, query: "", shown: PAGE })}
              aria-label={t("mobile.clearSearch")}
            >
              <Icon name="x" />
            </button>
          )}
          <button className="m-icon" onClick={() => setFiltering(true)} aria-label={t("mobile.filter")} aria-haspopup="dialog">
            <Icon name="filter" />
            {dims.length > 0 && (
              <span className="m-badge" aria-hidden="true">
                {dims.length}
              </span>
            )}
          </button>
        </div>
        <div className="m-view">
          <button className="m-view-what" onClick={() => setFiltering(true)}>
            {summary} · {t("mobile.count", { n: rows.length })}
          </button>
          <button className="btn" onClick={() => void refresh()} disabled={refreshing}>
            {t("mobile.refresh")}
          </button>
        </div>
        {refreshFailed && (
          <p role="alert" className="m-bar-note">
            {t("mobile.savedCopy")}
          </p>
        )}
        {isOldList(generatedAt) && <p className="m-bar-age">{t("mobile.asOf", { time: relTime(new Date(generatedAt * 1000).toISOString(), t) })}</p>}
      </header>
      <FilterSheet
        open={filtering}
        onClose={() => setFiltering(false)}
        view={view}
        onFacets={(facets) => change({ ...view, facets, shown: PAGE, kept: NO_KEPT })}
        onScope={(scope) => change({ ...view, scope, shown: PAGE, kept: NO_KEPT })}
        base={base}
        all={articles}
        groups={groups}
        count={rows.length}
      />
      <main className="m-list">
        {writable && (
          <div className="m-save">
            <input
              className="input"
              type="url"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setSaved(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  save();
                }
              }}
              placeholder={t("mobile.urlPlaceholder")}
              aria-label={t("mobile.saveUrl")}
            />
            <button className="btn" onClick={save} disabled={!savableUrl(typed)}>
              {t("mobile.saveUrl")}
            </button>
          </div>
        )}
        {saved && (
          <p role="status" className="m-note">
            {t("mobile.urlTaken")}
          </p>
        )}
        {unsent > 0 && (
          <p className="m-note">
            {t("mobile.pending", { n: unsent })}{" "}
            <button
              className="btn"
              onClick={() => {
                if (window.confirm(t("mobile.discardConfirm"))) {
                  discardUnsent();
                }
              }}
            >
              {t("mobile.discard")}
            </button>
          </p>
        )}
        {rows.length === 0 && <p className="m-none">{t("mobile.noArticles")}</p>}
        <ul>
          {rows.slice(0, view.shown).map((a) => (
            <li key={a.id}>
              <a href={`#/a/${a.id}`} onClick={() => onOpen(a)} className={a.read_status === "unread" ? "unread" : ""}>
                <span className="m-title">{a.title ?? a.original_url}</span>
                <span className="m-meta">
                  {a.favorite && <span aria-label={t("mobile.favorites")}>★ </span>}
                  {[a.feed_title || a.site_name || a.domain, relTime(a.saved_at, t)].filter(Boolean).join(" · ")}
                </span>
              </a>
            </li>
          ))}
        </ul>
        {rows.length > view.shown && (
          <button className="btn m-more" onClick={() => onView({ ...view, shown: view.shown + PAGE })}>
            {t("mobile.more", { n: rows.length - view.shown })}
          </button>
        )}
        {inBrowser() && (
          <button
            className="btn m-more"
            onClick={() => {
              const link = showTokenInAddress();
              // Without a secure context (the local network's plain HTTP) there is no clipboard: the address bar has it.
              if (link) {
                void navigator.clipboard?.writeText(link).catch(() => {});
              }
              setAddingHome(true);
            }}
          >
            {t("mobile.addHome")}
          </button>
        )}
        {addingHome && (
          <p role="status" className="m-note">
            {t("mobile.addHomeHow")}
          </p>
        )}
        <button
          className="btn m-more"
          onClick={() => {
            if (window.confirm(t("mobile.disconnectConfirm"))) {
              onDisconnect();
            }
          }}
        >
          {t("mobile.disconnect")}
        </button>
      </main>
    </>
  );
}
