import { useId, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { listStep } from "../lib/keys";
import { useT } from "../i18n";
import { Icon } from "./Icon";
import { defaultRow, enabled, pickRows, stepRow, type PickOption, type PickRow, type PickSection } from "./pickRows";

/** The height of `.opt` and `.pick-list .ph` in App.css: Virtuoso takes it on trust and measures no row. */
const ROW_H = 30;
const MAX_ROWS = 12;

export function Marked({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) {
    return <>{text}</>;
  }
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

/**
 * A search field over a virtualized listbox of every option. The field keeps the focus and names the active option
 * (`aria-activedescendant`), as a row may be unmounted by the time the keys reach it.
 */
export function PickList<O extends PickOption>({
  label,
  search,
  query,
  onQuery,
  sections,
  selected,
  onPick,
}: {
  /** The listbox's name. */
  label: string;
  /** The search field's label and placeholder. */
  search: string;
  query: string;
  onQuery: (q: string) => void;
  sections: readonly PickSection<O>[];
  selected: string;
  onPick: (o: O) => void;
}) {
  const t = useT();
  const id = useId();
  const list = useRef<VirtuosoHandle>(null);
  const rows = pickRows(sections);
  const size = sections.reduce((n, s) => n + s.options.length, 0);
  const start = defaultRow(rows, query, selected);
  const [active, setActive] = useState<number | null>(null);
  const [seen, setSeen] = useState(query);
  if (query !== seen) {
    setSeen(query);
    setActive(null);
  }
  const at = Math.min(active ?? start, rows.length - 1);
  const current = rows[at];
  /** The first row in view on opening, with the start in the middle. */
  const top = Math.max(0, Math.min(start - MAX_ROWS / 2, rows.length - MAX_ROWS));

  function keys(e: React.KeyboardEvent) {
    if (e.nativeEvent.isComposing) {
      return;
    }
    const by = listStep(e, true) || (e.key === "PageDown" ? MAX_ROWS : e.key === "PageUp" ? -MAX_ROWS : 0);
    if (by) {
      e.preventDefault();
      const i = stepRow(rows, at, by);
      setActive(i);
      // Up onto a section's first option: its head comes into view with it.
      list.current?.scrollIntoView({ index: by < 0 && rows[i - 1]?.kind === "head" ? i - 1 : i });
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (enabled(current)) {
        onPick(current.o);
      }
    }
  }

  const row = (i: number, r: PickRow<O>) =>
    r.kind === "head" ? (
      <div className="ph" role="presentation">
        {r.label}
      </div>
    ) : (
      <button
        role="option"
        tabIndex={-1}
        id={`${id}-${i}`}
        aria-selected={r.o.key === selected}
        aria-disabled={r.o.disabled || undefined}
        aria-setsize={size}
        aria-posinset={r.n}
        className={`opt${i === at ? " act" : ""}${r.o.disabled ? " zero" : ""}`}
        onMouseDown={(e) => e.preventDefault()}
        // Not on enter: a row the list scrolls under a still mouse does not take the keyboard's place.
        onMouseMove={() => {
          if (!r.o.disabled) {
            setActive(i);
          }
        }}
        onClick={() => {
          if (!r.o.disabled) {
            onPick(r.o);
          }
        }}
      >
        <span className="check" aria-hidden="true">
          {r.o.key === selected ? "✓" : ""}
        </span>
        <span className="opt-l">
          <Marked text={r.o.label} q={query.trim()} />
        </span>
      </button>
    );

  return (
    <div className="facet-pv" onKeyDown={keys}>
      <div className="pv-head">
        <label className="pv-search">
          <Icon name="search" />
          <span className="vh">{search}</span>
          <input
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls={id}
            aria-activedescendant={current?.kind === "opt" ? `${id}-${at}` : undefined}
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder={search}
          />
        </label>
      </div>
      {rows.length ? (
        <Virtuoso
          ref={list}
          // A new query starts a new list, at its first match.
          key={query}
          id={id}
          role="listbox"
          aria-label={label}
          tabIndex={-1}
          className="pick-list"
          style={{ height: Math.min(rows.length, MAX_ROWS) * ROW_H }}
          data={rows}
          fixedItemHeight={ROW_H}
          // Virtuoso draws no row until it has measured the list, nor while it first scrolls: the rows of a list that opens at
          // the top are drawn at once. Drawn before a first scroll, they would blink out until it ends.
          initialItemCount={top === 0 ? Math.min(rows.length, MAX_ROWS) : 0}
          initialTopMostItemIndex={top}
          itemContent={row}
        />
      ) : (
        <div className="pv-empty">{t("pickList.none")}</div>
      )}
    </div>
  );
}
