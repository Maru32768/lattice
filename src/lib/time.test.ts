import { test } from "node:test";
import assert from "node:assert/strict";
import { relTime } from "./time.ts";
import { translatorFor } from "../i18n/index.ts";

const [ja, en] = [translatorFor("ja"), translatorFor("en")];

test("relTime: past and future in the largest whole unit, null and garbage as —", () => {
  const now = Date.parse("2026-10-17T12:00:00Z");
  const at = (ms: number) => new Date(now + ms).toISOString();
  const min = 60_000;
  assert.equal(relTime(null, ja, now), "—");
  assert.equal(relTime("not a date", ja, now), "—");
  assert.equal(relTime(at(-30_000), ja, now), "たった今");
  assert.equal(relTime(at(-12 * min), ja, now), "12 分前");
  assert.equal(relTime(at(3 * min + 20_000), ja, now), "3 分後");
  assert.equal(relTime(at(-90 * min), ja, now), "1 時間前");
  assert.equal(relTime(at(-4 * 24 * 60 * min), ja, now), "4 日前");
  assert.equal(relTime(at(-40 * 24 * 60 * min), ja, now), new Date(now - 40 * 24 * 60 * min).toLocaleDateString("ja-JP"));
  assert.deepEqual([at(-30_000), at(-12 * min), at(3 * min + 20_000), at(-min * 60)].map((x) => relTime(x, en, now)), ["just now", "12 minutes ago", "in 3 minutes", "1 hour ago"]);
});
