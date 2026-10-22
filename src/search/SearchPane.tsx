import { useEffect, useMemo, useRef, useState } from "react";
import { siteOf, type ArticleRow, type GroupRow, type SearchHit, type SearchResult } from "../api";
import { DIM_LABELS, countBy, toggle, valueLabel, type Dim, type DimValue, type Facets, type Scope } from "../library/library";
import { excerpt, highlight, terms, type SearchMethod } from "./search";
import { FacetBar, mmdd } from "../library/ListPane";
import { ActionKey, Icon, Kbd } from "../ui/Icon";
import { onMiddle } from "../lib/middle";
import { FilterOptgroups } from "../library/FilterOptgroups";
import type { FilterGroup } from "../library/scopes";
import { useT, type PlainKey } from "../i18n";
import { withStarts } from "../lib/runs";

export const MATCH_LABEL = { lexical: "searchPane.lexical", semantic: "searchPane.semantic", both: "searchPane.both" } as const satisfies Record<
  string,
  PlainKey
>;
const METHODS: [SearchMethod, PlainKey][] = [
  ["hybrid", "searchPane.hybrid"],
  ["lexical", "searchPane.lexical"],
  ["semantic", "searchPane.semantic"],
];
const COMPACT: Dim[] = ["genres", "tags", "groups", "feeds", "state"];
const SHOWN_VALUES = 3;

export function Marked({ text, ts }: { text: string; ts: string[] }) {
  return <>{highlight(excerpt(text, ts), ts).map((s, i) => (s.mark ? <mark key={i}>{s.v}</mark> : s.v))}</>;
}

/** 範囲: the scope search runs in, as a chip-styled select. */
function ScopeSelect({
  scope,
  onScope,
  filters,
  importantMin,
}: {
  scope: Scope;
  onScope: (s: Scope) => void;
  filters: FilterGroup[];
  importantMin: number | null;
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
        {importantMin != null && <option value={JSON.stringify({ kind: "important", min: importantMin })}>{t("library.important")}</option>}
        {/* The group / genre / feed / folder filters are list scopes of the same shape. */}
        <FilterOptgroups groups={filters} />
      </select>
      <Icon name="down" size="sm" />
    </label>
  );
}

export function SearchPane({
  initial,
  result,
  busy,
  method,
  onMethod,
  hits,
  sel,
  onSel,
  open,
  onSearch,
  onOpen,
  onExit,
  scope,
  onScope,
  filters,
  importantMin,
  facets,
  onFacets,
  scoped,
  all,
  groups,
  articleById,
  focusSeq,
}: {
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
  /** The scope picker's options, from the chat's (`filterGroups`) without tags, which are not a list scope. */
  filters: FilterGroup[];
  /** 重要's threshold; null hides it, as in the sidebar. */
  importantMin: number | null;
  facets: Facets;
  onFacets: (f: Facets) => void;
  scoped: ArticleRow[];
  all: ArticleRow[];
  groups: GroupRow[];
  articleById: Map<number, ArticleRow>;
  /** Bumped to move focus back into the search box (the `/` key). */
  focusSeq: number;
}) {
  const t = useT();
  const [q, setQ] = useState(initial);
  const [moreDims, setMoreDims] = useState<Set<Dim>>(new Set());
  const input = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [prevInitial, setPrevInitial] = useState(initial);
  if (prevInitial !== initial) {
    setPrevInitial(initial);
    setQ(initial);
  }
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- each bump of focusSeq (the `/` key) is a request to focus
  }, [focusSeq]);
  useEffect(() => {
    body.current?.querySelectorAll(".hit")[sel]?.scrollIntoView({ block: "nearest" });
  }, [sel]);

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
    if (e.defaultPrevented || t.tagName === "SELECT") {
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onExit();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length) {
        onSel(Math.max(0, Math.min(flat.length - 1, sel + (e.key === "ArrowDown" ? 1 : -1))));
      }
    } else if (e.key === "Enter" && t === input.current && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (q.trim() && q.trim() !== initial) {
        onSearch(q.trim());
      } else if (flat[sel]) {
        onOpen(flat[sel], e.shiftKey);
      }
    }
  }

  return (
    <section className="list search" aria-label={t("searchPane.results")} data-pane="list" onKeyDown={keys}>
      <header className="list-h">
        <div className="search-q">
          <label className="vh" htmlFor="search-q">
            {t("searchPane.terms")}
          </label>
          <input id="search-q" ref={input} className="input lg" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("searchPane.searchSaved")} />
          <div className="seg" role="group" aria-label={t("searchPane.method")} title={t("searchPane.methodHint")}>
            {METHODS.map(([m, label]) => (
              <button
                key={m}
                className={method === m ? "on" : ""}
                aria-pressed={method === m}
                onClick={() => onMethod(m)}
                disabled={m === "semantic" && semanticOff}
              >
                {t(label)}
              </button>
            ))}
          </div>
        </div>
        <FacetBar facets={facets} onFacets={onFacets} scoped={scoped} all={all} groups={groups} dims={["genres", "tags", "groups", "feeds"]}>
          <ScopeSelect scope={scope} onScope={onScope} filters={filters} importantMin={importantMin} />
        </FacetBar>
        <div className="search-count mono">
          {busy ? t("searchPane.searching") : result ? t("searchPane.count", { length: flat.length, length2: hits.length }) : ""}
        </div>
        {result && hitArticles.length > 0 && (
          <div className="ftab">
            {COMPACT.map((d) => {
              const counts = [...countBy(hitArticles, d)]
                .filter(([v]) => d !== "state" || v === "unread" || v === "favorite" || v === "issue")
                .sort((a, b) => b[1] - a[1]);
              if (counts.length === 0) {
                return null;
              }
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
                          {valueLabel(d, v, all, groups, t)} <b>{c}</b>
                        </button>
                      );
                    })}
                    {counts.length > SHOWN_VALUES && (
                      <button
                        className="more"
                        onClick={() =>
                          setMoreDims((s) => {
                            const x = new Set(s);
                            if (!x.delete(d)) {
                              x.add(d);
                            }
                            return x;
                          })
                        }
                      >
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
            <button className="btn sm" onClick={() => onSearch(initial)}>
              {t("searchPane.retry")}
            </button>
          </div>
        )}
      </header>
      <div className="list-body" ref={body}>
        {result && hits.length === 0 && !busy && (
          <div className="empty">
            <div className="muted">{t("searchPane.none")}</div>
          </div>
        )}
        {withStarts(hits, (g) => g.hits.length).map(({ item: g, start }) => {
          const a = articleById.get(g.article_id);
          return (
            <div className="sgrp" key={g.article_id}>
              <div className="at">{a?.title ?? g.hits[0]?.article_title}</div>
              <div className="am">
                {a && <span>{a.feed_title ?? a.site_name ?? siteOf(a, t)}</span>}
                {a && <span>{mmdd(a.saved_at)}</span>}
                <span>{t("searchPane.matches", { length: g.hits.length })}</span>
              </div>
              {g.hits.map((h, hi) => {
                const i = start + hi;
                return (
                  <button
                    key={h.block_id}
                    className={`hit${i === sel ? " cur" : ""}${open?.id === h.article_id && open.block === h.block_id ? " sel" : ""}`}
                    onClick={(e) => {
                      onSel(i);
                      onOpen(h, e.shiftKey, e.ctrlKey || e.metaKey);
                    }}
                    {...onMiddle(() => onOpen(h, false, true))}
                    onFocus={() => onSel(i)}
                  >
                    <span className="sh">{h.heading && h.heading !== h.text ? h.heading : t("searchPane.top")}</span>
                    <span className={`mt ${h.source}`}>
                      {t(MATCH_LABEL[h.source])}
                      {h.source === "semantic" && ` ${h.score.toFixed(2)}`}
                    </span>
                    <span className="tx">
                      <Marked text={h.text} ts={ts} />
                    </span>
                    {h.translation && (
                      <span className="tx tr">
                        <Marked text={h.translation} ts={ts} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
      <footer className="list-f hints">
        <span>
          <ActionKey id="next" />
          <ActionKey id="prev" />
          {t("searchPane.hintMatches")}
        </span>
        <span>
          <Kbd>Enter</Kbd>
          {t("searchPane.hintReader")}
        </span>
        <span>
          <Kbd>Shift</Kbd>
          <Kbd>Enter</Kbd>
          {t("searchPane.hintPage")}
        </span>
        <span className="r">
          <Kbd>Esc</Kbd>
          {t("searchPane.hintBack")}
        </span>
      </footer>
    </section>
  );
}
