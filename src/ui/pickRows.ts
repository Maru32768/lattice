import type { IconName } from "./Icon";

/** What a row is while the list is open. Whether it is chosen and its count are read live, beside it. */
export interface PickOption {
  key: string;
  label: string;
  disabled?: boolean;
  /** An action rather than a choice (a picker's add row): the icon stands where the check would, with no count. */
  icon?: IconName;
}

export interface PickSection<O extends PickOption = PickOption> {
  label: string;
  /** At the end of the section's head. */
  note?: string;
  options: readonly O[];
}

/**
 * One line of the list. A section with a label and options gets a head row. `n` is the option's 1-based position among
 * the options; it and `section` are on the option itself, as its head may be scrolled out and unmounted.
 */
export type PickRow<O extends PickOption = PickOption> = { kind: "head"; label: string; note?: string } | { kind: "opt"; o: O; n: number; section: string };

export function pickRows<O extends PickOption>(sections: readonly PickSection<O>[]): PickRow<O>[] {
  const rows: PickRow<O>[] = [];
  let n = 0;
  for (const s of sections) {
    if (s.label && s.options.length > 0) {
      rows.push({ kind: "head", label: s.label, note: s.note });
    }
    for (const o of s.options) {
      rows.push({ kind: "opt", o, n: ++n, section: s.label });
    }
  }
  return rows;
}

/**
 * The options whose label holds `q`, ignoring case, those where it comes earlier first within each section; sections
 * left empty are dropped, and a blank query returns `sections` itself.
 */
export function filterSections<O extends PickOption>(sections: readonly PickSection<O>[], q: string): readonly PickSection<O>[] {
  const ql = q.trim().toLowerCase();
  if (!ql) {
    return sections;
  }
  const hits = (options: readonly O[]) =>
    options
      .map((o) => ({ o, at: o.label.toLowerCase().indexOf(ql) }))
      .filter((h) => h.at >= 0)
      .sort((a, b) => a.at - b.at)
      .map((h) => h.o);
  return sections.map((s) => ({ ...s, options: hits(s.options) })).filter((s) => s.options.length > 0);
}

export const enabled = <O extends PickOption>(r: PickRow<O> | undefined): r is Extract<PickRow<O>, { kind: "opt" }> => r?.kind === "opt" && !r.o.disabled;

/**
 * The enabled option `by` rows away from `from`: the first one from there on in that direction, else the nearest one
 * back towards `from`. Clamped to the list, with no wrap, as a native select; `from` when there is none.
 */
export function stepRow(rows: readonly PickRow[], from: number, by: number): number {
  const d = by < 0 ? -1 : 1;
  const to = Math.max(0, Math.min(rows.length - 1, from + by));
  for (let i = to; i >= 0 && i < rows.length; i += d) {
    if (enabled(rows[i])) {
      return i;
    }
  }
  for (let i = to - d; d * (i - from) > 0; i -= d) {
    if (enabled(rows[i])) {
      return i;
    }
  }
  return from;
}

/**
 * With a query, the first enabled option named exactly so, ignoring case; with none, a single choice's `selected`.
 * Otherwise the first enabled option; -1 when none is.
 */
export function defaultRow(rows: readonly PickRow[], query: string, selected: string | undefined): number {
  const ql = query.trim().toLowerCase();
  const at = rows.findIndex((r) => enabled(r) && (ql ? r.o.label.toLowerCase() === ql : r.o.key === selected));
  return at >= 0 ? at : rows.findIndex((r) => enabled(r));
}

/** The label of the first option with `key`. */
export function labelOf(sections: readonly PickSection[], key: string): string | undefined {
  for (const s of sections) {
    const o = s.options.find((x) => x.key === key);
    if (o) {
      return o.label;
    }
  }
  return undefined;
}
