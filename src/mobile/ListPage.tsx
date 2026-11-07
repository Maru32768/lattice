import { useState } from "react";
import type { MobileIndex } from "../bindings";
import { useT, type PlainKey } from "../i18n";
import { relTime } from "../lib/time";
import { type ListFilter, type ListView, visibleArticles } from "./list";

const FILTERS: { id: ListFilter; label: PlainKey }[] = [
  { id: "unread", label: "mobile.unread" },
  { id: "all", label: "mobile.all" },
  { id: "favorites", label: "mobile.favorites" },
];
const PAGE = 100;

export function ListPage({
  index,
  view,
  onView,
  onOpen,
  onRefresh,
}: {
  index: MobileIndex;
  view: ListView;
  onView: (v: ListView) => void;
  onOpen: () => void;
  onRefresh: () => Promise<void>;
}) {
  const t = useT();
  const [refreshing, setRefreshing] = useState(false);
  const rows = visibleArticles(index.articles, view);
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
              onClick={() => onView({ ...view, filter: f.id, shown: PAGE })}
            >
              {t(f.label)}
            </button>
          ))}
        </div>
        <button className="btn" onClick={() => void refresh()} disabled={refreshing}>
          {t("mobile.refresh")}
        </button>
      </header>
      <main className="m-list">
        <input
          className="input"
          type="search"
          value={view.query}
          onChange={(e) => onView({ ...view, query: e.target.value, shown: PAGE })}
          placeholder={t("mobile.searchTitles")}
          aria-label={t("mobile.searchTitles")}
        />
        {rows.length === 0 && <p className="m-none">{t("mobile.noArticles")}</p>}
        <ul>
          {rows.slice(0, view.shown).map((a) => (
            <li key={a.id}>
              <a href={`#/a/${a.id}`} onClick={onOpen} className={a.read_status === "unread" ? "unread" : ""}>
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
      </main>
    </>
  );
}
