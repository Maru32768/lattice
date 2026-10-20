import { useState } from "react";
import { siteOf, type ArticleRow, type ArticleSort } from "./api";
import { DIMS, DIM_LABELS, activeDims, facetBase, facetLabel, without, type Dim, type Facets, type Relaxation } from "./library";
import type { Group } from "./groups";
import { FacetPopover } from "./FacetPopover";
import { Menu } from "./Popover";
import { ActionKey, Dif, Icon, Kbd } from "./Icon";
import { Favicon } from "./Favicon";
import { onMiddle } from "./middle";
import { t, useT, type PlainKey } from "./i18n";

export type Grouping = "none" | "feed" | "genre";

export const SORTS: [ArticleSort, PlainKey][] = [
  ["saved_desc", "listPane.savedDesc"],
  ["saved_asc", "listPane.savedAsc"],
  ["published_desc", "listPane.publishedDesc"],
  ["difficulty_asc", "listPane.difficultyAsc"],
  ["relevance_desc", "listPane.relevanceDesc"],
];
const GROUPINGS: [Grouping, PlainKey][] = [["none", "common.none"], ["feed", "common.source"], ["genre", "common.genre"]];

export const mmdd = (s: string) => {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s.slice(5, 10).replace("-", "/") : `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
};

/** A status badge only when something is abnormal. */
function badge(a: ArticleRow, translating: string | null): [string, string] | null {
  if (a.fetch_status === "pending") return ["run", t("listPane.fetching")];
  if (a.fetch_status === "failed") return ["err", t("listPane.fetchFailed")];
  if (a.extraction_status === "failed") return ["err", t("listPane.extractFailed")];
  if (translating) return ["run", translating];
  if (a.thin) return ["warn", t("listPane.thin")];
  return null;
}

/** Only important articles (4-5) get a mark; the reason is its tooltip. */
function Importance({ a }: { a: ArticleRow }) {
  const t = useT();
  if (a.relevance == null || a.relevance < 4) return null;
  return <span className={`imp s${a.relevance}`} title={a.relevance_reason ?? undefined}>{t("listPane.importance", { score: a.relevance })}</span>;
}

/** `sel`: the open article; `cur`: the keyboard cursor (j / k), opened with Enter. */
export function ArticleRowView({ a, sel, cur, sort, translating, onOpen, onCursor }: {
  a: ArticleRow; sel: boolean; cur: boolean; sort: ArticleSort; translating: string | null; onOpen: (newTab: boolean) => void; onCursor: () => void;
}) {
  const t = useT();
  const b = badge(a, translating);
  const unread = a.read_status === "unread";
  return (
    <button className={`row${sel ? " sel" : ""}${cur ? " cur" : ""}${unread ? "" : " read"}`} onClick={(e) => onOpen(e.ctrlKey || e.metaKey)}
      {...onMiddle(() => onOpen(true))} onFocus={onCursor}
      aria-current={sel || undefined} data-id={a.id}>
      {unread && <span className="dot" aria-label={t("common.unread")} />}
      <span className="t">{a.title ?? a.original_url}</span>
      <span className="meta">
        <span className="with-ico"><Favicon domain={a.domain} feed={a.feed_id} />{a.feed_title ?? a.site_name ?? siteOf(a, t)}</span>
        <span>{mmdd((sort === "published_desc" && a.published_at) || a.saved_at)}</span>
        {a.difficulty != null && <Dif d={a.difficulty} />}
        <Importance a={a} />
        {a.favorite && <span className="fav" aria-label={t("common.favorites")}><Icon name="star" size="sm" /></span>}
        {b && <span className={`bd ${b[0]}`}>{b[1]}</span>}
      </span>
      {a.tags.length > 0 && <span className="tags">{a.tags.join(" · ")}</span>}
    </button>
  );
}

/** Active facets as removable chips, inactive dimensions as popover openers. */
export function FacetBar({ facets, onFacets, scoped, all, dims = DIMS, children }: {
  facets: Facets;
  onFacets: (f: Facets) => void;
  scoped: ArticleRow[];
  all: ArticleRow[];
  dims?: Dim[];
  children?: React.ReactNode;
}) {
  const t = useT();
  const [open, setOpen] = useState<{ dim: Dim; el: HTMLElement } | null>(null);
  const active = activeDims(facets);
  const toggleOpen = (dim: Dim) => (e: React.MouseEvent<HTMLElement>) => {
    const el = e.currentTarget.closest<HTMLElement>(".chip")!;
    setOpen((o) => (o?.dim === dim ? null : { dim, el }));
  };
  // Picking a dimension's first value replaces its chip (button → active chip). The open popover
  // follows the dimension to the new chip, so it still toggles from it and returns focus to it.
  const chipRef = (dim: Dim) => (el: HTMLElement | null) => {
    if (el && open?.dim === dim && open.el !== el) setOpen({ dim, el });
  };
  return (
    <div className="chips">
      {children}
      {active.map((d) => (
        <span key={d} ref={chipRef(d)} className={`chip on${open?.dim === d ? " open" : ""}`}>
          <button className="chip-body" onClick={toggleOpen(d)} aria-haspopup="dialog" aria-expanded={open?.dim === d}>
            <span className="k">{t(DIM_LABELS[d])}</span>{facetLabel(facets, d, all, t)}
          </button>
          <button className="x" onClick={() => onFacets(without(facets, d))} aria-label={t("listPane.clearFacet", { label: t(DIM_LABELS[d]) })}><Icon name="x" size="sm" /></button>
        </span>
      ))}
      {dims.filter((d) => !active.includes(d)).map((d) => (
        <button key={d} ref={chipRef(d)} className={`chip${d === "state" ? " dashed" : ""}${open?.dim === d ? " open" : ""}`} onClick={toggleOpen(d)}
          aria-haspopup="dialog" aria-expanded={open?.dim === d}>
          {t(DIM_LABELS[d])}{d !== "state" && <Icon name="down" size="sm" />}
        </button>
      ))}
      {open && (
        <FacetPopover dim={open.dim} facets={facets} onFacets={onFacets} base={facetBase(scoped, facets, open.dim)} all={all}
          anchor={open.el} onClose={() => setOpen(null)} />
      )}
    </div>
  );
}

export function SortMenu({ sort, onSort, group, onGroup }: {
  sort: ArticleSort; onSort: (s: ArticleSort) => void; group: Grouping; onGroup: (g: Grouping) => void;
}) {
  const t = useT();
  const label = t(SORTS.find(([s]) => s === sort)![1]);
  return (
    <Menu className="tb sort" label={t("listPane.sortGroup")} title={t("listPane.sortGroup")}
      trigger={<><Icon name="sort" size="md" />{label}{group !== "none" && ` · ${t(GROUPINGS.find(([g]) => g === group)![1])}`}</>}
      items={[
        t("listPane.sort"),
        ...SORTS.map(([s, l]) => ({ label: t(l), checked: s === sort, onSelect: () => onSort(s) })),
        "-",
        t("listPane.group"),
        ...GROUPINGS.map(([g, l]) => ({ label: t(l), checked: g === group, onSelect: () => onGroup(g) })),
      ]} />
  );
}

export function ListPane({ title, count, total, facets, onFacets, scoped, all, groups, sort, onSort, group, onGroup, selectedId, cursorId, onCursor,
  translating, relax, onRelax, onOpen, onCollapse, onRescore, noProfile }: {
  title: string;
  count: number;
  total: number;
  facets: Facets;
  onFacets: (f: Facets) => void;
  scoped: ArticleRow[];
  all: ArticleRow[];
  /** Shown articles; one unnamed group when not grouping. */
  groups: Group<ArticleRow>[];
  sort: ArticleSort;
  onSort: (s: ArticleSort) => void;
  group: Grouping;
  onGroup: (g: Grouping) => void;
  selectedId: number | null;
  cursorId: number | null;
  onCursor: (id: number) => void;
  translating: { id: number; label: string } | null;
  relax: Relaxation[];
  onRelax: (r: Relaxation) => void;
  /** `newTab`: Ctrl / middle click. */
  onOpen: (a: ArticleRow, newTab: boolean) => void;
  onCollapse: () => void;
  /** 「重要度を付け直す」 for the shown articles, resolving to how many were queued; absent when importance is not in view or there is no profile. */
  onRescore?: () => Promise<number>;
  /** No 「自分について」 profile: nothing is rated, which the list says when sorted by importance. */
  noProfile?: boolean;
}) {
  const t = useT();
  const [rescored, setRescored] = useState<string | null>(null);
  const hasFacets = activeDims(facets).length > 0;
  const rescore = (run: () => Promise<number>) => run().then((n) => setRescored(t("listPane.rescoreQueued", { n })), (e) => setRescored(t.msg(String(e))));
  const renderGroup = (g: Group<ArticleRow>, depth: number): React.ReactNode => (
    <div key={g.key} role="group" aria-label={g.label || undefined}>
      {g.label && <div className={`grp-h d${depth}`}><span className="label">{g.label}</span><span className="n">{g.articles.length}</span></div>}
      {g.children
        ? g.children.map((c) => renderGroup(c, depth + 1))
        : g.articles.map((a) => (
          <ArticleRowView key={a.id} a={a} sel={a.id === selectedId} cur={a.id === cursorId} sort={sort} onOpen={(t) => onOpen(a, t)} onCursor={() => onCursor(a.id)}
            translating={translating?.id === a.id ? translating.label : null} />
        ))}
    </div>
  );
  return (
    <section className="list" aria-label={t("listPane.articles")} data-pane="list">
      <header className="list-h">
        <div className="list-title">
          <h1>{title}</h1>
          <span className="mono count">{count} / {total}</span>
          <button className="ib" onClick={onCollapse} aria-label={t("listPane.close")} title={t("listPane.close")}><Icon name="left" /></button>
        </div>
        <FacetBar facets={facets} onFacets={onFacets} scoped={scoped} all={all} />
        <div className="list-tools">
          <SortMenu sort={sort} onSort={onSort} group={group} onGroup={onGroup} />
          {onRescore && <button className="tb" onClick={() => rescore(onRescore)} disabled={count === 0} title={t("listPane.rescoreHint")}>{t("listPane.rescore")}</button>}
          {onRescore && rescored && <span className="muted" role="status">{rescored}</span>}
          {noProfile && sort === "relevance_desc" && <span className="muted">{t("listPane.noProfile")}</span>}
          <button className="clear" onClick={() => onFacets({ ...facets, genres: [], tags: [], feeds: [], difficulty: [], relevance: [], state: [] })} disabled={!hasFacets}>
            {t("listPane.clear")}<Kbd>Esc</Kbd>
          </button>
        </div>
      </header>
      <div className="list-body">
        {count > 0 ? groups.map((g) => renderGroup(g, 0))
          : total > 0 || relax.length > 0 ? (
            <div className="empty">
              <div className="empty-h">{t("listPane.noMatch")}</div>
              {relax.length > 0 && <>
                <div className="muted">{t("listPane.relaxHint")}</div>
                <div className="btn-row">
                  {relax.map((r) => <button key={r.label} className="btn" onClick={() => onRelax(r)}>{t("listPane.relaxation", { label: r.label, count: r.count })}</button>)}
                </div>
              </>}
            </div>
          ) : <div className="empty"><div className="muted">{all.length === 0 ? t("listPane.empty") : t("listPane.emptyList")}</div></div>}
      </div>
      <footer className="list-f hints">
        <span><ActionKey id="next" /><ActionKey id="prev" />{t("common.hintMove")}</span>
        <span><ActionKey id="open" />{t("common.hintOpen")}</span>
        <span><ActionKey id="favorite" />{t("listPane.hintFavorite")}</span>
        <span><ActionKey id="read" />{t("listPane.hintRead")}</span>
      </footer>
    </section>
  );
}

export function ListRail({ label, index, count, onOpen, onPrev, onNext }: {
  label: string; index: number; count: number; onOpen: () => void; onPrev: () => void; onNext: () => void;
}) {
  const t = useT();
  return (
    <section className="list-rail" aria-label={t("listPane.rail")} data-pane="list">
      <button className="ib" onClick={onOpen} aria-label={t("listPane.open")} title={t("listPane.open")}><Icon name="right" /></button>
      <button className="ib" onClick={onPrev} aria-label={t("listPane.prev")} title={t("listPane.prev")}><Icon name="up" /></button>
      <span className="vlabel mono">{index > 0 ? index : "–"} / {count} · {label}</span>
      <button className="ib" onClick={onNext} aria-label={t("listPane.next")} title={t("listPane.next")}><Icon name="down" /></button>
    </section>
  );
}
