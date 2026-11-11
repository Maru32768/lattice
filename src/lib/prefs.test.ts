import { test } from "node:test";
import assert from "node:assert/strict";
import { SYNCED, planSync, type Cached } from "./prefs.ts";

const cache = (values: Partial<Cached> = {}): Cached => ({ ...(Object.fromEntries(SYNCED.map((k) => [k, null])) as Cached), ...values });
const SHORTCUTS = JSON.stringify({ read: ["Q"], version: 2 });

test("the library's row wins over a different cached value", () => {
  const local = cache({ "lattice.shortcuts": SHORTCUTS, "lattice.vocabMarks": "on" });
  assert.deepEqual(planSync(local, { "lattice.shortcuts": "{}", "lattice.vocabMarks": "off" }, local), {
    cache: { "lattice.shortcuts": "{}", "lattice.vocabMarks": "off" },
    db: {},
  });
});

test("an empty row clears the cached value", () => {
  const local = cache({ "lattice.chatVim": "on", "lattice.vimrc": "nnoremap x y" });
  assert.deepEqual(planSync(local, { "lattice.chatVim": "", "lattice.vimrc": "" }, local), {
    cache: { "lattice.chatVim": null, "lattice.vimrc": null },
    db: {},
  });
});

test("a cached value with no row goes to the library, one key at a time", () => {
  const local = cache({ "lattice.chatVim": "on", "lattice.searchEngine": '{"id":"google","custom":""}' });
  assert.deepEqual(planSync(local, { "lattice.chatVim": "on" }, local), { cache: {}, db: { "lattice.searchEngine": '{"id":"google","custom":""}' } });
});

test("nothing is written when neither has a value or both agree", () => {
  assert.deepEqual(planSync(cache(), {}, cache()), { cache: {}, db: {} });
  const local = cache({ "lattice.vocabAutoplay": "off" });
  assert.deepEqual(planSync(local, { "lattice.vocabAutoplay": "off", "lattice.chatVim": "" }, local), { cache: {}, db: {} });
});

test("a key changed while the rows were on their way keeps its change", () => {
  const before = cache({ "lattice.shortcuts": SHORTCUTS, "lattice.translateOnSwitch": "on" });
  const now = cache({ "lattice.shortcuts": JSON.stringify({ favorite: ["X"], version: 2 }), "lattice.translateOnSwitch": "off" });
  assert.deepEqual(planSync(before, { "lattice.shortcuts": "{}" }, now), { cache: {}, db: {} }, "neither the row nor the old cached value is written");
});
