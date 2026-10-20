import { useEffect, useMemo, useRef, useState } from "react";
import { api, siteOf, type ArticleRow, type FeedRow, type GroupRow } from "./api";
import { feedName } from "./groups";
import { activeDims, countBy, facetLabel, genreSwatch, groupName, scopeLabel, type Facets, type Scope } from "./library";
import { filterKey } from "./scopes";
import { useCover } from "./Popover";
import { Icon, Kbd, type IconName } from "./Icon";
import type { Screen } from "./Nav";
import type { LanguageMode } from "./mixed";
import { useT, type PlainKey } from "./i18n";

export interface PaletteActions {
  scope: (s: Scope) => void;
  facets: (f: Facets) => void;
  /** `newTab`: Ctrl-clicked. */
  open: (a: ArticleRow, newTab?: boolean) => void;
  page: (url: string, newTab?: boolean) => void;
  /** `group`: also put the saved article in that group. */
  index: (url: string, group?: number) => void;
  discover: (url: string) => void;
  search: (q: string) => void;
  screen: (s: Screen) => void;
  /** The import screen's Markdown tab. */
  importMarkdown: () => void;
  /** The import screen's PDF tab. */
  importPdf: () => void;
  /** Opens the chat dock; `scopeKey` is a chat scope option value (filterKey). */
  chat: (scopeKey?: string) => void;
  lang: (mode: LanguageMode, percent?: number) => void;
  /** Null when no article is open. */
  translate: (() => void) | null;
  /** Opens the open Reader article's group picker; null without one. */
  addToGroup: (() => void) | null;
}

/** Result groups; URL actions have no heading. */
const GROUPS = { url: null, commands: "palette.commands", articles: "common.articles", tags: "palette.tags", sources: "palette.sources", genres: "palette.genres" } as const satisfies Record<string, PlainKey | null>;

interface Item {
  group: keyof typeof GROUPS;
  icon?: IconName;
  label: React.ReactNode;
  sub?: React.ReactNode;
  right?: React.ReactNode;
  /** `newTab`: Ctrl-clicked (only articles and URLs use it). */
  run: (newTab?: boolean) => void;
  /** Tab: stack this filter as a facet and keep the palette open. */
  stack?: () => void;
}

interface Command {
  label: string;
  keys: string;
  icon: IconName;
  run: (n: number | null) => void;
  /** Label when the query carries a number (">translate 70"). */
  withNumber?: (n: number) => string;
}

const URLISH = /^(https?:\/\/\S+|[\w-]+(\.[\w-]+)+(\/\S*)?)$/i;
const LIMIT = 5;

function Hl({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

const Tg = ({ children }: { children: React.ReactNode }) => <span className="tg">{children}</span>;

/** Ctrl K: one input for commands, articles, filters, URLs and search (Palette board). */
export function Palette({ initial, all, shown, feeds, groups, scope, facets, actions, onClose }: {
  initial: string;
  all: ArticleRow[];
  /** The list as currently filtered, for "現在の集合で N 件". */
  shown: ArticleRow[];
  feeds: FeedRow[];
  groups: GroupRow[];
  scope: Scope;
  facets: Facets;
  actions: PaletteActions;
  onClose: () => void;
}) {
  const t = useT();
  const [q, setQ] = useState(initial);
  const [act, setAct] = useState(0);
  const [known, setKnown] = useState<ArticleRow | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  useCover(scrim, true);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    input.current?.focus();
    return () => prev?.focus?.();
  }, []);

  const raw = q.trim();
  const url = URLISH.test(raw) && !raw.startsWith("#") ? (/^https?:\/\//i.test(raw) ? raw : `https://${raw}`) : null;
  useEffect(() => {
    setKnown(null);
    if (!url) return;
    let live = true;
    api.articleForUrl(url).then((a) => { if (live) setKnown(a); }).catch(() => {});
    return () => { live = false; };
  }, [url]);

  const tagCounts = useMemo(() => [...countBy(all, "tags")].sort((a, b) => b[1] - a[1]), [all]);
  const genreCounts = useMemo(() => [...countBy(all, "genres")].sort((a, b) => b[1] - a[1]), [all]);
  const unreadByFeed = useMemo(() => countBy(all.filter((a) => a.read_status === "unread"), "feeds"), [all]);

  const commands: Command[] = useMemo(() => [
    { label: t("palette.showUnread"), keys: "unread", icon: "unread", run: () => actions.scope({ kind: "unread" }) },
    { label: t("palette.showFavorites"), keys: "favorites star", icon: "star", run: () => actions.scope({ kind: "favorites" }) },
    { label: t("palette.showRecent"), keys: "recent", icon: "recent", run: () => actions.scope({ kind: "recent" }) },
    { label: t("palette.showAll"), keys: "all", icon: "all", run: () => actions.scope({ kind: "all" }) },
    ...genreCounts.map(([g]): Command => ({ label: t("palette.genreCommand", { name: g ?? t("common.unclassified") }), keys: `genre ${g ?? t("common.unclassified")}`, icon: "filter", run: () => actions.scope({ kind: "genre", name: g }) })),
    ...feeds.map((f): Command => ({ label: t("palette.sourceCommand", { name: feedName(f) }), keys: `source feed ${feedName(f)} ${f.title ?? ""} ${f.url}`, icon: "rss", run: () => actions.scope({ kind: "feed", id: f.id }) })),
    { label: t("palette.sourceCommand", { name: t("common.manual") }), keys: `source manual ${t("common.manual")}`, icon: "manual", run: () => actions.scope({ kind: "feed", id: null }) },
    ...groups.map((g): Command => ({ label: t("palette.groupCommand", { name: g.name }), keys: `group ${t("common.group")} ${g.name}`, icon: "folder", run: () => actions.scope({ kind: "group", id: g.id }) })),
    ...(actions.addToGroup ? [{ label: t("palette.addToGroup"), keys: `add group ${t("common.group")}`, icon: "folder", run: actions.addToGroup } as Command] : []),
    ...(actions.translate ? [{ label: t("palette.translate"), keys: "translate", icon: "translate", run: actions.translate } as Command] : []),
    { label: t("palette.langMixed"), keys: `translate mixed ratio ${t("palette.aliasRatio")}`, icon: "translate", run: (n) => actions.lang("mixed", n ?? undefined), withNumber: (n) => t("palette.langMixedN", { n }) },
    { label: t("palette.langOriginal"), keys: "original", icon: "translate", run: () => actions.lang("original") },
    { label: t("palette.langTranslated"), keys: "translated", icon: "translate", run: () => actions.lang("translated") },
    { label: t("palette.review"), keys: `review quiz ${t("palette.aliasQuiz")}`, icon: "review", run: () => actions.screen("review") },
    { label: t("palette.vocab"), keys: `vocab words ${t("palette.aliasVocab")}`, icon: "vocab", run: () => actions.screen("vocab") },
    { label: t("palette.jobs"), keys: "jobs", icon: "jobs", run: () => actions.screen("jobs") },
    { label: t("palette.retryFailed"), keys: "jobs failed retry", icon: "reload", run: () => { api.retryFailedJobs(null).catch(() => {}); actions.screen("jobs"); } },
    { label: t("palette.chat"), keys: `chat ${t("palette.aliasAsk")}`, icon: "chat", run: () => actions.chat() },
    { label: t("nav.manageFeeds"), keys: "feeds rss", icon: "rss", run: () => actions.screen("feeds") },
    { label: t("common.bulkImport"), keys: "import", icon: "import", run: () => actions.screen("import") },
    { label: t("common.importMarkdown"), keys: `markdown md import ${t("palette.aliasImport")}`, icon: "reader", run: actions.importMarkdown },
    { label: t("palette.importPdf"), keys: `pdf paper arxiv import ${t("palette.aliasImport")}`, icon: "reader", run: actions.importPdf },
    { label: t("palette.settings"), keys: "settings", icon: "gear", run: () => actions.screen("settings") },
  ], [genreCounts, feeds, groups, actions, t]);

  const items: Item[] = useMemo(() => {
    const out: Item[] = [];
    const prefix = /^(#|@|g:|>|\?)/.exec(raw)?.[1] ?? "";
    const text = raw.slice(prefix.length).trim();
    const tl = text.toLowerCase();
    const has = (s: string) => s.toLowerCase().includes(tl);
    const addTag = (tag: string) => actions.facets({ ...facets, tags: facets.tags.includes(tag) ? facets.tags : [...facets.tags, tag] });

    if (url) {
      const page: Item = { group: "url", icon: "page", label: t("reader.openInPage"), right: <Kbd>Enter</Kbd>, run: (newTab) => actions.page(url, newTab) };
      if (known) out.push({ group: "url", icon: "reader", label: t("palette.openInReader"), sub: known.title ?? undefined, right: t("palette.saved"), run: (newTab) => actions.open(known, newTab) });
      out.push(page);
      out.push({ group: "url", icon: "import", label: t("palette.index"), right: <><Kbd>Ctrl</Kbd><Kbd>Enter</Kbd></>, run: () => actions.index(url) });
      if (scope.kind === "group") {
        const id = scope.id;
        out.push({ group: "url", icon: "folder", label: t("palette.indexToGroup", { name: groupName(id, groups, t) }), run: () => actions.index(url, id) });
      }
      out.push({ group: "url", icon: "rss", label: t("palette.discover"), run: () => actions.discover(url) });
      return out;
    }

    if (prefix === "?" || (!prefix && text)) {
      const tag = !prefix ? tagCounts.find(([name]) => name.toLowerCase() === tl) ?? tagCounts.find(([name]) => name.toLowerCase().startsWith(tl)) : undefined;
      if (tag) {
        const n = shown.filter((a) => a.tags.includes(tag[0])).length;
        out.push({ group: "commands", icon: "filter", label: t.rich("palette.filterTag", { tag: <Tg>{tag[0]}</Tg> }), right: <>{t("palette.inSet", { n })} <Kbd>Enter</Kbd></>, run: () => addTag(tag[0]), stack: () => addTag(tag[0]) });
      }
      if (text) out.push({ group: "commands", icon: "search", label: t("palette.search", { text }), right: <>{t("palette.byBlock")} <Kbd>Ctrl</Kbd><Kbd>Enter</Kbd></>, run: () => actions.search(text) });
      if (tag) out.push({ group: "commands", icon: "chat", label: t("palette.chatTag", { tag: tag[0] }), run: () => actions.chat(filterKey({ kind: "tag", name: tag[0] })) });
      if (prefix === "?") return out;
    }

    if (!prefix || prefix === ">") {
      const words = tl.split(/\s+/).filter(Boolean);
      const num = words.map(Number).find((n) => Number.isInteger(n) && n >= 0 && n <= 100) ?? null;
      const terms = words.filter((w) => !/^\d+$/.test(w));
      // Per-genre, per-source and per-group commands only once the query asks for them.
      const cmds = commands.filter((c) => (terms.length ? terms.every((w) => `${c.label} ${c.keys}`.toLowerCase().includes(w)) : !/^(genre|source|group) /.test(c.keys)));
      const shownCmds = !prefix && text ? cmds.slice(0, 3) : cmds;
      for (const c of shownCmds) {
        out.push({ group: "commands", icon: c.icon, label: num != null && c.withNumber ? c.withNumber(num) : c.label, run: () => c.run(num) });
      }
      if (prefix === ">") return out;
    }

    if (!prefix && text) {
      const titled = all.filter((a) => has(a.title ?? a.original_url));
      for (const a of titled.slice(0, LIMIT)) {
        out.push({ group: "articles", icon: "reader", label: <Hl text={a.title ?? a.original_url} q={text} />,
          right: a.feed_title ?? (a.tags[0] ? <Tg>{a.tags[0]}</Tg> : siteOf(a, t)), run: (newTab) => actions.open(a, newTab) });
      }
    }
    if (!prefix ? text : prefix === "#") {
      for (const [tag, n] of tagCounts.filter(([name]) => has(name)).slice(0, prefix ? 12 : LIMIT)) {
        out.push({ group: "tags", label: <Tg>#<Hl text={tag} q={text} /></Tg>, right: t("palette.articleCount", { n }), run: () => addTag(tag), stack: () => addTag(tag) });
      }
    }
    if (!prefix ? text : prefix === "@") {
      const sources: [number | null, string][] = [...feeds.map((f): [number, string] => [f.id, feedName(f)]), [null, t("common.manual")]];
      for (const [id, name] of sources.filter(([, name]) => has(name)).slice(0, prefix ? 12 : LIMIT)) {
        const add = () => actions.facets({ ...facets, feeds: facets.feeds.includes(id) ? facets.feeds : [...facets.feeds, id] });
        out.push({ group: "sources", icon: id == null ? "manual" : "rss", label: <Hl text={name} q={text} />, sub: id == null ? undefined : t("common.feed"),
          right: t("palette.unreadCount", { n: unreadByFeed.get(id) ?? 0 }), run: () => actions.scope({ kind: "feed", id }), stack: add });
      }
    }
    if (!prefix ? text : prefix === "g:") {
      for (const [g, n] of genreCounts.filter(([g]) => has(g ?? t("common.unclassified"))).slice(0, prefix ? 12 : LIMIT)) {
        const add = () => actions.facets({ ...facets, genres: facets.genres.includes(g) ? facets.genres : [...facets.genres, g] });
        out.push({ group: "genres", label: <><span className="sw" style={{ background: genreSwatch(g) }} /><Hl text={g ?? t("common.unclassified")} q={text} /></>,
          right: t("palette.articleCount", { n }), run: () => actions.scope({ kind: "genre", name: g }), stack: add });
      }
    }
    return out;
  }, [raw, url, known, commands, all, shown, feeds, groups, scope, facets, tagCounts, genreCounts, unreadByFeed, actions, t]);

  useEffect(() => setAct(0), [raw]);
  useEffect(() => { list.current?.querySelector(".it.act")?.scrollIntoView({ block: "nearest" }); }, [act]);

  function run(it: Item | undefined, newTab = false) {
    if (!it) return;
    onClose();
    it.run(newTab);
  }

  function keys(e: React.KeyboardEvent) {
    const k = e.key;
    if (k === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (k === "ArrowDown" || k === "ArrowUp") {
      e.preventDefault();
      setAct((i) => (items.length ? (i + (k === "ArrowDown" ? 1 : -1) + items.length) % items.length : 0));
    } else if (k === "Enter") {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        onClose();
        if (url) actions.index(url);
        else if (raw) actions.search(raw.replace(/^\?/, "").trim());
        return;
      }
      if (items[act]) run(items[act]);
      else if (raw) { onClose(); actions.search(raw.replace(/^\?/, "").trim()); }
    } else if (k === "Tab" && items[act]?.stack) {
      e.preventDefault();
      items[act].stack();
      setQ("");
    }
  }

  const where = [scopeLabel(scope, all, groups, t), ...activeDims(facets).map((d) => facetLabel(facets, d, all, groups, t))].join(" · ");
  let lastGroup: Item["group"] | "" = "";
  return (
    <div ref={scrim} className="pal-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pal" role="dialog" aria-modal="true" aria-label={t("keys.palette")} onKeyDown={keys}>
        <label className="pal-q">
          <Icon name="search" />
          <span className="vh">{t("nav.searchPlaceholder")}</span>
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("palette.placeholder")}
            role="combobox" aria-expanded="true" aria-controls="pal-list" aria-activedescendant={items.length ? `pal-${act}` : undefined} />
          <span className="pal-where">{t("palette.where", { where })}</span>
        </label>
        <div className="pal-list" id="pal-list" role="listbox" ref={list}>
          {items.map((it, i) => {
            const heading = GROUPS[it.group];
            const head = it.group !== lastGroup && heading;
            lastGroup = it.group;
            return (
              <div key={i} role="presentation">
                {head && (
                  <div className="gh" role="presentation">{t(heading)}
                    {it.group === "articles" && <span>{t("palette.titleMatches", { n: all.length })}</span>}
                  </div>
                )}
                <button id={`pal-${i}`} role="option" aria-selected={i === act} className={`it${i === act ? " act" : ""}`} tabIndex={-1}
                  onMouseMove={() => setAct(i)} onClick={(e) => run(it, e.ctrlKey || e.metaKey)}>
                  {it.icon && <Icon name={it.icon} />}
                  <span className="it-l">{it.label}</span>
                  {it.sub && <span className="s">{it.sub}</span>}
                  {it.right && <span className="r">{it.right}</span>}
                </button>
              </div>
            );
          })}
          {items.length === 0 && <div className="pal-empty muted">{raw ? t("palette.noMatch") : t("palette.noCommands")}</div>}
        </div>
        <div className="ft">
          <span><b>#</b> {t("palette.ftTags")}</span><span><b>@</b> {t("palette.ftSources")}</span><span><b>g:</b> {t("palette.ftGenres")}</span><span><b>&gt;</b> {t("palette.ftCommands")}</span>
          <span><b>?</b> {t("palette.ftSearch")}</span><span>{t("palette.ftUrl")}</span>
          <span className="r"><Kbd>↑</Kbd><Kbd>↓</Kbd> <Kbd>Tab</Kbd> {t("palette.ftStack")}</span>
        </div>
      </div>
    </div>
  );
}
