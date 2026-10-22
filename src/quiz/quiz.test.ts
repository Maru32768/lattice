import { test } from "node:test";
import assert from "node:assert/strict";
import type { QuizQuestion } from "../api.ts";
import { formatInterval, knownCount, suggestedGrade } from "./quiz.ts";
import { translatorFor } from "../i18n/index.ts";

const [ja, en] = [translatorFor("ja"), translatorFor("en")];

test("formatInterval: minutes, hours, days, then months and years to a tenth", () => {
  const day = 24 * 60;
  assert.equal(formatInterval(10, ja), "10分");
  assert.equal(formatInterval(90, ja), "2時間");
  assert.equal(formatInterval(day, ja), "1日");
  assert.equal(formatInterval(30 * day, ja), "30日");
  assert.equal(formatInterval(45 * day, ja), "1.5か月");
  assert.equal(formatInterval(365 * day, ja), "1年");
  assert.deepEqual(
    [10, 90, day, 6 * day, 45 * day, 730 * day].map((m) => formatInterval(m, en)),
    ["10 min", "2 hr", "1 day", "6 days", "1.5 mo", "2 yr"],
  );
});

test("a multiple-choice answer suggests 正解 or もう一度; recall has no suggestion", () => {
  const base = { id: 1, question: "q", answer: "b", explanation: "", block_ids: [] };
  const choice: QuizQuestion = { ...base, kind: "choice", options: ["a", "b", "c", "d"] };
  assert.equal(suggestedGrade(choice, "b"), "good");
  assert.equal(suggestedGrade(choice, "a"), "again");
  assert.equal(suggestedGrade(choice, null), null);
  assert.equal(suggestedGrade({ ...base, kind: "recall" }, "b"), null);
  assert.equal(knownCount(["again", "hard", "good", "easy", "again"]), 3);
});
