import { test } from "node:test";
import assert from "node:assert/strict";
import { relTime } from "./time.ts";

test("relTime: past and future in the largest whole unit, null and garbage as —", () => {
  const now = Date.parse("2026-10-17T12:00:00Z");
  const at = (ms: number) => new Date(now + ms).toISOString();
  const min = 60_000;
  assert.equal(relTime(null, now), "—");
  assert.equal(relTime("not a date", now), "—");
  assert.equal(relTime(at(-30_000), now), "たった今");
  assert.equal(relTime(at(-12 * min), now), "12 分前");
  assert.equal(relTime(at(3 * min + 20_000), now), "3 分後");
  assert.equal(relTime(at(-90 * min), now), "1 時間前");
  assert.equal(relTime(at(-4 * 24 * 60 * min), now), "4 日前");
  assert.equal(relTime(at(-40 * 24 * 60 * min), now), new Date(now - 40 * 24 * 60 * min).toLocaleDateString("ja-JP"));
});
