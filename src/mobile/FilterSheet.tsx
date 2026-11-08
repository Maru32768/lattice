import { useEffect, useRef, useState } from "react";
import type { ArticleRow, GroupRow } from "../bindings";
import { useT } from "../i18n";
import { DIMS, DIM_LABELS, NO_FACETS, scopeLabel, toggle, valueLabel, type Dim, type Facets } from "../library/library";
import { SCOPES, options, type ListView } from "./list";

/** Values shown per dimension before 「ほかN件」: tags and feeds can run to hundreds. */
const FIRST_VALUES = 24;

/** The PC's filters in a sheet from the bottom, as NoodleMap's map does it. A modal `<dialog>`: the back gesture closes it. */
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
  const ref = useRef<HTMLDialogElement>(null);
  const [expanded, setExpanded] = useState<Dim[]>([]);
  useEffect(() => {
    const d = ref.current;
    if (open && d && !d.open) {
      d.showModal();
    } else if (!open && d?.open) {
      d.close();
    }
  }, [open]);
  const { facets } = view;
  return (
    <dialog ref={ref} className="m-sheet" aria-labelledby="m-sheet-title" onClose={onClose}>
      <header>
        <h2 id="m-sheet-title">{t("mobile.filter")}</h2>
        <button className="btn" onClick={onClose}>
          {t("common.close")}
        </button>
      </header>
      <div className="m-sheet-body">
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
          const showAll = expanded.includes(dim);
          const shown = showAll ? opts : opts.slice(0, FIRST_VALUES);
          return (
            <section key={dim} aria-labelledby={`m-dim-${dim}`}>
              <h3 id={`m-dim-${dim}`}>{t(DIM_LABELS[dim])}</h3>
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
                {!showAll && opts.length > shown.length && (
                  <button className="m-chip more" onClick={() => setExpanded([...expanded, dim])}>
                    {t("mobile.moreValues", { n: opts.length - shown.length })}
                  </button>
                )}
              </div>
            </section>
          );
        })}
      </div>
      <footer>
        <button className="btn" onClick={() => onFacets(NO_FACETS)} disabled={DIMS.every((d) => facets[d].length === 0)}>
          {t("mobile.clearFilters")}
        </button>
        <button className="btn pri" onClick={onClose}>
          {t("mobile.showN", { n: count })}
        </button>
      </footer>
    </dialog>
  );
}
