// Feed import filters (feed_filter.rs): labels for the rule editor and the rejected list.
import type { FeedFilter, FilterField, FilterReason, FilterRule, Reevaluated } from "./api.ts";
import type { PlainKey, T } from "./i18n/index.ts";

export const FIELDS: [FilterField, PlainKey][] = [
  ["title", "feedFilter.fieldTitle"],
  ["url", "feedFilter.fieldUrl"],
  ["author", "feedFilter.fieldAuthor"],
  ["category", "feedFilter.fieldCategory"],
  ["domain", "feedFilter.fieldDomain"],
  ["language", "feedFilter.fieldLanguage"],
];

export const EMPTY_FILTER: FeedFilter = { rules: [], min_chars: null, llm: false, instruction: "", min_relevance: null };

export const newRule = (): FilterRule => ({ field: "title", action: "exclude", pattern: "", regex: false });

const fieldLabel = (f: FilterField, t: T) => t(FIELDS.find(([x]) => x === f)![1]);

/** 「タイトルに sponsored を含むものを除く」 */
export const ruleText = (r: FilterRule, t: T) =>
  t(r.action === "include" ? "feedFilter.ruleInclude" : "feedFilter.ruleExclude", { field: fieldLabel(r.field, t), pattern: r.regex ? `/${r.pattern}/` : r.pattern });

/** Why the filters kept an entry out. */
export function reasonText(r: FilterReason | null, t: T): string {
  if (!r) return t("feedFilter.reasonUnknown");
  const scope = r.kind === "llm" ? "" : t(r.scope === "global" ? "feedFilter.scopeGlobal" : "feedFilter.scopeFeed");
  switch (r.kind) {
    case "excluded": return t("feedFilter.reasonExcluded", { scope, rule: ruleText(r.rule, t) });
    case "not_included": return t("feedFilter.reasonNotIncluded", { scope });
    case "too_short": return t("feedFilter.reasonTooShort", { scope, chars: r.chars, min: r.min });
    case "llm": return r.score == null ? t("feedFilter.reasonLlm", { reason: r.reason }) : t("feedFilter.reasonLlmScore", { reason: r.reason, score: r.score });
  }
}

const same = (a: FilterRule, b: FilterRule) => a.field === b.field && a.action === b.action && a.pattern === b.pattern && a.regex === b.regex;

/** 「このルールを外す」: the filter without the first rule equal to `rule`. */
export const withoutRule = (f: FeedFilter, rule: FilterRule): FeedFilter => {
  const i = f.rules.findIndex((r) => same(r, rule));
  return i < 0 ? f : { ...f, rules: f.rules.filter((_, j) => j !== i) };
};

export const reevaluatedText = (r: Reevaluated, t: T) => t("feedFilter.reevaluated", { imported: r.imported, asked: r.asked, rejected: r.rejected });
