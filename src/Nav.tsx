import { useState } from "react";
import type { FeedRow } from "./api";
import { MANUAL, UNCLASSIFIED } from "./groups";
import { genreSwatch, sameScope, type Scope } from "./library";
import { Menu } from "./Popover";
import { Icon, Kbd, type IconName } from "./Icon";

export type Screen = "library" | "feeds" | "jobs" | "import" | "settings";

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
const LIBRARY: [Scope, string, IconName, keyof NavCounts][] = [
  [{ kind: "recent" }, "最近追加", "recent", "recent"],
  [{ kind: "unread" }, "未読", "unread", "unread"],
  [{ kind: "favorites" }, "お気に入り", "star", "favorites"],
  [{ kind: "all" }, "すべての記事", "all", "all"],
];

const n = (v: number) => v.toLocaleString();

export function Logo() {
  return <span className="logo" aria-hidden="true"><i className="f" /><i /><i /><i className="f" /></span>;
}

export function Nav({ screen, scope, counts, feeds, jobFailures, chatOpen, searching, recentSearches, onScope, onScreen, onPalette,
  onOpenUrl, onChat, onRecent, onGenres, onCollapse }: {
  screen: Screen;
  /** null while a management screen is shown. */
  scope: Scope | null;
  counts: NavCounts;
  feeds: FeedRow[];
  jobFailures: number;
  chatOpen: boolean;
  searching: boolean;
  recentSearches: string[];
  onScope: (s: Scope) => void;
  onScreen: (s: Screen) => void;
  onPalette: () => void;
  onOpenUrl: () => void;
  onChat: () => void;
  onRecent: (q: string) => void;
  onGenres: () => void;
  onCollapse: () => void;
}) {
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
    <nav className="nav" aria-label="ナビゲーション" data-pane="nav">
      <div className="nav-top">
        <Logo />
        <span className="brand">Lattice</span>
        <Menu className="ib" label="追加（URL・一括インポート・フィード）" align="right" trigger={<Icon name="plus" />} items={[
          { label: <><Icon name="page" />URL を開く</>, onSelect: onOpenUrl },
          { label: <><Icon name="import" />一括インポート</>, onSelect: () => onScreen("import") },
          { label: <><Icon name="rss" />フィードを登録</>, onSelect: () => onScreen("feeds") },
        ]} />
        <button className="ib" onClick={onCollapse} aria-label="ナビゲーションを閉じる" title="ナビゲーションを閉じる"><Icon name="panel" /></button>
      </div>
      <button className={`nav-search${searching ? " on" : ""}`} onClick={onPalette}>
        <Icon name="search" />
        <span>{searching ? "検索中" : "検索・コマンド・URL"}</span>
        <span className="kbds">{searching ? <Kbd>/</Kbd> : <Kbd>Ctrl K</Kbd>}</span>
      </button>

      <div className="sec">ライブラリ</div>
      {LIBRARY.map(([s, label, icon, key]) => item(s, label, counts[key] as number, <Icon name={icon} />))}

      <div className="sec">ジャンル<button className="link" onClick={onGenres}>編集</button></div>
      {genres.map(([g, c]) => item({ kind: "genre", name: g }, g ?? UNCLASSIFIED, c, <span className="sw" style={{ background: genreSwatch(g) }} />))}
      {counts.genres.length > GENRES_SHOWN && (
        <button className="ni dim" onClick={() => setAllGenres((v) => !v)} aria-expanded={allGenres}>
          <Icon name={allGenres ? "up" : "right"} />{allGenres ? "折りたたむ" : `他 ${counts.genres.length - GENRES_SHOWN} ジャンル`}
        </button>
      )}

      {searching && recentSearches.length > 0 && <>
        <div className="sec">最近の検索</div>
        {recentSearches.map((q) => <button key={q} className="ni mono-ni" onClick={() => onRecent(q)}><span className="label">{q}</span></button>)}
      </>}

      <div className="sec">ソース<button className="link" onClick={() => onScreen("feeds")}>管理</button></div>
      <button className="ni" onClick={() => setFeedsOpen((v) => !v)} aria-expanded={feedsOpen}>
        <Icon name={feedsOpen ? "down" : "right"} /><span className="label">フィード</span><span className="n">{n(feeds.length)}</span>
      </button>
      {feedsOpen && (
        <div className="nav-sub">
          {shownFeeds.map((f) => item({ kind: "feed", id: f.id }, f.title ?? f.url, counts.feedUnread.get(f.id) ?? 0, null, " sub"))}
          {feeds.length > FEEDS_SHOWN && (
            <button className="ni sub dim" onClick={() => setAllFeeds((v) => !v)} aria-expanded={allFeeds}>
              {allFeeds ? "折りたたむ" : "すべてのフィード…"}
            </button>
          )}
        </div>
      )}
      {item({ kind: "feed", id: null }, MANUAL, counts.manual, <Icon name="manual" />)}
      {screen === "feeds" && tool("feeds", "フィードを管理", "gear")}

      <div className="sec">ツール</div>
      <button className={`ni${chatOpen ? " on" : ""}`} onClick={onChat} aria-pressed={chatOpen}><Icon name="chat" /><span className="label">対話</span></button>
      {tool("jobs", "処理状況", "jobs", jobFailures > 0 && <span className="bd err push">{n(jobFailures)} 失敗</span>)}
      {tool("import", "一括インポート", "import")}
      <div className="grow" />
      <div className="nav-bottom">{tool("settings", "設定", "gear")}</div>
    </nav>
  );
}

export function NavRail({ scope, chatOpen, onOpen, onPalette, onScope, onChat }: {
  scope: Scope | null; chatOpen: boolean; onOpen: () => void; onPalette: () => void; onScope: (s: Scope) => void; onChat: () => void;
}) {
  const btn = (s: Scope, label: string, icon: IconName) => (
    <button className={`ib${scope && sameScope(scope, s) ? " on" : ""}`} onClick={() => onScope(s)} aria-label={label} title={label}><Icon name={icon} /></button>
  );
  return (
    <nav className="nav-rail" aria-label="ナビゲーション（折りたたみ）" data-pane="nav">
      <button className="ib" onClick={onOpen} aria-label="ナビゲーションを開く" title="ナビゲーションを開く"><Icon name="panel" /></button>
      <button className="ib" onClick={onPalette} aria-label="検索・コマンド" title="検索・コマンド (Ctrl K)"><Icon name="search" /></button>
      {btn({ kind: "unread" }, "未読", "unread")}
      {btn({ kind: "favorites" }, "お気に入り", "star")}
      <button className={`ib${chatOpen ? " acc" : ""}`} onClick={onChat} aria-label="対話" title="対話" aria-pressed={chatOpen}><Icon name="chat" /></button>
    </nav>
  );
}
