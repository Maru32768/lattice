import { useState } from "react";
import type { ArticleRow, GroupRow } from "../bindings";
import { useT } from "../i18n";
import { DIMS, DIM_LABELS, NO_FACETS, scopeLabel, toggle, valueLabel, type Dim, type Facets } from "../library/library";
import { SCOPES, options, type ListView } from "./list";
import { Sheet } from "./Sheet";

/** Values shown per dimension before 「ほかN件」: tags and feeds can run to hundreds. */
const FIRST_VALUES = 24;

/** The PC's filters in a sheet from the bottom, as NoodleMap's map does it. */
export function FilterSheet({
  open,
  onClose,
  view,
  onFacets,
  onScope,
  base,
  all,
  groups,
  count,
}: {
  open: boolean;
  onClose: () => void;
  view: ListView;
  onFacets: (f: Facets) => void;
  onScope: (s: ListView["scope"]) => void;
  /** What the counts are taken from: scope ∧ search. */
  base: ArticleRow[];
  all: ArticleRow[];
  groups: GroupRow[];
  /** How many articles the view lists. */
  count: number;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState<Dim[]>([]);
  /** What is typed in a dimension's search field: tags run to hundreds. */
  const [queries, setQueries] = useState<Partial<Record<Dim, string>>>({});
  const { facets } = view;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t("mobile.filter")}
      footer={
        <>
          <button className="btn" onClick={() => onFacets(NO_FACETS)} disabled={DIMS.every((d) => facets[d].length === 0)}>
            {t("mobile.clearFilters")}
          </button>
          <button className="btn pri" onClick={onClose}>
            {t("mobile.showN", { n: count })}
          </button>
        </>
      }
    >
      <section aria-labelledby="m-dim-scope">
        <h3 id="m-dim-scope">{t("mobile.scope")}</h3>
        <div className="m-chips">
          {SCOPES.map((s) => (
            <button key={s.kind} className="m-chip" aria-pressed={view.scope.kind === s.kind} onClick={() => onScope(s)}>
              {scopeLabel(s, all, groups, t)}
            </button>
          ))}
        </div>
      </section>
      {DIMS.map((dim) => {
        const opts = options(dim, base, all, facets);
        if (opts.length === 0) {
          return null;
        }
        const many = opts.length > FIRST_VALUES;
        const q = (queries[dim] ?? "").trim().toLowerCase();
        // As the PC's popover orders them: those that start with what is typed, then those that contain it. Chosen ones stay.
        const found = q
          ? opts
              .map((o) => ({ o, at: valueLabel(dim, o.v, all, groups, t).toLowerCase().indexOf(q) }))
              .filter(({ o, at }) => at >= 0 || (facets[dim] as unknown[]).includes(o.v))
              .sort((x, y) => Number(x.at !== 0) - Number(y.at !== 0))
              .map(({ o }) => o)
          : opts;
        const showAll = q !== "" || expanded.includes(dim);
        const shown = showAll ? found : found.slice(0, FIRST_VALUES);
        return (
          <section key={dim} aria-labelledby={`m-dim-${dim}`}>
            <h3 id={`m-dim-${dim}`}>{t(DIM_LABELS[dim])}</h3>
            {many && (
              <input
                className="input m-sheet-find"
                type="search"
                value={queries[dim] ?? ""}
                onChange={(e) => setQueries({ ...queries, [dim]: e.target.value })}
                placeholder={t("mobile.findIn", { label: t(DIM_LABELS[dim]) })}
                aria-label={t("facetPopover.filterBy", { label: t(DIM_LABELS[dim]) })}
              />
            )}
            {dim === "tags" && (
              <div className="seg" role="group" aria-label={t("facetPopover.tagMode")}>
                {(["all", "any"] as const).map((mode) => (
                  <button
                    key={mode}
                    className={facets.tagMode === mode ? "on" : ""}
                    aria-pressed={facets.tagMode === mode}
                    onClick={() => onFacets({ ...facets, tagMode: mode })}
                  >
                    {t(mode === "all" ? "facetPopover.all" : "facetPopover.any")}
                  </button>
                ))}
              </div>
            )}
            <div className="m-chips">
              {shown.map(({ v, count: n }) => (
                <button
                  key={String(v)}
                  className="m-chip"
                  aria-pressed={(facets[dim] as unknown[]).includes(v)}
                  onClick={() => onFacets(toggle(facets, dim, v))}
                >
                  {valueLabel(dim, v, all, groups, t)}
                  <span className="n">{n}</span>
                </button>
              ))}
              {!showAll && found.length > shown.length && (
                <button className="m-chip more" onClick={() => setExpanded([...expanded, dim])}>
                  {t("mobile.moreValues", { n: found.length - shown.length })}
                </button>
              )}
            </div>
          </section>
        );
      })}
    </Sheet>
  );
}
