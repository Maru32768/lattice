import { useState } from "react";
import type { FeedRow, GroupRow } from "./api";
import { feedName } from "./groups";
import { genreSwatch, sameScope, type Scope } from "./library";
import { Menu } from "./Popover";
import { Icon, Kbd, type IconName } from "./Icon";
import { Favicon, hostOf } from "./Favicon";
import { NavGroups } from "./NavGroups";
import { useT, type PlainKey } from "./i18n";

export type Screen = "library" | "feeds" | "jobs" | "import" | "settings" | "review" | "vocab";

export interface NavCounts {
  recent: number;
  unread: number;
  favorites: number;
  all: number;
  manual: number;
  genres: [string | null, number][];
  feedUnread: Map<number | null, number>;
}

const GENRES_SHOWN = 6;
const FEEDS_SHOWN = 5;
const LIBRARY: [Scope, PlainKey, IconName, keyof NavCounts][] = [
  [{ kind: "recent" }, "library.recent", "recent", "recent"],
  [{ kind: "unread" }, "common.unread", "unread", "unread"],
  [{ kind: "favorites" }, "common.favorites", "star", "favorites"],
  [{ kind: "all" }, "common.allArticles", "all", "all"],
];

const n = (v: number) => v.toLocaleString();

export function Nav({ screen, scope, counts, feeds, groups, jobFailures, reviewDue, chatOpen, searching, recentSearches, onScope, onScreen, onPalette,
  onOpenUrl, onMarkdown, onChat, onRecent, onGenres, onCreateGroup, onRenameGroup, onDeleteGroup, onCollapse }: {
  screen: Screen;
  /** null while a management screen is shown. */
  scope: Scope | null;
  counts: NavCounts;
  feeds: FeedRow[];
  groups: GroupRow[];
  jobFailures: number;
  /** Cards in today's review queue. */
  reviewDue: number;
  chatOpen: boolean;
  searching: boolean;
  recentSearches: string[];
  onScope: (s: Scope) => void;
  onScreen: (s: Screen) => void;
  onPalette: () => void;
  onOpenUrl: () => void;
  onMarkdown: () => void;
  onChat: () => void;
  onRecent: (q: string) => void;
  onGenres: () => void;
  onCreateGroup: (name: string) => void;
  onRenameGroup: (id: number, name: string) => void;
  onDeleteGroup: (id: number) => void;
  onCollapse: () => void;
}) {
  const t = useT();
  const [allGenres, setAllGenres] = useState(false);
  const [feedsOpen, setFeedsOpen] = useState(true);
  const [allFeeds, setAllFeeds] = useState(false);
  const on = (s: Scope) => (scope && sameScope(scope, s) ? " on" : "");
  const item = (s: Scope, label: React.ReactNode, count: number, lead: React.ReactNode, extra = "") => (
    <button key={JSON.stringify(s)} className={`ni${on(s)}${extra}`} onClick={() => onScope(s)} aria-current={on(s) ? "page" : undefined}>
      {lead}<span className="label">{label}</span><span className="n">{n(count)}</span>
    </button>
  );
  const tool = (s: Screen, label: string, icon: IconName, badge?: React.ReactNode) => (
    <button className={`ni${screen === s ? " on" : ""}`} onClick={() => onScreen(s)} aria-current={screen === s ? "page" : undefined}>
      <Icon name={icon} /><span className="label">{label}</span>{badge}
    </button>
  );
  const genres = allGenres ? counts.genres : counts.genres.slice(0, GENRES_SHOWN);
  const shownFeeds = allFeeds ? feeds : feeds.slice(0, FEEDS_SHOWN);

  return (
    <nav className="nav" aria-label={t("nav.nav")} data-pane="nav">
      <div className="nav-top">
        <Menu className="ib" label={t("nav.add")} align="right" trigger={<Icon name="plus" />} items={[
          { label: <><Icon name="page" />{t("nav.openUrl")}</>, onSelect: onOpenUrl },
          { label: <><Icon name="import" />{t("common.bulkImport")}</>, onSelect: () => onScreen("import") },
          { label: <><Icon name="reader" />{t("common.importMarkdown")}</>, onSelect: onMarkdown },
          { label: <><Icon name="rss" />{t("common.addFeed")}</>, onSelect: () => onScreen("feeds") },
        ]} />
        <button className="ib" onClick={onCollapse} aria-label={t("nav.close")} title={t("nav.close")}><Icon name="panel" /></button>
      </div>
      <button className={`nav-search${searching ? " on" : ""}`} onClick={onPalette}>
        <Icon name="search" />
        <span>{searching ? t("nav.searching") : t("nav.searchPlaceholder")}</span>
        <span className="kbds">{searching ? <Kbd>/</Kbd> : <Kbd>Ctrl K</Kbd>}</span>
      </button>

      <div className="sec">{t("nav.library")}</div>
      {LIBRARY.map(([s, label, icon, key]) => item(s, t(label), counts[key] as number, <Icon name={icon} />))}

      <NavGroups groups={groups} scope={scope} onScope={onScope} onCreate={onCreateGroup} onRename={onRenameGroup} onDelete={onDeleteGroup} />

      <div className="sec">{t("common.genre")}<button className="link" onClick={onGenres}>{t("nav.edit")}</button></div>
      {genres.map(([g, c]) => item({ kind: "genre", name: g }, g ?? t("common.unclassified"), c, <span className="sw" style={{ background: genreSwatch(g) }} />))}
      {counts.genres.length > GENRES_SHOWN && (
        <button className="ni dim" onClick={() => setAllGenres((v) => !v)} aria-expanded={allGenres}>
          <Icon name={allGenres ? "up" : "right"} />{allGenres ? t("nav.collapse") : t("nav.moreGenres", { x: counts.genres.length - GENRES_SHOWN })}
        </button>
      )}

      {searching && recentSearches.length > 0 && <>
        <div className="sec">{t("nav.recentSearches")}</div>
        {recentSearches.map((q) => <button key={q} className="ni mono-ni" onClick={() => onRecent(q)}><span className="label">{q}</span></button>)}
      </>}

      <div className="sec">{t("common.source")}<button className="link" onClick={() => onScreen("feeds")}>{t("nav.manage")}</button></div>
      <button className="ni" onClick={() => setFeedsOpen((v) => !v)} aria-expanded={feedsOpen}>
        <Icon name={feedsOpen ? "down" : "right"} /><span className="label">{t("nav.feeds")}</span><span className="n">{n(feeds.length)}</span>
      </button>
      {feedsOpen && (
        <div className="nav-sub">
          {shownFeeds.map((f) => item({ kind: "feed", id: f.id }, feedName(f), counts.feedUnread.get(f.id) ?? 0, <Favicon domain={hostOf(f.site_url ?? f.url)} feed={f.id} />, " sub"))}
          {feeds.length > FEEDS_SHOWN && (
            <button className="ni sub dim" onClick={() => setAllFeeds((v) => !v)} aria-expanded={allFeeds}>
              {allFeeds ? t("nav.collapse") : t("nav.allFeeds")}
            </button>
          )}
        </div>
      )}
      {item({ kind: "feed", id: null }, t("common.manual"), counts.manual, <Icon name="manual" />)}
      {screen === "feeds" && tool("feeds", t("nav.manageFeeds"), "gear")}

      <div className="sec">{t("nav.tools")}</div>
      <button className={`ni${chatOpen ? " on" : ""}`} onClick={onChat} aria-pressed={chatOpen}><Icon name="chat" /><span className="label">{t("common.chat")}</span></button>
      {tool("review", t("common.todaysReview"), "review", reviewDue > 0 && <span className="bd run push" aria-label={t("nav.due", { reviewDue })}>{n(reviewDue)}</span>)}
      {tool("vocab", t("vocabView.title"), "vocab")}
      {tool("jobs", t("common.jobs"), "jobs", jobFailures > 0 && <span className="bd err push">{t("nav.failed", { n: n(jobFailures) })}</span>)}
      {tool("import", t("common.bulkImport"), "import")}
      <div className="grow" />
      <div className="nav-bottom">{tool("settings", t("common.settings"), "gear")}</div>
    </nav>
  );
}

export function NavRail({ scope, chatOpen, onOpen, onPalette, onScope, onChat }: {
  scope: Scope | null; chatOpen: boolean; onOpen: () => void; onPalette: () => void; onScope: (s: Scope) => void; onChat: () => void;
}) {
  const t = useT();
  const btn = (s: Scope, label: string, icon: IconName) => (
    <button className={`ib${scope && sameScope(scope, s) ? " on" : ""}`} onClick={() => onScope(s)} aria-label={label} title={label}><Icon name={icon} /></button>
  );
  return (
    <nav className="nav-rail" aria-label={t("nav.rail")} data-pane="nav">
      <button className="ib" onClick={onOpen} aria-label={t("nav.open")} title={t("nav.open")}><Icon name="panel" /></button>
      <button className="ib" onClick={onPalette} aria-label={t("nav.railSearch")} title={t("nav.railSearchHint")}><Icon name="search" /></button>
      {btn({ kind: "unread" }, t("common.unread"), "unread")}
      {btn({ kind: "favorites" }, t("common.favorites"), "star")}
      <button className={`ib${chatOpen ? " acc" : ""}`} onClick={onChat} aria-label={t("common.chat")} title={t("common.chat")} aria-pressed={chatOpen}><Icon name="chat" /></button>
    </nav>
  );
}
