import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { siteOf, type ArticleRow, type ArticleSort, type GroupRow } from "../api";
import { DIMS, DIM_LABELS, NO_FACETS, activeDims, facetBase, facetLabel, without, type Dim, type Facets, type Relaxation } from "./library";
import { flatten, type Group } from "./groups";
import { pick } from "./selection";
import { FacetPopover } from "./FacetPopover";
import { GroupPicker } from "./GroupPicker";
import { Menu, openOverlays } from "../ui/Popover";
import { actionFor, getBindings } from "../lib/keys";
import { keyOf } from "../lib/keyname";
import { ActionKey, Dif, Icon, Kbd } from "../ui/Icon";
import { Favicon } from "../ui/Favicon";
import { onMiddle } from "../lib/middle";
import { paneOf } from "../layout/panes";
import { useT, type PlainKey, type T } from "../i18n";

export type Grouping = "none" | "feed" | "genre";

export const SORTS: [ArticleSort, PlainKey][] = [
  ["saved_desc", "listPane.savedDesc"],
  ["saved_asc", "listPane.savedAsc"],
  ["published_desc", "listPane.publishedDesc"],
  ["difficulty_asc", "listPane.difficultyAsc"],
  ["relevance_desc", "listPane.relevanceDesc"],
];
const GROUPINGS: [Grouping, PlainKey][] = [
  ["none", "common.none"],
  ["feed", "common.source"],
  ["genre", "common.genre"],
];

/** A list line: a group heading or an article row; the virtualized list draws only those in view. */
type Item = { kind: "head"; g: Group<ArticleRow>; depth: number; key: string } | { kind: "row"; a: ArticleRow };

/**
 * The heights of `.row` and `.grp-h` in App.css, given to Virtuoso as `heightEstimates`. It takes an item not yet drawn
 * to be as tall as its estimate and corrects it once drawn: with estimates off, the scrollbar drifted from the mouse
 * while dragged (Chrome does not move the thumb as the content grows) and scrolling up shifted the rows. No
 * `defaultItemHeight` beside them: it seeds the sizes first, and Virtuoso then ignores the estimates.
 */
const ROW_H = 104;
const HEAD_H = 27;

/** A heading's key is its path: the same genre recurs under each feed. */
function itemsOf(groups: Group<ArticleRow>[], depth = 0, path = "", out: Item[] = []): Item[] {
  for (const g of groups) {
    const key = `${path}/${g.key}`;
    if (g.label) {
      out.push({ kind: "head", g, depth, key });
    }
    if (g.children) {
      itemsOf(g.children, depth + 1, key, out);
    } else {
      for (const a of g.articles) {
        out.push({ kind: "row", a });
      }
    }
  }
  return out;
}

export const mmdd = (s: string) => {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s.slice(5, 10).replace("-", "/") : `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
};

/** A status badge only when something is abnormal. */
function badge(a: ArticleRow, translating: string | null, t: T): [string, string] | null {
  if (a.fetch_status === "pending") {
    return ["run", t("listPane.fetching")];
  }
  if (a.fetch_status === "failed") {
    return ["err", t("listPane.fetchFailed")];
  }
  if (a.extraction_status === "failed") {
    return ["err", t("listPane.extractFailed")];
  }
  if (translating) {
    return ["run", translating];
  }
  if (a.thin) {
    return ["warn", t("listPane.thin")];
  }
  return null;
}

/** Only important articles (4-5) get a mark; the reason is its tooltip. */
function Importance({ a }: { a: ArticleRow }) {
  const t = useT();
  if (a.relevance == null || a.relevance < 4) {
    return null;
  }
  return (
    <span className={`imp s${a.relevance}`} title={a.relevance_reason ?? undefined}>
      {t("listPane.importance", { score: a.relevance })}
    </span>
  );
}

/**
 * `sel`: the open article; `cur`: the keyboard cursor (j / k), opened with Enter. `picked` is set
 * while rows are picked for a bulk action: a click then picks instead of opening (Shift+click
 * starts picking).
 */
export function ArticleRowView({
  a,
  sel,
  cur,
  sort,
  translating,
  picked,
  onOpen,
  onPick,
  onCursor,
  onMenu,
}: {
  a: ArticleRow;
  sel: boolean;
  cur: boolean;
  sort: ArticleSort;
  translating: string | null;
  picked?: boolean;
  onOpen: (newTab: boolean) => void;
  onPick?: (range: boolean) => void;
  onCursor: () => void;
  onMenu?: (e: React.MouseEvent<HTMLElement>) => void;
}) {
  const t = useT();
  const b = badge(a, translating, t);
  const unread = a.read_status === "unread";
  return (
    <button
      className={`row${sel ? " sel" : ""}${cur ? " cur" : ""}${unread ? "" : " read"}${picked !== undefined ? " picking" : ""}`}
      onClick={(e) => (onPick && (picked !== undefined || e.shiftKey) ? onPick(e.shiftKey) : onOpen(e.ctrlKey || e.metaKey))}
      {...onMiddle(() => onOpen(true))}
      onFocus={onCursor}
      onContextMenu={onMenu}
      aria-current={sel || undefined}
      aria-pressed={picked}
      data-id={a.id}
    >
      {picked !== undefined && (
        <span className={`cb${picked ? " on" : ""}`} aria-hidden="true">
          {picked && "✓"}
        </span>
      )}
      {unread && <span className="dot" aria-label={t("common.unread")} />}
      <span className="t">{a.title ?? a.original_url}</span>
      <span className="meta">
        <span className="with-ico">
          <Favicon domain={a.domain} feed={a.feed_id} />
          {a.feed_title ?? a.site_name ?? siteOf(a, t)}
        </span>
        <span>{mmdd((sort === "published_desc" && a.published_at) || a.saved_at)}</span>
        {a.difficulty != null && <Dif d={a.difficulty} />}
        <Importance a={a} />
        {a.favorite && (
          <span className="fav" aria-label={t("common.favorites")}>
            <Icon name="star" size="sm" />
          </span>
        )}
        {b && <span className={`bd ${b[0]}`}>{b[1]}</span>}
      </span>
      {a.tags.length > 0 && <span className="tags">{a.tags.join(" · ")}</span>}
    </button>
  );
}

/** Active facets as removable chips, inactive dimensions as popover openers. */
export function FacetBar({
  facets,
  onFacets,
  scoped,
  all,
  groups,
  dims: shownDims,
  children,
}: {
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
  const dims = (shownDims ?? DIMS).filter((d) => groups.length > 0 || d !== "groups");
  const [open, setOpen] = useState<{ dim: Dim; el: HTMLElement } | null>(null);
  const active = activeDims(facets);
  const toggleOpen = (dim: Dim) => (e: React.MouseEvent<HTMLElement>) => {
    const el = e.currentTarget.closest<HTMLElement>(".chip")!;
    setOpen((o) => (o?.dim === dim ? null : { dim, el }));
  };
  // Picking a dimension's first value replaces its chip (button → active chip). The open popover
  // follows the dimension to the new chip, so it still toggles from it and returns focus to it.
  const chipRef = (dim: Dim) => (el: HTMLElement | null) => {
    if (el && open?.dim === dim && open.el !== el) {
      setOpen({ dim, el });
    }
  };
  return (
    <div className="chips">
      {children}
      {active.map((d) => (
        <span key={d} ref={chipRef(d)} className={`chip on${open?.dim === d ? " open" : ""}`}>
          <button className="chip-body" onClick={toggleOpen(d)} aria-haspopup="dialog" aria-expanded={open?.dim === d}>
            <span className="k">{t(DIM_LABELS[d])}</span>
            {facetLabel(facets, d, all, groups, t)}
          </button>
          <button className="x" onClick={() => onFacets(without(facets, d))} aria-label={t("listPane.clearFacet", { label: t(DIM_LABELS[d]) })}>
            <Icon name="x" size="sm" />
          </button>
        </span>
      ))}
      {dims
        .filter((d) => !active.includes(d))
        .map((d) => (
          <button
            key={d}
            ref={chipRef(d)}
            className={`chip${d === "state" ? " dashed" : ""}${open?.dim === d ? " open" : ""}`}
            onClick={toggleOpen(d)}
            aria-haspopup="dialog"
            aria-expanded={open?.dim === d}
          >
            {t(DIM_LABELS[d])}
            {d !== "state" && <Icon name="down" size="sm" />}
          </button>
        ))}
      {open && (
        <FacetPopover
          dim={open.dim}
          facets={facets}
          onFacets={onFacets}
          base={facetBase(scoped, facets, open.dim)}
          all={all}
          groups={groups}
          anchor={open.el}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

export function SortMenu({
  sort,
  onSort,
  group,
  onGroup,
}: {
  sort: ArticleSort;
  onSort: (s: ArticleSort) => void;
  group: Grouping;
  onGroup: (g: Grouping) => void;
}) {
  const t = useT();
  const label = t(SORTS.find(([s]) => s === sort)![1]);
  return (
    <Menu
      className="tb sort"
      label={t("listPane.sortGroup")}
      title={t("listPane.sortGroup")}
      trigger={
        <>
          <Icon name="sort" size="md" />
          {label}
          {group !== "none" && ` · ${t(GROUPINGS.find(([g]) => g === group)![1])}`}
        </>
      }
      items={[
        t("listPane.sort"),
        ...SORTS.map(([s, l]) => ({ label: t(l), checked: s === sort, onSelect: () => onSort(s) })),
        "-",
        t("listPane.group"),
        ...GROUPINGS.map(([g, l]) => ({ label: t(l), checked: g === group, onSelect: () => onGroup(g) })),
      ]}
    />
  );
}

export function ListPane({
  title,
  count,
  total,
  facets,
  onFacets,
  scoped,
  all,
  groups,
  groupRows,
  sort,
  onSort,
  group,
  onGroup,
  selectedId,
  cursorId,
  onCursor,
  translating,
  relax,
  onRelax,
  onOpen,
  onGroupMembers,
  onCreateGroup,
  onRowMenu,
  onCollapse,
  onRescore,
  noProfile,
}: {
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
  /** The label of an article being translated or waiting to be; none once it is done. */
  translating: (id: number) => string | undefined;
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
  // Nothing in scope and no filter to clear: the filters, sort and Select would act on nothing.
  const idle = total === 0 && !hasFacets;
  /** Rows picked for a bulk action; null while not picking. */
  const [picked, setPicked] = useState<number[] | null>(null);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [picker, setPicker] = useState<HTMLElement | null>(null);
  // Another list (its title) ends picking.
  const [prevTitle, setPrevTitle] = useState(title);
  if (prevTitle !== title) {
    setPrevTitle(title);
    setPicked(null);
    setPicker(null);
  }
  // Esc ends picking before it clears the filters (the shell's Esc); an open popover closes first.
  const picking = picked != null;
  useEffect(() => {
    if (!picking) {
      return;
    }
    const esc = (e: KeyboardEvent) => {
      const key = keyOf(e);
      if (e.defaultPrevented || !key || actionFor(getBindings(), key)?.id !== "escape" || openOverlays()) {
        return;
      }
      if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable='true']")) {
        return;
      }
      e.preventDefault();
      setPicked(null);
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [picking]);
  const order = flatten(groups);
  const pickedSet = picked && new Set(picked);
  const pickedRows = order.filter((a) => pickedSet?.has(a.id));
  const ids = pickedRows.map((a) => a.id);
  const onPick = (id: number) => (range: boolean) => {
    setPicked((p) =>
      p
        ? pick(
            order.map((a) => a.id),
            p,
            anchor,
            id,
            range,
          )
        : [id],
    );
    setAnchor(id);
  };
  const rescore = (run: () => Promise<number>) =>
    run().then(
      (n) => setRescored(t("listPane.rescoreQueued", { n })),
      (e: unknown) => setRescored(t.msg(String(e))),
    );
  // Libraries run to thousands of articles: only the rows in view are mounted, so j / k re-renders a screenful.
  const items = itemsOf(groups);
  const virtuoso = useRef<VirtuosoHandle>(null);
  const body = useRef<HTMLElement | Window | null>(null);
  // The cursor's row may be out of view and so not mounted: scroll to it, then focus it as the shell's revealCursor would.
  const revealCursor = useEffectEvent(() => {
    const index = items.findIndex((it) => it.kind === "row" && it.a.id === cursorId);
    // A click focused the row (onFocus moved the cursor): it is in view. Virtuoso, not yet caught up with the scroll that
    // brought it there, would scroll again and move another row under the mouse before mouseup, losing the click.
    const focused = document.activeElement;
    if (index < 0 || (focused instanceof HTMLElement && focused.matches(".row") && focused.dataset.id === String(cursorId))) {
      return;
    }
    virtuoso.current?.scrollIntoView({
      index,
      done: () =>
        requestAnimationFrame(() => {
          const el = body.current instanceof HTMLElement ? body.current.querySelector<HTMLElement>(".row.cur") : null;
          if (el && paneOf(document.activeElement)?.dataset.pane === "list" && document.activeElement !== el) {
            el.focus({ preventScroll: true });
          }
        }),
    });
  });
  // oxlint-disable-next-line react/exhaustive-effect-dependencies -- once per cursor move, not per list reload
  useEffect(() => revealCursor(), [cursorId]);
  const renderItem = (_: number, it: Item) =>
    it.kind === "head" ? (
      <div className={`grp-h d${it.depth}`}>
        <span className="label">{it.g.label}</span>
        <span className="n">{it.g.articles.length}</span>
      </div>
    ) : (
      <ArticleRowView
        a={it.a}
        sel={it.a.id === selectedId}
        cur={it.a.id === cursorId}
        sort={sort}
        onOpen={(t) => onOpen(it.a, t)}
        onCursor={() => onCursor(it.a.id)}
        translating={translating(it.a.id) ?? null}
        picked={pickedSet ? pickedSet.has(it.a.id) : undefined}
        onPick={onPick(it.a.id)}
        onMenu={(e) => onRowMenu(pickedSet?.has(it.a.id) ? pickedRows : [it.a], e.currentTarget)}
      />
    );
  return (
    <section className="list" aria-label={t("listPane.articles")} data-pane="list">
      <header className="list-h">
        <div className="list-title">
          <h1>{title}</h1>
          <span className="mono count">
            {count} / {total}
          </span>
          <button className="ib" onClick={onCollapse} aria-label={t("listPane.close")} title={t("listPane.close")}>
            <Icon name="left" />
          </button>
        </div>
        {!idle && <FacetBar facets={facets} onFacets={onFacets} scoped={scoped} all={all} groups={groupRows} />}
        {idle ? null : picked ? (
          <div className="list-tools" role="toolbar" aria-label={t("listPane.picking")}>
            <span className="mono">{t("listPane.picked", { n: ids.length })}</span>
            <button
              className="btn sm"
              disabled={ids.length === 0}
              aria-haspopup="dialog"
              aria-expanded={!!picker}
              onClick={(e) => {
                const el = e.currentTarget;
                setPicker((p) => (p ? null : el));
              }}
            >
              <Icon name="folder" size="sm" />
              {t("listPane.addToGroup")}
            </button>
            <button
              className="btn sm ghost push"
              onClick={() => {
                setPicked(null);
                setPicker(null);
              }}
            >
              {t("listPane.endPicking")}
              <ActionKey id="escape" />
            </button>
          </div>
        ) : (
          <div className="list-tools">
            <SortMenu sort={sort} onSort={onSort} group={group} onGroup={onGroup} />
            {onRescore && (
              <button className="tb" onClick={() => rescore(onRescore)} disabled={count === 0} title={t("listPane.rescoreHint")}>
                {t("listPane.rescore")}
              </button>
            )}
            {onRescore && rescored && (
              <span className="muted list-note" role="status" title={rescored}>
                {rescored}
              </span>
            )}
            {noProfile && sort === "relevance_desc" && (
              <span className="muted list-note" title={t("listPane.noProfile")}>
                {t("listPane.noProfile")}
              </span>
            )}
            <button
              className="tb"
              onClick={() => {
                setPicked([]);
                setAnchor(null);
              }}
              title={t("listPane.pickHint")}
            >
              {t("listPane.pick")}
            </button>
            <button className="clear" onClick={() => onFacets({ ...NO_FACETS, tagMode: facets.tagMode })} disabled={!hasFacets}>
              {t("listPane.clear")}
              <Kbd>Esc</Kbd>
            </button>
          </div>
        )}
        {picker && picked && (
          <GroupPicker
            groups={groupRows}
            anchor={picker}
            onClose={() => setPicker(null)}
            onCreate={onCreateGroup}
            selected={groupRows.filter((g) => pickedRows.length > 0 && pickedRows.every((a) => a.groups.includes(g.id))).map((g) => g.id)}
            onToggle={(g, on) => onGroupMembers(g, ids, on)}
          />
        )}
      </header>
      {count > 0 ? (
        <Virtuoso
          // The estimates apply only to a new list: another list or grouping starts afresh rather than keep headings' heights by index.
          key={`${title}|${group}`}
          ref={virtuoso}
          scrollerRef={(el) => {
            body.current = el;
          }}
          className="list-body"
          data={items}
          computeItemKey={(_, it) => (it.kind === "head" ? it.key : it.a.id)}
          itemContent={renderItem}
          heightEstimates={items.map((it) => (it.kind === "head" ? HEAD_H : ROW_H))}
          increaseViewportBy={400}
        />
      ) : (
        <div className="list-body">
          {total > 0 || relax.length > 0 ? (
            <div className="empty">
              <div className="empty-h">{t("listPane.noMatch")}</div>
              {relax.length > 0 && (
                <>
                  <div className="muted">{t("listPane.relaxHint")}</div>
                  <div className="btn-row">
                    {relax.map((r) => (
                      <button key={r.label} className="btn" onClick={() => onRelax(r)}>
                        {t("listPane.relaxation", { label: r.label, count: r.count })}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="empty">
              <div className="muted">{all.length === 0 ? t("listPane.empty") : t("listPane.emptyList")}</div>
            </div>
          )}
        </div>
      )}
      <footer className="list-f hints">
        <span>
          <ActionKey id="next" />
          <ActionKey id="prev" />
          {t("common.hintMove")}
        </span>
        <span>
          <ActionKey id="open" />
          {t("common.hintOpen")}
        </span>
        <span>
          <ActionKey id="favorite" />
          {t("listPane.hintFavorite")}
        </span>
        <span>
          <ActionKey id="read" />
          {t("listPane.hintRead")}
        </span>
      </footer>
    </section>
  );
}

/** The closed list: one button that opens it again (j / k still move the cursor, H11). */
export function ListRail({ onOpen }: { onOpen: () => void }) {
  const t = useT();
  return (
    <section className="list-rail" aria-label={t("listPane.rail")} data-pane="list">
      <button className="ib" onClick={onOpen} aria-label={t("listPane.open")} title={t("listPane.open")}>
        <Icon name="right" />
      </button>
    </section>
  );
}
