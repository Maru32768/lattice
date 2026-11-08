import { useState } from "react";
import type { ArticleRow, GroupRow } from "../bindings";
import { useT } from "../i18n";
import { NO_KEPT, activeDims, facetLabel, scopeLabel } from "../library/library";
import { relTime } from "../lib/time";
import { Dif, Icon } from "../ui/Icon";
import { Importance, badge, mmdd } from "../library/rowMeta";
import { discardUnsent, submit } from "./client";
import { FilterSheet } from "./FilterSheet";
import { savableUrl } from "./urls";
import { PAGE, type ListView, isOldList, visibleArticles } from "./list";

const popovers = typeof HTMLElement !== "undefined" && "showPopover" in HTMLElement.prototype;

export function ListPage({
  articles,
  groups,
  icons,
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
  /** The sites' icons by domain, as `data:` URLs. */
  icons: Record<string, string>;
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
  /** Only where popovers are not supported (iOS before 17): the menu then opens by this, and stays hidden otherwise. */
  const [menuOpen, setMenuOpen] = useState(false);
  const dims = activeDims(view.facets);
  const badgeOf = (a: ArticleRow) => {
    const b = badge(a, null, t);
    return b && <span className={`bd ${b[0]}`}>{b[1]}</span>;
  };
  const summary = [scopeLabel(view.scope, articles, groups, t), ...dims.map((d) => facetLabel(view.facets, d, articles, groups, t))].join(" · ");
  const [url, setUrl] = useState("");
  const [saved, setSaved] = useState(false);
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
          <button
            className="m-icon"
            popoverTarget="m-menu"
            onClick={popovers ? undefined : () => setMenuOpen(!menuOpen)}
            aria-label={t("mobile.menu")}
            aria-haspopup="menu"
          >
            <Icon name="more" />
          </button>
        </div>
        <div className="m-view">
          <p className="m-view-what">
            {summary} · {t("mobile.count", { n: rows.length })}
          </p>
          {/* On the same line: the bar takes no more of the screen than it must. */}
          {isOldList(generatedAt) && <span className="m-bar-age">{t("mobile.asOf", { time: relTime(new Date(generatedAt * 1000).toISOString(), t) })}</span>}
          <button className="btn" onClick={() => void refresh()} disabled={refreshing}>
            {t("mobile.refresh")}
          </button>
        </div>
        {refreshFailed && (
          <p role="alert" className="m-bar-note">
            {t("mobile.savedCopy")}
          </p>
        )}
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
      {/* A popover: a tap outside or Esc closes it, as a menu should. */}
      <div id="m-menu" className={menuOpen ? "m-menu open" : "m-menu"} popover="auto" role="menu" aria-label={t("mobile.menu")}>
        <button
          role="menuitem"
          className="danger"
          popoverTarget="m-menu"
          popoverTargetAction="hide"
          onClick={() => {
            setMenuOpen(false);
            if (window.confirm(t("mobile.disconnectConfirm"))) {
              onDisconnect();
            }
          }}
        >
          {t("mobile.disconnect")}
        </button>
      </div>
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
                {/* As the PC's row has it (ListPane): site, date, difficulty, importance, favorite, a badge, then the tags. */}
                <span className="m-meta">
                  <span className="m-site">
                    {icons[a.domain] && <img className="m-fav" src={icons[a.domain]} alt="" />}
                    {a.feed_title ?? a.site_name ?? (a.domain || t("common.local"))}
                  </span>
                  <span>{mmdd(a.saved_at)}</span>
                  {a.difficulty != null && <Dif d={a.difficulty} />}
                  <Importance a={a} />
                  {a.favorite && <span aria-label={t("mobile.favorites")}>★</span>}
                  {badgeOf(a)}
                </span>
                {a.tags.length > 0 && <span className="m-tags">{a.tags.join(" · ")}</span>}
              </a>
            </li>
          ))}
        </ul>
        {rows.length > view.shown && (
          <button className="btn m-more" onClick={() => onView({ ...view, shown: view.shown + PAGE })}>
            {t("mobile.more", { n: rows.length - view.shown })}
          </button>
        )}
      </main>
    </>
  );
}
