import { useEffect, useMemo, useRef, useState } from "react";
import { api, siteOf, type ArticleRow, type FeedRow } from "./api";
import { feedName } from "./groups";
import { activeDims, countBy, facetLabel, genreSwatch, scopeLabel, type Facets, type Scope } from "./library";
import { filterKey } from "./scopes";
import { useCover } from "./Popover";
import { Icon, Kbd, type IconName } from "./Icon";
import type { Screen } from "./Nav";
import type { LanguageMode } from "./mixed";
import { t } from "./i18n";

export interface PaletteActions {
  scope: (s: Scope) => void;
  facets: (f: Facets) => void;
  /** `newTab`: Ctrl-clicked. */
  open: (a: ArticleRow, newTab?: boolean) => void;
  page: (url: string, newTab?: boolean) => void;
  index: (url: string) => void;
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
}

interface Item {
  group: string;
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
export function Palette({ initial, all, shown, feeds, scope, facets, actions, onClose }: {
  initial: string;
  all: ArticleRow[];
  /** The list as currently filtered, for "現在の集合で N 件". */
  shown: ArticleRow[];
  feeds: FeedRow[];
  scope: Scope;
  facets: Facets;
  actions: PaletteActions;
  onClose: () => void;
}) {
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
    { label: "未読を表示", keys: "unread 未読", icon: "unread", run: () => actions.scope({ kind: "unread" }) },
    { label: "お気に入りを表示", keys: "favorites star お気に入り", icon: "star", run: () => actions.scope({ kind: "favorites" }) },
    { label: "最近追加を表示", keys: "recent 最近", icon: "recent", run: () => actions.scope({ kind: "recent" }) },
    { label: "すべての記事を表示", keys: "all すべて", icon: "all", run: () => actions.scope({ kind: "all" }) },
    ...genreCounts.map(([g]): Command => ({ label: `ジャンル: ${g ?? t("common.unclassified")}`, keys: `genre ジャンル ${g ?? t("common.unclassified")}`, icon: "filter", run: () => actions.scope({ kind: "genre", name: g }) })),
    ...feeds.map((f): Command => ({ label: `ソース: ${feedName(f)}`, keys: `source feed ソース ${feedName(f)} ${f.title ?? ""} ${f.url}`, icon: "rss", run: () => actions.scope({ kind: "feed", id: f.id }) })),
    { label: `ソース: ${t("common.manual")}`, keys: `source ソース manual ${t("common.manual")}`, icon: "manual", run: () => actions.scope({ kind: "feed", id: null }) },
    ...(actions.translate ? [{ label: "この記事を翻訳（job を積む）", keys: "translate 翻訳", icon: "translate", run: actions.translate } as Command] : []),
    { label: "表示言語: 混在", keys: "translate mixed ratio 混在 割合 表示言語", icon: "translate", run: (n) => actions.lang("mixed", n ?? undefined), withNumber: (n) => `表示言語: 混在 · 訳文 ${n}%` },
    { label: "表示言語: 原文", keys: "original 原文 表示言語", icon: "translate", run: () => actions.lang("original") },
    { label: "表示言語: 訳文", keys: "translated 訳文 表示言語", icon: "translate", run: () => actions.lang("translated") },
    { label: "今日の復習を開く", keys: "review quiz 復習 クイズ", icon: "review", run: () => actions.screen("review") },
    { label: "処理状況を開く", keys: "jobs 処理状況", icon: "jobs", run: () => actions.screen("jobs") },
    { label: "失敗したジョブをすべて再実行", keys: "jobs failed retry 失敗 再実行", icon: "reload", run: () => { api.retryFailedJobs(null).catch(() => {}); actions.screen("jobs"); } },
    { label: "対話を開く", keys: "chat 対話 質問", icon: "chat", run: () => actions.chat() },
    { label: "フィードを管理", keys: "feeds フィード 管理 rss", icon: "rss", run: () => actions.screen("feeds") },
    { label: "一括インポート", keys: "import インポート", icon: "import", run: () => actions.screen("import") },
    { label: "Markdown を取り込む", keys: "markdown md import インポート 取り込む", icon: "reader", run: actions.importMarkdown },
    { label: "PDF（論文）を取り込む", keys: "pdf paper arxiv 論文 import インポート 取り込む", icon: "reader", run: actions.importPdf },
    { label: "設定を開く", keys: "settings 設定", icon: "gear", run: () => actions.screen("settings") },
  ], [genreCounts, feeds, actions]);

  const items: Item[] = useMemo(() => {
    const out: Item[] = [];
    const prefix = /^(#|@|g:|>|\?)/.exec(raw)?.[1] ?? "";
    const text = raw.slice(prefix.length).trim();
    const tl = text.toLowerCase();
    const has = (s: string) => s.toLowerCase().includes(tl);
    const addTag = (t: string) => actions.facets({ ...facets, tags: facets.tags.includes(t) ? facets.tags : [...facets.tags, t] });

    if (url) {
      const page: Item = { group: "URL", icon: "page", label: "Page で開く", right: <Kbd>Enter</Kbd>, run: (t) => actions.page(url, t) };
      if (known) out.push({ group: "URL", icon: "reader", label: "Reader で開く", sub: known.title ?? undefined, right: "保存済み", run: (t) => actions.open(known, t) });
      out.push(page);
      out.push({ group: "URL", icon: "import", label: "Index に追加（取り込み）", right: <><Kbd>Ctrl</Kbd><Kbd>Enter</Kbd></>, run: () => actions.index(url) });
      out.push({ group: "URL", icon: "rss", label: "フィードを検出して登録", run: () => actions.discover(url) });
      return out;
    }

    if (prefix === "?" || (!prefix && text)) {
      const tag = !prefix ? tagCounts.find(([t]) => t.toLowerCase() === tl) ?? tagCounts.find(([t]) => t.toLowerCase().startsWith(tl)) : undefined;
      if (tag) {
        const n = shown.filter((a) => a.tags.includes(tag[0])).length;
        out.push({ group: "コマンド", icon: "filter", label: <>タグで絞り込む: <Tg>{tag[0]}</Tg></>, right: <>現在の集合で {n} 件 <Kbd>Enter</Kbd></>, run: () => addTag(tag[0]), stack: () => addTag(tag[0]) });
      }
      if (text) out.push({ group: "コマンド", icon: "search", label: `「${text}」を Hybrid 検索`, right: <>block 単位 <Kbd>Ctrl</Kbd><Kbd>Enter</Kbd></>, run: () => actions.search(text) });
      if (tag) out.push({ group: "コマンド", icon: "chat", label: `タグ ${tag[0]} を範囲に対話を始める`, run: () => actions.chat(filterKey({ kind: "tag", name: tag[0] })) });
      if (prefix === "?") return out;
    }

    if (!prefix || prefix === ">") {
      const words = tl.split(/\s+/).filter(Boolean);
      const num = words.map(Number).find((n) => Number.isInteger(n) && n >= 0 && n <= 100) ?? null;
      const terms = words.filter((w) => !/^\d+$/.test(w));
      // Per-genre and per-source commands only once the query asks for them.
      const cmds = commands.filter((c) => (terms.length ? terms.every((w) => `${c.label} ${c.keys}`.toLowerCase().includes(w)) : !/^(genre|source) /.test(c.keys)));
      const shownCmds = !prefix && text ? cmds.slice(0, 3) : cmds;
      for (const c of shownCmds) {
        out.push({ group: "コマンド", icon: c.icon, label: num != null && c.withNumber ? c.withNumber(num) : c.label, run: () => c.run(num) });
      }
      if (prefix === ">") return out;
    }

    if (!prefix && text) {
      const titled = all.filter((a) => has(a.title ?? a.original_url));
      for (const a of titled.slice(0, LIMIT)) {
        out.push({ group: "記事", icon: "reader", label: <Hl text={a.title ?? a.original_url} q={text} />,
          right: a.feed_title ?? (a.tags[0] ? <Tg>{a.tags[0]}</Tg> : siteOf(a, t)), run: (t) => actions.open(a, t) });
      }
    }
    if (!prefix ? text : prefix === "#") {
      for (const [t, n] of tagCounts.filter(([t]) => has(t)).slice(0, prefix ? 12 : LIMIT)) {
        out.push({ group: "タグ", label: <Tg>#<Hl text={t} q={text} /></Tg>, right: `${n} 記事`, run: () => addTag(t), stack: () => addTag(t) });
      }
    }
    if (!prefix ? text : prefix === "@") {
      const sources: [number | null, string][] = [...feeds.map((f): [number, string] => [f.id, feedName(f)]), [null, t("common.manual")]];
      for (const [id, name] of sources.filter(([, name]) => has(name)).slice(0, prefix ? 12 : LIMIT)) {
        const add = () => actions.facets({ ...facets, feeds: facets.feeds.includes(id) ? facets.feeds : [...facets.feeds, id] });
        out.push({ group: "ソース", icon: id == null ? "manual" : "rss", label: <Hl text={name} q={text} />, sub: id == null ? undefined : "フィード",
          right: `${unreadByFeed.get(id) ?? 0} 未読`, run: () => actions.scope({ kind: "feed", id }), stack: add });
      }
    }
    if (!prefix ? text : prefix === "g:") {
      for (const [g, n] of genreCounts.filter(([g]) => has(g ?? t("common.unclassified"))).slice(0, prefix ? 12 : LIMIT)) {
        const add = () => actions.facets({ ...facets, genres: facets.genres.includes(g) ? facets.genres : [...facets.genres, g] });
        out.push({ group: "ジャンル", label: <><span className="sw" style={{ background: genreSwatch(g) }} /><Hl text={g ?? t("common.unclassified")} q={text} /></>,
          right: `${n} 記事`, run: () => actions.scope({ kind: "genre", name: g }), stack: add });
      }
    }
    return out;
  }, [raw, url, known, commands, all, shown, feeds, facets, tagCounts, genreCounts, unreadByFeed, actions]);

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

  const where = [scopeLabel(scope, all, t), ...activeDims(facets).map((d) => facetLabel(facets, d, all, t))].join(" · ");
  let lastGroup = "";
  return (
    <div ref={scrim} className="pal-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pal" role="dialog" aria-modal="true" aria-label="コマンドパレット" onKeyDown={keys}>
        <label className="pal-q">
          <Icon name="search" />
          <span className="vh">検索・コマンド・URL</span>
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="検索・コマンド・URL を入力"
            role="combobox" aria-expanded="true" aria-controls="pal-list" aria-activedescendant={items.length ? `pal-${act}` : undefined} />
          <span className="pal-where">現在: {where}</span>
        </label>
        <div className="pal-list" id="pal-list" role="listbox" ref={list}>
          {items.map((it, i) => {
            const head = it.group !== lastGroup && it.group !== "URL";
            lastGroup = it.group;
            return (
              <div key={i} role="presentation">
                {head && (
                  <div className="gh" role="presentation">{it.group}
                    {it.group === "記事" && <span>タイトル一致 · {all.length.toLocaleString()} 件から</span>}
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
          {items.length === 0 && <div className="pal-empty muted">{raw ? "一致する項目はありません。Enter で全文・意味検索します" : "コマンドなし"}</div>}
        </div>
        <div className="ft">
          <span><b>#</b> タグ</span><span><b>@</b> ソース</span><span><b>g:</b> ジャンル</span><span><b>&gt;</b> コマンドのみ</span>
          <span><b>?</b> 全文/意味検索</span><span>URL を貼ると開く・Index</span>
          <span className="r"><Kbd>↑</Kbd><Kbd>↓</Kbd> <Kbd>Tab</Kbd> 絞り込みを積む</span>
        </div>
      </div>
    </div>
  );
}
