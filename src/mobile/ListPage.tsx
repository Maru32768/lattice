import { useState } from "react";
import type { ArticleRow } from "../bindings";
import { useT, type PlainKey } from "../i18n";
import { relTime } from "../lib/time";
import { discardUnsent, submit } from "./client";
import { savableUrl } from "./urls";
import { PAGE, type ListFilter, type ListView, isOldList, visibleArticles } from "./list";

const FILTERS: { id: ListFilter; label: PlainKey }[] = [
  { id: "unread", label: "mobile.unread" },
  { id: "all", label: "mobile.all" },
  { id: "favorites", label: "mobile.favorites" },
];

export function ListPage({
  articles,
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
  const rows = visibleArticles(articles, view);
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
      <header className="m-bar">
        <div className="seg" role="group" aria-label={t("mobile.filter")}>
          {FILTERS.map((f) => (
            <button
              key={f.id}
              className={view.filter === f.id ? "on" : ""}
              aria-pressed={view.filter === f.id}
              onClick={() => change({ ...view, filter: f.id, shown: PAGE })}
            >
              {t(f.label)}
            </button>
          ))}
        </div>
        <button className="btn" onClick={() => void refresh()} disabled={refreshing}>
          {t("mobile.refresh")}
        </button>
        {refreshFailed && (
          <p role="alert" className="m-bar-note">
            {t("mobile.loadFailed")}
          </p>
        )}
        {isOldList(generatedAt) && <p className="m-bar-age">{t("mobile.asOf", { time: relTime(new Date(generatedAt * 1000).toISOString(), t) })}</p>}
      </header>
      <main className="m-list">
        <input
          className="input"
          type="search"
          value={view.query}
          onChange={(e) => change({ ...view, query: e.target.value, shown: PAGE })}
          placeholder={t("mobile.searchTitles")}
          aria-label={t("mobile.searchTitles")}
        />
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
