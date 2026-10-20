import { useState } from "react";
import type { ArticleRow, ArticleSort } from "./api";
import { DIMS, DIM_LABELS, activeDims, facetBase, facetLabel, without, type Dim, type Facets, type Relaxation } from "./library";
import type { Group } from "./groups";
import { FacetPopover } from "./FacetPopover";
import { Menu } from "./Popover";
import { ActionKey, Dif, Icon, Kbd } from "./Icon";
import { Favicon } from "./Favicon";

export type Grouping = "none" | "feed" | "genre";

export const SORTS: [ArticleSort, string][] = [
  ["saved_desc", "追加日・新しい順"],
  ["saved_asc", "追加日・古い順"],
  ["published_desc", "公開日・新しい順"],
  ["difficulty_asc", "難易度・やさしい順"],
];
const GROUPINGS: [Grouping, string][] = [["none", "なし"], ["feed", "ソース"], ["genre", "ジャンル"]];

export const mmdd = (s: string) => {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s.slice(5, 10).replace("-", "/") : `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
};

/** A status badge only when something is abnormal. */
function badge(a: ArticleRow, translating: string | null): [string, string] | null {
  if (a.fetch_status === "pending") return ["run", "取得中"];
  if (a.fetch_status === "failed") return ["err", "取得失敗"];
  if (a.extraction_status === "failed") return ["err", "抽出失敗"];
  if (translating) return ["run", translating];
  if (a.thin) return ["warn", "本文が短い"];
  return null;
}

/** `sel`: the open article; `cur`: the keyboard cursor (j / k), opened with Enter. */
export function ArticleRowView({ a, sel, cur, sort, translating, onOpen, onCursor }: {
  a: ArticleRow; sel: boolean; cur: boolean; sort: ArticleSort; translating: string | null; onOpen: () => void; onCursor: () => void;
}) {
  const b = badge(a, translating);
  const unread = a.read_status === "unread";
  return (
    <button className={`row${sel ? " sel" : ""}${cur ? " cur" : ""}${unread ? "" : " read"}`} onClick={onOpen} onFocus={onCursor}
      aria-current={sel || undefined} data-id={a.id}>
      {unread && <span className="dot" aria-label="未読" />}
      <span className="t">{a.title ?? a.original_url}</span>
      <span className="meta">
        <span className="with-ico"><Favicon domain={a.domain} />{a.feed_title ?? a.site_name ?? a.domain}</span>
        <span>{mmdd((sort === "published_desc" && a.published_at) || a.saved_at)}</span>
        {a.difficulty != null && <Dif d={a.difficulty} />}
        {a.favorite && <span className="fav" aria-label="お気に入り"><Icon name="star" size="sm" /></span>}
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
  const [open, setOpen] = useState<{ dim: Dim; el: HTMLElement } | null>(null);
  const active = activeDims(facets);
  const toggleOpen = (dim: Dim) => (e: React.MouseEvent<HTMLElement>) => {
    const el = e.currentTarget.closest<HTMLElement>(".chip")!;
    setOpen((o) => (o?.dim === dim ? null : { dim, el }));
  };
  return (
    <div className="chips">
      {children}
      {active.map((d) => (
        <span key={d} className={`chip on${open?.dim === d ? " open" : ""}`}>
          <button className="chip-body" onClick={toggleOpen(d)} aria-haspopup="dialog" aria-expanded={open?.dim === d}>
            <span className="k">{DIM_LABELS[d]}</span>{facetLabel(facets, d, all)}
          </button>
          <button className="x" onClick={() => onFacets(without(facets, d))} aria-label={`${DIM_LABELS[d]}の絞り込みを解除`}><Icon name="x" size="sm" /></button>
        </span>
      ))}
      {dims.filter((d) => !active.includes(d)).map((d) => (
        <button key={d} className={`chip${d === "state" ? " dashed" : ""}${open?.dim === d ? " open" : ""}`} onClick={toggleOpen(d)}
          aria-haspopup="dialog" aria-expanded={open?.dim === d}>
          {DIM_LABELS[d]}{d !== "state" && <Icon name="down" size="sm" />}
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
  const label = SORTS.find(([s]) => s === sort)![1];
  return (
    <Menu className="tb sort" label="並び順とグループ" title="並び順とグループ"
      trigger={<><Icon name="sort" size="md" />{label}{group !== "none" && ` · ${GROUPINGS.find(([g]) => g === group)![1]}`}</>}
      items={[
        "並び順",
        ...SORTS.map(([s, l]) => ({ label: l, checked: s === sort, onSelect: () => onSort(s) })),
        "-",
        "グループ",
        ...GROUPINGS.map(([g, l]) => ({ label: l, checked: g === group, onSelect: () => onGroup(g) })),
      ]} />
  );
}

export function ListPane({ title, count, total, facets, onFacets, scoped, all, groups, sort, onSort, group, onGroup, selectedId, cursorId, onCursor,
  translating, relax, onRelax, onOpen, onCollapse }: {
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
  onOpen: (a: ArticleRow) => void;
  onCollapse: () => void;
}) {
  const hasFacets = activeDims(facets).length > 0;
  const renderGroup = (g: Group<ArticleRow>, depth: number): React.ReactNode => (
    <div key={g.key} role="group" aria-label={g.label || undefined}>
      {g.label && <div className={`grp-h d${depth}`}><span className="label">{g.label}</span><span className="n">{g.articles.length}</span></div>}
      {g.children
        ? g.children.map((c) => renderGroup(c, depth + 1))
        : g.articles.map((a) => (
          <ArticleRowView key={a.id} a={a} sel={a.id === selectedId} cur={a.id === cursorId} sort={sort} onOpen={() => onOpen(a)} onCursor={() => onCursor(a.id)}
            translating={translating?.id === a.id ? translating.label : null} />
        ))}
    </div>
  );
  return (
    <section className="list" aria-label="記事一覧" data-pane="list">
      <header className="list-h">
        <div className="list-title">
          <h1>{title}</h1>
          <span className="mono count">{count} / {total}</span>
          <button className="ib" onClick={onCollapse} aria-label="記事一覧を閉じる" title="記事一覧を閉じる"><Icon name="left" /></button>
        </div>
        <FacetBar facets={facets} onFacets={onFacets} scoped={scoped} all={all} />
        <div className="list-tools">
          <SortMenu sort={sort} onSort={onSort} group={group} onGroup={onGroup} />
          <button className="clear" onClick={() => onFacets({ ...facets, genres: [], tags: [], feeds: [], difficulty: [], state: [] })} disabled={!hasFacets}>
            クリア <Kbd>Esc</Kbd>
          </button>
        </div>
      </header>
      <div className="list-body">
        {count > 0 ? groups.map((g) => renderGroup(g, 0))
          : total > 0 || relax.length > 0 ? (
            <div className="empty">
              <div className="empty-h">この条件の記事はありません</div>
              {relax.length > 0 && <>
                <div className="muted">どれか 1 つを外すと:</div>
                <div className="btn-row">
                  {relax.map((r) => <button key={r.label} className="btn" onClick={() => onRelax(r)}>{r.label} → {r.count} 件</button>)}
                </div>
              </>}
            </div>
          ) : <div className="empty"><div className="muted">{all.length === 0 ? "記事はまだありません" : "この一覧に記事はありません"}</div></div>}
      </div>
      <footer className="list-f hints">
        <span><ActionKey id="next" /><ActionKey id="prev" /> 移動</span>
        <span><ActionKey id="open" /> 開く</span>
        <span><ActionKey id="favorite" /> お気に入り</span>
        <span><ActionKey id="read" /> 既読</span>
      </footer>
    </section>
  );
}

export function ListRail({ label, index, count, onOpen, onPrev, onNext }: {
  label: string; index: number; count: number; onOpen: () => void; onPrev: () => void; onNext: () => void;
}) {
  return (
    <section className="list-rail" aria-label="記事一覧（折りたたみ）" data-pane="list">
      <button className="ib" onClick={onOpen} aria-label="記事一覧を開く" title="記事一覧を開く"><Icon name="right" /></button>
      <button className="ib" onClick={onPrev} aria-label="前の記事へカーソル (k)" title="前の記事へカーソル (k)"><Icon name="up" /></button>
      <span className="vlabel mono">{index > 0 ? index : "–"} / {count} · {label}</span>
      <button className="ib" onClick={onNext} aria-label="次の記事へカーソル (j)" title="次の記事へカーソル (j)"><Icon name="down" /></button>
    </section>
  );
}
