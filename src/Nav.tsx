import { useState } from "react";
import type { FeedRow, FolderRow, GroupRow } from "./api";
import { genreSwatch, sameScope, type Scope } from "./library";
import { Icon, type IconName } from "./Icon";
import { NavGroups } from "./NavGroups";
import { NavFolders } from "./NavFolders";
import type { MenuItem } from "./Popover";
import { useT, type PlainKey } from "./i18n";

export type Screen = "library" | "feeds" | "jobs" | "import" | "settings" | "review" | "vocab";

export interface NavCounts {
  recent: number;
  important: number;
  unread: number;
  favorites: number;
  all: number;
  manual: number;
  genres: [string | null, number][];
  feedUnread: Map<number | null, number>;
}

const GENRES_SHOWN = 6;
const LIBRARY: [Scope, PlainKey, IconName, keyof NavCounts][] = [
  [{ kind: "recent" }, "library.recent", "recent", "recent"],
  [{ kind: "unread" }, "common.unread", "unread", "unread"],
  [{ kind: "favorites" }, "common.favorites", "star", "favorites"],
  [{ kind: "all" }, "common.allArticles", "all", "all"],
];

const n = (v: number) => v.toLocaleString();

export function Nav({ screen, scope, counts, feeds, folders, groups, jobFailures, reviewDue, chatOpen, searching, recentSearches, onScope, onScreen,
  onChat, onRecent, onGenres, onCreateGroup, onRenameGroup, onDeleteGroup, onRenameFolder, onDeleteFolder, onMenu, onCollapse, importantMin }: {
  screen: Screen;
  /** null while a management screen is shown. */
  scope: Scope | null;
  counts: NavCounts;
  feeds: FeedRow[];
  folders: FolderRow[];
  groups: GroupRow[];
  jobFailures: number;
  /** Cards in today's review queue. */
  reviewDue: number;
  chatOpen: boolean;
  searching: boolean;
  recentSearches: string[];
  onScope: (s: Scope) => void;
  onScreen: (s: Screen) => void;
  onChat: () => void;
  onRecent: (q: string) => void;
  onGenres: () => void;
  onCreateGroup: (name: string) => void;
  onRenameGroup: (id: number, name: string) => void;
  onDeleteGroup: (id: number) => void;
  onRenameFolder: (id: number, name: string) => void;
  onDeleteFolder: (id: number) => void;
  /** Sets the app's context menu items (a folder row's menu). */
  onMenu: (items: MenuItem[]) => void;
  onCollapse: () => void;
  /** The lowest score in 重要; null hides it (no 「自分について」 profile and nothing scored). */
  importantMin: number | null;
}) {
  const t = useT();
  const [allGenres, setAllGenres] = useState(false);
  const [feedsOpen, setFeedsOpen] = useState(true);
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

  return (
    <nav className="nav" aria-label={t("nav.nav")} data-pane="nav">
      <div className="sec nav-head">
        {t("nav.library")}
        <button className="ib" onClick={onCollapse} aria-label={t("nav.close")} title={t("nav.close")}><Icon name="panel" /></button>
      </div>
      {LIBRARY.map(([s, label, icon, key]) => item(s, t(label), counts[key] as number, <Icon name={icon} />))}
      {importantMin != null && item({ kind: "important", min: importantMin }, t("library.important"), counts.important, <Icon name="flag" />)}

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
          <NavFolders feeds={feeds} folders={folders} unread={counts.feedUnread} scope={scope} onScope={onScope}
            onRename={onRenameFolder} onDelete={onDeleteFolder} onMenu={onMenu} />
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

export function NavRail({ scope, chatOpen, onOpen, onScope, onChat }: {
  scope: Scope | null; chatOpen: boolean; onOpen: () => void; onScope: (s: Scope) => void; onChat: () => void;
}) {
  const t = useT();
  const btn = (s: Scope, label: string, icon: IconName) => (
    <button className={`ib${scope && sameScope(scope, s) ? " on" : ""}`} onClick={() => onScope(s)} aria-label={label} title={label}><Icon name={icon} /></button>
  );
  return (
    <nav className="nav-rail" aria-label={t("nav.rail")} data-pane="nav">
      <button className="ib" onClick={onOpen} aria-label={t("nav.open")} title={t("nav.open")}><Icon name="panel" /></button>
      {btn({ kind: "unread" }, t("common.unread"), "unread")}
      {btn({ kind: "favorites" }, t("common.favorites"), "star")}
      <button className={`ib${chatOpen ? " acc" : ""}`} onClick={onChat} aria-label={t("common.chat")} title={t("common.chat")} aria-pressed={chatOpen}><Icon name="chat" /></button>
    </nav>
  );
}
