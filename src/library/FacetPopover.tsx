import { useMemo, useState } from "react";
import type { ArticleRow, GroupRow } from "../api";
import { DIM_LABELS, countBy, tagSections, toggle, universe, valueLabel, type Dim, type DimValue, type Facets } from "./library";
import { Popover } from "../ui/Popover";
import { PickList } from "../ui/PickList";
import type { PickOption } from "../ui/pickRows";
import { ActionKey, Icon, Kbd } from "../ui/Icon";
import { listStep } from "../lib/keys";
import { useT } from "../i18n";

interface Props {
  dim: Dim;
  facets: Facets;
  onFacets: (f: Facets) => void;
  /** The rows counts are taken from (library.facetBase). */
  base: ArticleRow[];
  all: ArticleRow[];
  groups: GroupRow[];
  anchor: HTMLElement;
  onClose: () => void;
}

/** Facet picker for one dimension; tags get a search over every tag, AND/OR and the in-set / out-of-set split (Filter board). */
export function FacetPopover(props: Props) {
  return props.dim === "tags" ? <TagFilter {...props} /> : <DimFilter {...props} />;
}

function TagFilter({ facets, onFacets, base, all, anchor, onClose }: Props) {
  const t = useT();
  const [q, setQ] = useState("");
  const querying = q.trim() !== "";
  const selected = facets.tags;
  const tags = useMemo(() => [...countBy(all, "tags").keys()], [all]);
  const counts = useMemo(() => countBy(base, "tags"), [base]);
  const pick = (tag: string) => onFacets(toggle(facets, "tags", tag));

  function keys(e: React.KeyboardEvent, active: PickOption | null) {
    if (e.key === " " && active) {
      e.preventDefault();
      pick(active.key);
    } else if (e.key === "Enter") {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        return onClose();
      }
      // The list then picks the highlighted tag.
      setQ("");
    } else if (e.key === "Tab" && q && active) {
      e.preventDefault();
      setQ(active.label);
    } else if (e.key === "Backspace" && !q && selected.length > 0) {
      e.preventDefault();
      pick(selected.at(-1)!);
    }
  }

  return (
    <Popover anchor={anchor} label={t("facetPopover.filterBy", { label: t(DIM_LABELS.tags) })} width={372} onClose={onClose}>
      <PickList
        label={t(DIM_LABELS.tags)}
        search={t("facetPopover.searchTags")}
        placeholder={t("facetPopover.searchPlaceholder", { n: tags.length })}
        query={q}
        onQuery={setQ}
        arrange={(query) => tagSections(tags, counts, query, t)}
        selected={selected}
        counts={{ of: counts, whole: base.length }}
        onPick={(o) => pick(o.key)}
        onKey={keys}
        matches
        mono
        head={
          !querying && (
            <div className="pv-mode">
              <div className="seg sm" role="group" aria-label={t("facetPopover.tagMode")}>
                <button
                  className={facets.tagMode === "all" ? "on" : ""}
                  aria-pressed={facets.tagMode === "all"}
                  onClick={() => onFacets({ ...facets, tagMode: "all" })}
                >
                  {t("facetPopover.all")}
                </button>
                <button
                  className={facets.tagMode === "any" ? "on" : ""}
                  aria-pressed={facets.tagMode === "any"}
                  onClick={() => onFacets({ ...facets, tagMode: "any" })}
                >
                  {t("facetPopover.any")}
                </button>
              </div>
              <span className="pv-note">{t("facetPopover.countNote")}</span>
            </div>
          )
        }
      >
        {/* Under the list: above it, the first pick and every new line of chips would move the rows under the pointer. */}
        {!querying && selected.length > 0 && (
          <>
            <div className="ph">
              {t("facetPopover.selected")}
              <span>{selected.length}</span>
            </div>
            <div className="pv-chips">
              {selected.map((tag) => (
                <button key={tag} className="chip on mono" onClick={() => pick(tag)} aria-label={t("facetPopover.unselect", { tag })}>
                  {tag}
                  <Icon name="x" size="sm" />
                </button>
              ))}
            </div>
          </>
        )}
        <div className="pv-foot hints">
          {querying ? (
            <>
              <span>
                <Kbd>Enter</Kbd>
                {t("facetPopover.hintAdd")}
              </span>
              <span>
                <Kbd>Tab</Kbd>
                {t("facetPopover.hintComplete")}
              </span>
              <span className="r">
                <Kbd>Ctrl</Kbd>
                <Kbd>Enter</Kbd>
                {t("common.hintApply")}
              </span>
            </>
          ) : (
            <>
              <span>
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd>
                {t("common.hintMove")}
              </span>
              <span>
                <Kbd>Space</Kbd>
                {t("facetPopover.hintToggle")}
              </span>
              <span>
                <Kbd>⌫</Kbd>
                {t("facetPopover.hintRemoveLast")}
              </span>
              <span className="r">
                <Kbd>Esc</Kbd>
              </span>
            </>
          )}
        </div>
      </PickList>
    </Popover>
  );
}

type Opt = { v: DimValue<Dim>; label: string; count: number };

/** A dimension with a few values and no search. */
function DimFilter({ dim, facets, onFacets, base, all, groups, anchor, onClose }: Props) {
  const t = useT();
  const [act, setAct] = useState(0);
  const selected = facets[dim] as DimValue<Dim>[];
  const counts = useMemo(() => countBy(base, dim), [base, dim]);
  const opts: Opt[] = useMemo(() => {
    const values = universe(dim, all).map((v) => ({ v, label: valueLabel(dim, v, all, groups, t), count: counts.get(v) ?? 0 }));
    return dim === "state" || dim === "difficulty" || dim === "relevance" ? values : values.sort((a, b) => b.count - a.count);
  }, [dim, all, groups, counts, t]);
  const active = opts[Math.min(act, opts.length - 1)];

  const pick = (v: DimValue<Dim>) => onFacets(toggle(facets, dim, v));

  function keys(e: React.KeyboardEvent) {
    const k = e.key;
    const d = listStep(e, false);
    if (d) {
      e.preventDefault();
      setAct((i) => Math.max(0, Math.min(opts.length - 1, i + d)));
    } else if (k === " " && active) {
      e.preventDefault();
      pick(active.v);
    } else if (k === "Enter") {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        return onClose();
      }
      if (active) {
        pick(active.v);
      }
      setAct(0);
    } else if (k === "Backspace" && selected.length > 0) {
      e.preventDefault();
      pick(selected.at(-1)!);
    }
  }

  const max = Math.max(1, base.length);
  return (
    <Popover anchor={anchor} label={t("facetPopover.filterBy", { label: t(DIM_LABELS[dim]) })} width={300} onClose={onClose}>
      <div onKeyDown={keys} className="facet-pv" tabIndex={-1} data-autofocus>
        <div className="pv-list">
          <div role="group" aria-label={t(DIM_LABELS[dim])}>
            {opts.map((o, i) => {
              const on = selected.includes(o.v);
              return (
                <button
                  key={String(o.v)}
                  className={`opt${i === act ? " act" : ""}${o.count === 0 ? " zero" : ""}`}
                  aria-pressed={on}
                  onClick={() => pick(o.v)}
                  onMouseMove={() => setAct(i)}
                  title={dim === "state" && o.v === "issue" ? t("library.issueHint") : undefined}
                >
                  <span className={`cb${on ? " on" : ""}`} aria-hidden="true">
                    {on && "✓"}
                  </span>
                  <span className="opt-l">{o.label}</span>
                  <span className="c">{o.count}</span>
                  <span className="bar" aria-hidden="true">
                    {o.count > 0 && <b style={{ width: `${Math.round((o.count / max) * 100)}%` }} />}
                  </span>
                </button>
              );
            })}
            {opts.length === 0 && <div className="pv-empty">{t("pickList.none")}</div>}
          </div>
        </div>
        <div className="pv-foot hints">
          <span>
            <ActionKey id="next" />
            <ActionKey id="prev" /> <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            {t("common.hintMove")}
          </span>
          <span>
            <Kbd>Space</Kbd>
            {t("facetPopover.hintToggle")}
          </span>
          <span className="r">
            <Kbd>Esc</Kbd>
          </span>
        </div>
      </div>
    </Popover>
  );
}
