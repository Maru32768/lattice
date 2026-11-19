import { useId, useRef, useState, type ReactNode } from "react";
import { Virtuoso, type ListRange, type VirtuosoHandle } from "react-virtuoso";
import { listStep } from "../lib/keys";
import { useT } from "../i18n";
import { Icon, type IconName } from "./Icon";
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

/** The rows of one query, kept until the next: null while the options load. `size` is how many of them are options. */
interface Held<O extends PickOption> {
  query: string;
  rows: PickRow<O>[] | null;
  size: number;
}

function hold<O extends PickOption>(query: string, sections: readonly PickSection<O>[] | null): Held<O> {
  const rows = sections && pickRows(sections);
  return { query, rows, size: rows ? rows.filter((r) => r.kind === "opt").length : 0 };
}

/**
 * A search field over a virtualized listbox of every option, for a single choice (`selected` is a key) or a multiple
 * one (a list of keys). The field keeps the focus and names the highlighted option (`aria-activedescendant`), but only
 * while virtualization has that row drawn.
 *
 * The list asks `arrange` for its rows when it opens and when the query changes, and keeps them until the next query:
 * the highlight is a row, and a row that moved under it would make Enter pick what the user did not choose. A picked
 * option keeps its row; its check and every count are read live from `selected` and `counts`.
 */
export function PickList<O extends PickOption>({
  label,
  search,
  placeholder,
  icon,
  query,
  onQuery,
  arrange,
  selected,
  counts,
  onPick,
  onKey,
  matches,
  empty,
  mono,
  head,
  children,
}: {
  /** The listbox's name. */
  label: string;
  /** The search field's name, and its placeholder unless `placeholder` is given. */
  search: string;
  placeholder?: string;
  icon?: IconName;
  query: string;
  onQuery: (q: string) => void;
  /** The options for a query, in their sections; null while they load (the list asks again until they come). Pure. */
  arrange: (query: string) => readonly PickSection<O>[] | null;
  selected: string | readonly string[];
  /** Each option's count now (0 when missing). With `whole`, the count is drawn as a share of it, and a 0 is faint but pickable. */
  counts?: { of: ReadonlyMap<string, number>; whole?: number };
  /** A click on an option, or Enter on the highlighted one. The list stays open: closing is the caller's. */
  onPick: (o: O) => void;
  /** Sees each key first, but not while an IME composes, with the highlighted option; `preventDefault()` keeps the key from the list. */
  onKey?: (e: React.KeyboardEvent, active: O | null) => void;
  /** While searching, the field says how many options match. */
  matches?: boolean;
  /** What a list with no option says. */
  empty?: string;
  mono?: boolean;
  /** In the head, under the search field. */
  head?: ReactNode;
  /** Under the list. */
  children?: ReactNode;
}) {
  const t = useT();
  const id = useId();
  const list = useRef<VirtuosoHandle>(null);
  const input = useRef<HTMLInputElement>(null);
  const [held, setHeld] = useState(() => hold(query, arrange(query)));
  /** Where the keys or the pointer moved the highlight; until they do, and from each new search, it is on `start`. */
  const [moved, setMoved] = useState<number | null>(null);
  /** The rows Virtuoso has drawn. */
  const [drawn, setDrawn] = useState<ListRange | null>(null);
  if (held.query !== query) {
    setHeld(hold(query, arrange(query)));
    setMoved(null);
    setDrawn(null);
  } else if (!held.rows) {
    const sections = arrange(query);
    if (sections) {
      setHeld(hold(query, sections));
    }
  }
  const rows = held.rows ?? [];
  const one = typeof selected === "string" ? selected : undefined;
  const many = typeof selected === "string" ? null : new Set(selected);
  const start = defaultRow(rows, query, one);
  // A key can be listed twice (the list's scope, and the same filter in its section): mark one, as a select does.
  const mine = one === undefined ? -1 : rows.findIndex((r) => r.kind === "opt" && r.o.key === one);
  const at = moved ?? start;
  const current = rows[at];
  const named = enabled(current) && drawn !== null && at >= drawn.startIndex && at <= drawn.endIndex;
  const open = rows.length > 0;
  const activate = (i: number) => {
    if (enabled(rows[i])) {
      setMoved(i);
    }
  };
  /** The first row in view on opening, with the start in the middle. */
  const top = Math.max(0, Math.min(start - MAX_ROWS / 2, rows.length - MAX_ROWS));

  function keys(e: React.KeyboardEvent) {
    if (e.nativeEvent.isComposing) {
      return;
    }
    onKey?.(e, enabled(current) ? current.o : null);
    if (e.defaultPrevented) {
      return;
    }
    const by = listStep(e, true) || (e.key === "PageDown" ? MAX_ROWS : e.key === "PageUp" ? -MAX_ROWS : 0);
    if (by) {
      e.preventDefault();
      const i = stepRow(rows, at, by);
      if (enabled(rows[i])) {
        setMoved(i);
        // Up onto a section's first option: its head comes into view with it.
        list.current?.scrollIntoView({ index: by < 0 && rows[i - 1]?.kind === "head" ? i - 1 : i });
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (enabled(current)) {
        onPick(current.o);
      }
    }
  }

  function row(i: number, r: PickRow<O>) {
    if (r.kind === "head") {
      return (
        <div className="ph" role="presentation">
          {r.label}
          {r.note !== undefined && <span>{r.note}</span>}
        </div>
      );
    }
    const o = r.o;
    const on = !o.icon && (many ? many.has(o.key) : i === mine);
    const n = counts && !o.icon ? (counts.of.get(o.key) ?? 0) : undefined;
    const whole = counts?.whole;
    return (
      <button
        role="option"
        tabIndex={-1}
        id={`${id}-${i}`}
        aria-selected={on}
        aria-disabled={o.disabled || undefined}
        aria-setsize={held.size}
        aria-posinset={r.n}
        aria-description={r.section || undefined}
        className={`opt${i === at ? " act" : ""}${o.disabled || (whole !== undefined && n === 0) ? " zero" : ""}${mono ? " mono" : ""}`}
        // Not on enter: a row the list scrolls under a still mouse does not take the keyboard's place.
        onMouseMove={() => activate(i)}
        onClick={() => {
          if (!o.disabled) {
            onPick(o);
          }
        }}
      >
        {o.icon ? (
          <Icon name={o.icon} size="sm" />
        ) : many ? (
          <span className={`cb${on ? " on" : ""}`} aria-hidden="true">
            {on && "✓"}
          </span>
        ) : (
          <span className="check" aria-hidden="true">
            {on ? "✓" : ""}
          </span>
        )}
        <span className="opt-l">{o.icon ? o.label : <Marked text={o.label} q={query.trim()} />}</span>
        {n !== undefined && <span className="c">{n}</span>}
        {n !== undefined && whole !== undefined && (
          <span className="bar" aria-hidden="true">
            {n > 0 && <b style={{ width: `${Math.round((n / Math.max(1, whole)) * 100)}%` }} />}
          </span>
        )}
      </button>
    );
  }

  return (
    // A press anywhere but the search would take the focus from it, and the typing and the keys with it.
    <div
      className="facet-pv"
      onKeyDown={keys}
      onMouseDown={(e) => {
        if (e.target !== input.current) {
          e.preventDefault();
        }
      }}
    >
      <div className="pv-head">
        <label className="pv-search">
          <Icon name={icon ?? "search"} />
          <span className="vh">{search}</span>
          <input
            ref={input}
            role="combobox"
            aria-expanded={open}
            aria-autocomplete="list"
            aria-controls={open ? id : undefined}
            aria-activedescendant={named ? `${id}-${at}` : undefined}
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder={placeholder ?? search}
          />
          {matches && query.trim() && <span className="pv-count">{t("pickList.matches", { matchCount: held.size })}</span>}
        </label>
        {head}
      </div>
      {open ? (
        <Virtuoso
          ref={list}
          // A new query starts a new list, at its first match.
          key={held.query}
          id={id}
          role="listbox"
          aria-label={label}
          aria-multiselectable={many ? true : undefined}
          tabIndex={-1}
          className="pick-list"
          style={{ height: Math.min(rows.length, MAX_ROWS) * ROW_H }}
          data={rows}
          fixedItemHeight={ROW_H}
          // A page drawn beyond each edge: a key moves the highlight at most a page, onto a row already drawn, which the
          // field can name at once.
          increaseViewportBy={MAX_ROWS * ROW_H}
          rangeChanged={setDrawn}
          // Virtuoso draws no row until it has measured the list, nor while it first scrolls: the rows of a list that opens at
          // the top are drawn at once. Drawn before a first scroll, they would blink out until it ends.
          initialItemCount={top === 0 ? Math.min(rows.length, MAX_ROWS) : 0}
          initialTopMostItemIndex={top}
          itemContent={row}
        />
      ) : (
        <div className="pv-empty">{held.rows ? (empty ?? t("pickList.none")) : t("pickList.loading")}</div>
      )}
      {children}
    </div>
  );
}
