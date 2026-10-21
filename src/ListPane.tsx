import { useEffect, useState } from "react";
import { siteOf, type ArticleRow, type ArticleSort, type GroupRow } from "./api";
import { DIMS, DIM_LABELS, NO_FACETS, activeDims, facetBase, facetLabel, without, type Dim, type Facets, type Relaxation } from "./library";
import { flatten, type Group } from "./groups";
import { pick } from "./selection";
import { FacetPopover } from "./FacetPopover";
import { GroupPicker } from "./GroupPicker";
import { Menu, openOverlays } from "./Popover";
import { actionFor, getBindings } from "./keys";
import { keyOf } from "./keyname";
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

/**
 * `sel`: the open article; `cur`: the keyboard cursor (j / k), opened with Enter. `picked` is set
 * while rows are picked for a bulk action: a click then picks instead of opening (Shift+click
 * starts picking).
 */
export function ArticleRowView({ a, sel, cur, sort, translating, picked, onOpen, onPick, onCursor, onMenu }: {
  a: ArticleRow; sel: boolean; cur: boolean; sort: ArticleSort; translating: string | null; picked?: boolean;
  onOpen: (newTab: boolean) => void; onPick?: (range: boolean) => void; onCursor: () => void; onMenu?: (e: React.MouseEvent<HTMLElement>) => void;
}) {
  const t = useT();
  const b = badge(a, translating);
  const unread = a.read_status === "unread";
  return (
    <button className={`row${sel ? " sel" : ""}${cur ? " cur" : ""}${unread ? "" : " read"}${picked !== undefined ? " picking" : ""}`}
      onClick={(e) => (onPick && (picked !== undefined || e.shiftKey) ? onPick(e.shiftKey) : onOpen(e.ctrlKey || e.metaKey))}
      {...onMiddle(() => onOpen(true))} onFocus={onCursor} onContextMenu={onMenu}
      aria-current={sel || undefined} aria-pressed={picked} data-id={a.id}>
      {picked !== undefined && <span className={`cb${picked ? " on" : ""}`} aria-hidden="true">{picked && "✓"}</span>}
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
export function FacetBar({ facets, onFacets, scoped, all, groups, dims = DIMS, children }: {
  facets: Facets;
  onFacets: (f: Facets) => void;
  scoped: ArticleRow[];
  all: ArticleRow[];
  groups: GroupRow[];
  dims?: Dim[];
  children?: React.ReactNode;
}) {
  const t = useT();
  // Without groups the dimension would only open an empty popover.
  if (groups.length === 0) dims = dims.filter((d) => d !== "groups");
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
            <span className="k">{t(DIM_LABELS[d])}</span>{facetLabel(facets, d, all, groups, t)}
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
        <FacetPopover dim={open.dim} facets={facets} onFacets={onFacets} base={facetBase(scoped, facets, open.dim)} all={all} groups={groups}
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

export function ListPane({ title, count, total, facets, onFacets, scoped, all, groups, groupRows, sort, onSort, group, onGroup, selectedId, cursorId, onCursor,
  translating, relax, onRelax, onOpen, onGroupMembers, onCreateGroup, onRowMenu, onCollapse, onRescore, noProfile }: {
  title: string;
  count: number;
  total: number;
  facets: Facets;
  onFacets: (f: Facets) => void;
  scoped: ArticleRow[];
  all: ArticleRow[];
  /** Shown articles; one unnamed group when not grouping. */
  groups: Group<ArticleRow>[];
  /** The user's groups (G53): the facet and the bulk グループに追加. */
  groupRows: GroupRow[];
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
  onGroupMembers: (group: number, ids: number[], add: boolean) => void;
  onCreateGroup: (name: string) => Promise<number>;
  /** A row's context menu, for that row or, when it is one of the picked rows, for all of them. */
  onRowMenu: (rows: ArticleRow[], from: HTMLElement) => void;
  onCollapse: () => void;
  /** 「重要度を付け直す」 for the shown articles, resolving to how many were queued; absent when importance is not in view or there is no profile. */
  onRescore?: () => Promise<number>;
  /** No 「自分について」 profile: nothing is rated, which the list says when sorted by importance. */
  noProfile?: boolean;
}) {
  const t = useT();
  const [rescored, setRescored] = useState<string | null>(null);
  const hasFacets = activeDims(facets).length > 0;
  /** Rows picked for a bulk action; null while not picking. */
  const [picked, setPicked] = useState<number[] | null>(null);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [picker, setPicker] = useState<HTMLElement | null>(null);
  useEffect(() => { setPicked(null); setPicker(null); }, [title]);
  // Esc ends picking before it clears the filters (the shell's Esc); an open popover closes first.
  const picking = picked != null;
  useEffect(() => {
    if (!picking) return;
    const esc = (e: KeyboardEvent) => {
      const key = keyOf(e);
      if (e.defaultPrevented || !key || actionFor(getBindings(), key)?.id !== "escape" || openOverlays()) return;
      if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable='true']")) return;
      e.preventDefault();
      setPicked(null);
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [picking]);
  const order = flatten(groups);
  const pickedRows = order.filter((a) => picked?.includes(a.id));
  const ids = pickedRows.map((a) => a.id);
  const onPick = (id: number) => (range: boolean) => {
    setPicked((p) => (p ? pick(order.map((a) => a.id), p, anchor, id, range) : [id]));
    setAnchor(id);
  };
  const rescore = (run: () => Promise<number>) => run().then((n) => setRescored(t("listPane.rescoreQueued", { n })), (e) => setRescored(t.msg(String(e))));
  const renderGroup = (g: Group<ArticleRow>, depth: number): React.ReactNode => (
    <div key={g.key} role="group" aria-label={g.label || undefined}>
      {g.label && <div className={`grp-h d${depth}`}><span className="label">{g.label}</span><span className="n">{g.articles.length}</span></div>}
      {g.children
        ? g.children.map((c) => renderGroup(c, depth + 1))
        : g.articles.map((a) => (
          <ArticleRowView key={a.id} a={a} sel={a.id === selectedId} cur={a.id === cursorId} sort={sort} onOpen={(t) => onOpen(a, t)} onCursor={() => onCursor(a.id)}
            translating={translating?.id === a.id ? translating.label : null} picked={picked ? picked.includes(a.id) : undefined} onPick={onPick(a.id)}
            onMenu={(e) => onRowMenu(picked?.includes(a.id) ? pickedRows : [a], e.currentTarget)} />
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
        <FacetBar facets={facets} onFacets={onFacets} scoped={scoped} all={all} groups={groupRows} />
        {picked ? (
          <div className="list-tools" role="toolbar" aria-label={t("listPane.picking")}>
            <span className="mono">{t("listPane.picked", { n: ids.length })}</span>
            <button className="btn sm" disabled={ids.length === 0} aria-haspopup="dialog" aria-expanded={!!picker}
              onClick={(e) => { const el = e.currentTarget; setPicker((p) => (p ? null : el)); }}>
              <Icon name="folder" size="sm" />{t("listPane.addToGroup")}
            </button>
            <button className="btn sm ghost push" onClick={() => { setPicked(null); setPicker(null); }}>{t("listPane.endPicking")}<ActionKey id="escape" /></button>
          </div>
        ) : (
          <div className="list-tools">
            <SortMenu sort={sort} onSort={onSort} group={group} onGroup={onGroup} />
            {onRescore && <button className="tb" onClick={() => rescore(onRescore)} disabled={count === 0} title={t("listPane.rescoreHint")}>{t("listPane.rescore")}</button>}
            {onRescore && rescored && <span className="muted" role="status">{rescored}</span>}
            {noProfile && sort === "relevance_desc" && <span className="muted">{t("listPane.noProfile")}</span>}
            <button className="tb" onClick={() => { setPicked([]); setAnchor(null); }} title={t("listPane.pickHint")}>{t("listPane.pick")}</button>
            <button className="clear" onClick={() => onFacets({ ...NO_FACETS, tagMode: facets.tagMode })} disabled={!hasFacets}>
              {t("listPane.clear")}<Kbd>Esc</Kbd>
            </button>
          </div>
        )}
        {picker && picked && (
          <GroupPicker groups={groupRows} anchor={picker} onClose={() => setPicker(null)} onCreate={onCreateGroup}
            selected={groupRows.filter((g) => pickedRows.length > 0 && pickedRows.every((a) => a.groups.includes(g.id))).map((g) => g.id)}
            onToggle={(g, on) => onGroupMembers(g, ids, on)} />
        )}
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

/** The closed list: one button that opens it again (j / k still move the cursor, H11). */
export function ListRail({ onOpen }: { onOpen: () => void }) {
  const t = useT();
  return (
    <section className="list-rail" aria-label={t("listPane.rail")} data-pane="list">
      <button className="ib" onClick={onOpen} aria-label={t("listPane.open")} title={t("listPane.open")}><Icon name="right" /></button>
    </section>
  );
}
