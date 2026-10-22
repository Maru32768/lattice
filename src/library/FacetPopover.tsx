import { useMemo, useState } from "react";
import type { ArticleRow, GroupRow } from "../api";
import { DIM_LABELS, DIFFICULTY_LABELS, RELEVANCE_LABELS, countBy, toggle, valueLabel, type Dim, type DimValue, type Facets } from "./library";
import { Popover } from "../ui/Popover";
import { ActionKey, Icon, Kbd } from "../ui/Icon";
import { listStep } from "../lib/keys";
import { useT } from "../i18n";

type Opt = { v: DimValue<Dim>; label: string; count: number };

const STATE_ORDER = ["unread", "read", "favorite", "issue"] as const;

/** Every value a dimension can take in the library (tags/genres/feeds from the articles themselves). */
function universe(dim: Dim, all: ArticleRow[]): DimValue<Dim>[] {
  if (dim === "state") return [...STATE_ORDER];
  if (dim === "difficulty") return [...DIFFICULTY_LABELS.map((_, i) => i + 1), null];
  if (dim === "relevance") return [...RELEVANCE_LABELS.map((_, i) => 5 - i), null];
  return [...countBy(all, dim).keys()];
}

function Marked({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

/** Facet picker for one dimension; tags get search, AND/OR and the in-set / out-of-set split (Filter board). */
export function FacetPopover({ dim, facets, onFacets, base, all, groups, anchor, onClose }: {
  dim: Dim;
  facets: Facets;
  onFacets: (f: Facets) => void;
  /** The rows counts are taken from (library.facetBase). */
  base: ArticleRow[];
  all: ArticleRow[];
  groups: GroupRow[];
  anchor: HTMLElement;
  onClose: () => void;
}) {
  const t = useT();
  const [q, setQ] = useState("");
  const [act, setAct] = useState(0);
  const [more, setMore] = useState(false);
  const isTags = dim === "tags";
  const selected = facets[dim] as DimValue<Dim>[];
  const counts = useMemo(() => countBy(base, dim), [base, dim]);
  const opts: Opt[] = useMemo(() => universe(dim, all).map((v) => ({ v, label: valueLabel(dim, v, all, groups, t), count: counts.get(v) ?? 0 })), [dim, all, groups, counts, t]);

  // Tags: popular (no query), or matches split into in-set (prefix first) and out-of-set.
  const sections = useMemo(() => {
    if (!isTags) {
      const sorted = dim === "state" || dim === "difficulty" || dim === "relevance" ? opts : [...opts].sort((a, b) => b.count - a.count);
      return [{ title: "", note: t("facetPopover.count"), opts: sorted }];
    }
    const unselected = opts.filter((o) => !selected.includes(o.v));
    const ql = q.trim().toLowerCase();
    if (!ql) return [{ title: t("facetPopover.popular"), note: t("facetPopover.count"), opts: unselected.filter((o) => o.count > 0).sort((a, b) => b.count - a.count).slice(0, 8) }];
    const hit = unselected.filter((o) => o.label.toLowerCase().includes(ql));
    const rank = (o: Opt) => (o.label.toLowerCase().startsWith(ql) ? 0 : 1);
    const inSet = hit.filter((o) => o.count > 0).sort((a, b) => rank(a) - rank(b) || b.count - a.count);
    const outSet = hit.filter((o) => o.count === 0).sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
    return [
      { title: t("facetPopover.inSet"), note: t("facetPopover.matchOrder"), opts: inSet },
      { title: t("facetPopover.outSet"), note: String(outSet.length), opts: more ? outSet : outSet.slice(0, 2), hidden: more ? 0 : Math.max(0, outSet.length - 2) },
    ];
  }, [isTags, opts, selected, q, more, dim, t]);
  const flat = sections.flatMap((s) => s.opts);
  const matchCount = isTags && q.trim() ? sections.reduce((n, s) => n + s.opts.length + (s.hidden ?? 0), 0) : 0;
  const active = flat[Math.min(act, flat.length - 1)];

  const pick = (v: DimValue<Dim>) => onFacets(toggle(facets, dim, v));

  function keys(e: React.KeyboardEvent) {
    const k = e.key;
    const d = listStep(e, (e.target as HTMLElement).tagName === "INPUT");
    if (d) {
      e.preventDefault();
      setAct((i) => Math.max(0, Math.min(flat.length - 1, i + d)));
    } else if (k === " " && active) {
      e.preventDefault();
      pick(active.v);
    } else if (k === "Enter") {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) return onClose();
      if (active) pick(active.v);
      setQ("");
      setAct(0);
    } else if (k === "Tab" && isTags && q && active) {
      e.preventDefault();
      setQ(active.label);
    } else if (k === "Backspace" && !q && selected.length > 0) {
      e.preventDefault();
      pick(selected[selected.length - 1]);
    }
  }

  const max = Math.max(1, base.length);
  const option = (o: Opt, i: number) => {
    const on = selected.includes(o.v);
    return (
      <button key={String(o.v)} className={`opt${flat[act] === o ? " act" : ""}${o.count === 0 ? " zero" : ""}${isTags ? " mono" : ""}`}
        aria-pressed={on} onClick={() => pick(o.v)} onMouseMove={() => setAct(i)}>
        <span className={`cb${on ? " on" : ""}`} aria-hidden="true">{on && "✓"}</span>
        <span className="opt-l"><Marked text={o.label} q={q.trim()} /></span>
        <span className="c">{o.count}</span>
        <span className="bar" aria-hidden="true">{o.count > 0 && <b style={{ width: `${Math.round((o.count / max) * 100)}%` }} />}</span>
      </button>
    );
  };

  /** Each section's first option in `flat`. */
  const starts = [0];
  for (const s of sections) starts.push(starts[starts.length - 1] + s.opts.length);
  return (
    <Popover anchor={anchor} label={t("facetPopover.filterBy", { label: t(DIM_LABELS[dim]) })} width={isTags ? 372 : 300} onClose={onClose}>
      <div onKeyDown={keys} className="facet-pv" tabIndex={isTags ? undefined : -1} data-autofocus={isTags ? undefined : true}>
        {isTags && (
          <div className="pv-head">
            <label className="pv-search">
              <Icon name="search" />
              <span className="vh">{t("facetPopover.searchTags")}</span>
              <input value={q} onChange={(e) => { setQ(e.target.value); setAct(0); setMore(false); }}
                placeholder={t("facetPopover.searchPlaceholder", { n: opts.length })} />
              {q.trim() && <span className="pv-count">{t("facetPopover.matches", { matchCount })}</span>}
            </label>
            {!q.trim() && (
              <div className="pv-mode">
                <div className="seg sm" role="group" aria-label={t("facetPopover.tagMode")}>
                  <button className={facets.tagMode === "all" ? "on" : ""} aria-pressed={facets.tagMode === "all"} onClick={() => onFacets({ ...facets, tagMode: "all" })}>{t("facetPopover.all")}</button>
                  <button className={facets.tagMode === "any" ? "on" : ""} aria-pressed={facets.tagMode === "any"} onClick={() => onFacets({ ...facets, tagMode: "any" })}>{t("facetPopover.any")}</button>
                </div>
                <span className="pv-note">{t("facetPopover.countNote")}</span>
              </div>
            )}
          </div>
        )}
        {isTags && selected.length > 0 && !q.trim() && (
          <>
            <div className="ph">{t("facetPopover.selected")}<span>{selected.length}</span></div>
            <div className="pv-chips">
              {(selected as string[]).map((tag) => (
                <button key={tag} className="chip on mono" onClick={() => pick(tag)} aria-label={t("facetPopover.unselect", { tag })}>{tag}<Icon name="x" size="sm" /></button>
              ))}
            </div>
          </>
        )}
        <div className="pv-list">
          {sections.map((s, si) => (
            <div key={s.title} role="group" aria-label={s.title || t(DIM_LABELS[dim])}>
              {s.title && <div className="ph">{s.title}<span>{s.note}</span></div>}
              {s.opts.map((o, oi) => option(o, starts[si] + oi))}
              {"hidden" in s && s.hidden! > 0 && <button className="opt zero more" onClick={() => setMore(true)}>{t("facetPopover.showMore", { hidden: s.hidden! })}</button>}
              {s.opts.length === 0 && <div className="pv-empty">{t("facetPopover.none")}</div>}
            </div>
          ))}
        </div>
        <div className="pv-foot hints">
          {isTags && q.trim()
            ? <><span><Kbd>Enter</Kbd>{t("facetPopover.hintAdd")}</span><span><Kbd>Tab</Kbd>{t("facetPopover.hintComplete")}</span><span className="r"><Kbd>Ctrl</Kbd><Kbd>Enter</Kbd>{t("common.hintApply")}</span></>
            : <><span>{!isTags && <><ActionKey id="next" /><ActionKey id="prev" /> </>}<Kbd>↑</Kbd><Kbd>↓</Kbd>{t("common.hintMove")}</span><span><Kbd>Space</Kbd>{t("facetPopover.hintToggle")}</span>{isTags && <span><Kbd>⌫</Kbd>{t("facetPopover.hintRemoveLast")}</span>}<span className="r"><Kbd>Esc</Kbd></span></>}
        </div>
      </div>
    </Popover>
  );
}
