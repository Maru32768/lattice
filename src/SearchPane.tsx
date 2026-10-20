import { useEffect, useMemo, useRef, useState } from "react";
import { siteOf, type ArticleRow, type SearchHit, type SearchResult } from "./api";
import { DIM_LABELS, countBy, toggle, valueLabel, type Dim, type DimValue, type Facets, type Scope } from "./library";
import { excerpt, highlight, terms, type SearchMethod } from "./search";
import { FacetBar, mmdd } from "./ListPane";
import { ActionKey, Icon, Kbd } from "./Icon";
import { onMiddle } from "./middle";
import { useT, type PlainKey } from "./i18n";

export const MATCH_LABEL = { lexical: "searchPane.lexical", semantic: "searchPane.semantic", both: "searchPane.both" } as const satisfies Record<string, PlainKey>;
const METHODS: [SearchMethod, PlainKey][] = [["hybrid", "searchPane.hybrid"], ["lexical", "searchPane.lexical"], ["semantic", "searchPane.semantic"]];
const COMPACT: Dim[] = ["genres", "tags", "feeds", "state"];
const SHOWN_VALUES = 3;

export function Marked({ text, ts }: { text: string; ts: string[] }) {
  return <>{highlight(excerpt(text, ts), ts).map((s, i) => (s.mark ? <mark key={i}>{s.v}</mark> : s.v))}</>;
}

/** 範囲: the scope search runs in, as a chip-styled select. */
function ScopeSelect({ scope, onScope, genres, feeds }: {
  scope: Scope; onScope: (s: Scope) => void; genres: (string | null)[]; feeds: [number | null, string][];
}) {
  const t = useT();
  return (
    <label className="chip scope-chip">
      <span className="k">{t("chatPane.scope")}</span>
      <select value={JSON.stringify(scope)} onChange={(e) => onScope(JSON.parse(e.target.value) as Scope)} aria-label={t("searchPane.scope")}>
        <option value={JSON.stringify({ kind: "all" })}>{t("common.allArticles")}</option>
        <option value={JSON.stringify({ kind: "recent" })}>{t("library.recent")}</option>
        <option value={JSON.stringify({ kind: "unread" })}>{t("common.unread")}</option>
        <option value={JSON.stringify({ kind: "favorites" })}>{t("common.favorites")}</option>
        <optgroup label={t("common.genre")}>
          {genres.map((g) => <option key={String(g)} value={JSON.stringify({ kind: "genre", name: g })}>{g ?? t("common.unclassified")}</option>)}
        </optgroup>
        <optgroup label={t("common.source")}>
          {feeds.map(([id, name]) => <option key={String(id)} value={JSON.stringify({ kind: "feed", id })}>{name}</option>)}
        </optgroup>
      </select>
      <Icon name="down" size="sm" />
    </label>
  );
}

export function SearchPane({ initial, result, busy, method, onMethod, hits, sel, onSel, open, onSearch, onOpen, onExit,
  scope, onScope, facets, onFacets, scoped, all, articleById, focusSeq }: {
  initial: string;
  result: SearchResult | null;
  busy: boolean;
  method: SearchMethod;
  onMethod: (m: SearchMethod) => void;
  /** Hits after the method filter and scope ∧ facets, grouped by article. */
  hits: { article_id: number; hits: SearchHit[] }[];
  /** The cursor (j / k, ↑ ↓) over the flat hit list. */
  sel: number;
  onSel: (i: number) => void;
  /** The hit open in the Reader. */
  open: { id: number; block: number } | null;
  onSearch: (q: string) => void;
  /** `page`: Shift; `newTab`: Ctrl / middle click. */
  onOpen: (hit: SearchHit, page: boolean, newTab?: boolean) => void;
  onExit: () => void;
  scope: Scope;
  onScope: (s: Scope) => void;
  facets: Facets;
  onFacets: (f: Facets) => void;
  scoped: ArticleRow[];
  all: ArticleRow[];
  articleById: Map<number, ArticleRow>;
  /** Bumped to move focus back into the search box (the `/` key). */
  focusSeq: number;
}) {
  const t = useT();
  const [q, setQ] = useState(initial);
  const [moreDims, setMoreDims] = useState<Set<Dim>>(new Set());
  const input = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { setQ(initial); }, [initial]);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, [focusSeq]);
  useEffect(() => { body.current?.querySelector(".hit.cur")?.scrollIntoView({ block: "nearest" }); }, [sel]);

  const flat = hits.flatMap((g) => g.hits);
  const ts = terms(result ? initial : "");
  const semanticOff = !!result?.semantic_error;

  // Compact facet table: counts over the articles that have hits (before facets, so choices stay visible).
  const hitArticles = useMemo(() => {
    const ids = new Set(result?.hits.map((h) => h.article_id));
    return scoped.filter((a) => ids.has(a.id));
  }, [result, scoped]);

  function keys(e: React.KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (e.defaultPrevented || t.tagName === "SELECT") return;
    if (e.key === "Escape") {
      e.preventDefault();
      onExit();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length) onSel(Math.max(0, Math.min(flat.length - 1, sel + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter" && t === input.current && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (q.trim() && q.trim() !== initial) onSearch(q.trim());
      else if (flat[sel]) onOpen(flat[sel], e.shiftKey);
    }
  }

  const feedNames: [number | null, string][] = [...new Set(all.map((a) => a.feed_id))].map((id) => [id, id == null ? t("common.manual") : valueLabel("feeds", id, all, t)]);
  let n = 0;
  return (
    <section className="list search" aria-label={t("searchPane.results")} data-pane="list" onKeyDown={keys}>
      <header className="list-h">
        <div className="search-q">
          <label className="vh" htmlFor="search-q">{t("searchPane.terms")}</label>
          <input id="search-q" ref={input} className="input lg" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("searchPane.searchSaved")} />
          <div className="seg" role="group" aria-label={t("searchPane.method")} title={t("searchPane.methodHint")}>
            {METHODS.map(([m, label]) => (
              <button key={m} className={method === m ? "on" : ""} aria-pressed={method === m} onClick={() => onMethod(m)}
                disabled={m === "semantic" && semanticOff}>{t(label)}</button>
            ))}
          </div>
        </div>
        <FacetBar facets={facets} onFacets={onFacets} scoped={scoped} all={all} dims={["genres", "tags", "feeds"]}>
          <ScopeSelect scope={scope} onScope={onScope} genres={[...countBy(all, "genres").keys()]} feeds={feedNames} />
        </FacetBar>
        <div className="search-count mono">{busy ? t("searchPane.searching") : result ? t("searchPane.count", { length: flat.length, length2: hits.length }) : ""}</div>
        {result && hitArticles.length > 0 && (
          <div className="ftab">
            {COMPACT.map((d) => {
              const counts = [...countBy(hitArticles, d)].filter(([v]) => d !== "state" || v === "unread" || v === "favorite" || v === "issue")
                .sort((a, b) => b[1] - a[1]);
              if (counts.length === 0) return null;
              const open = moreDims.has(d);
              const shown = open ? counts : counts.slice(0, SHOWN_VALUES);
              return (
                <div className="fr" key={d}>
                  <span className="l">{t(DIM_LABELS[d])}</span>
                  <div className="fv">
                    {shown.map(([v, c]) => {
                      const on = (facets[d] as DimValue<Dim>[]).includes(v);
                      return (
                        <button key={String(v)} className={on ? "on" : ""} aria-pressed={on} onClick={() => onFacets(toggle(facets, d, v))}>
                          {valueLabel(d, v, all, t)} <b>{c}</b>
                        </button>
                      );
                    })}
                    {counts.length > SHOWN_VALUES && (
                      <button className="more" onClick={() => setMoreDims((s) => { const x = new Set(s); if (!x.delete(d)) x.add(d); return x; })}>
                        {open ? t("common.close") : `+${counts.length - SHOWN_VALUES}`}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {semanticOff && (
          <div className="note warn center">
            <Icon name="offline" />
            <span className="grow">{t("searchPane.lexicalOnly", { semantic_error: t.msg(result.semantic_error) })}</span>
            <button className="btn sm" onClick={() => onSearch(initial)}>{t("searchPane.retry")}</button>
          </div>
        )}
      </header>
      <div className="list-body" ref={body}>
        {result && hits.length === 0 && !busy && <div className="empty"><div className="muted">{t("searchPane.none")}</div></div>}
        {hits.map((g) => {
          const a = articleById.get(g.article_id);
          return (
            <div className="sgrp" key={g.article_id}>
              <div className="at">{a?.title ?? g.hits[0].article_title}</div>
              <div className="am">
                {a && <span>{a.feed_title ?? a.site_name ?? siteOf(a, t)}</span>}
                {a && <span>{mmdd(a.saved_at)}</span>}
                <span>{t("searchPane.matches", { length: g.hits.length })}</span>
              </div>
              {g.hits.map((h) => {
                const i = n++;
                return (
                  <button key={h.block_id} className={`hit${i === sel ? " cur" : ""}${open?.id === h.article_id && open.block === h.block_id ? " sel" : ""}`}
                    onClick={(e) => { onSel(i); onOpen(h, e.shiftKey, e.ctrlKey || e.metaKey); }} {...onMiddle(() => onOpen(h, false, true))}
                    onFocus={() => onSel(i)}>
                    <span className="sh">{h.heading && h.heading !== h.text ? h.heading : t("searchPane.top")}</span>
                    <span className={`mt ${h.source}`}>{t(MATCH_LABEL[h.source])}{h.source === "semantic" && ` ${h.score.toFixed(2)}`}</span>
                    <span className="tx"><Marked text={h.text} ts={ts} /></span>
                    {h.translation && <span className="tx tr"><Marked text={h.translation} ts={ts} /></span>}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
      <footer className="list-f hints">
        <span><ActionKey id="next" /><ActionKey id="prev" />{t("searchPane.hintMatches")}</span>
        <span><Kbd>Enter</Kbd>{t("searchPane.hintReader")}</span>
        <span><Kbd>Shift</Kbd><Kbd>Enter</Kbd>{t("searchPane.hintPage")}</span>
        <span className="r"><Kbd>Esc</Kbd>{t("searchPane.hintBack")}</span>
      </footer>
    </section>
  );
}
