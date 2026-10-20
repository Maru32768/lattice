import { test } from "node:test";
import assert from "node:assert/strict";
import type { FilterRule } from "./api.ts";
import { translatorFor } from "./i18n/index.ts";
import { EMPTY_FILTER, reasonText, withoutRule } from "./feedFilter.ts";

const [ja, en] = [translatorFor("ja"), translatorFor("en")];
const ad: FilterRule = { field: "title", action: "exclude", pattern: "sponsored", regex: false };

test("every rejection reason reads as a sentence in both languages", () => {
  assert.equal(reasonText({ kind: "excluded", scope: "global", rule: ad }, ja), "全体のルール「タイトルに sponsored を含むものを除く」で除外");
  assert.equal(reasonText({ kind: "excluded", scope: "feed", rule: { ...ad, field: "url", regex: true, pattern: "db-[0-9]+" } }, en),
    "Excluded by this feed's rule: skip if URL contains /db-[0-9]+/");
  assert.equal(reasonText({ kind: "not_included", scope: "feed" }, ja), "このフィードの「含む」ルールのどれにも合わない");
  assert.equal(reasonText({ kind: "too_short", scope: "global", min: 500, chars: 120 }, en), "Text too short for the global rules: 120 of 500 characters");
  assert.equal(reasonText({ kind: "llm", reason: "広告", score: 2 }, ja), "LLM: 広告（重要度 2）");
  assert.equal(reasonText({ kind: "llm", reason: "ad", score: null }, en), "LLM: ad");
  assert.equal(reasonText(null, en), "Rejected");
});

test("removing a rule takes out only the first equal one", () => {
  const f = { ...EMPTY_FILTER, rules: [ad, { ...ad, regex: true }, ad] };
  assert.deepEqual(withoutRule(f, ad).rules, [{ ...ad, regex: true }, ad]);
  assert.equal(withoutRule(f, { ...ad, pattern: "other" }), f, "no such rule: unchanged");
});
