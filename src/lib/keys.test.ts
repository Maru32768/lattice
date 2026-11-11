import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BINDINGS } from "./keymap.ts";
import { fromStored, getBindings, isCustom, parseShortcutsFile, replaceKeys, resetKeys, setKeys, shortcutsFile } from "./keys.ts";

test("fromStored: version 1's pane keys and fixed second keys become two-key bindings; version 2 stays as saved", () => {
  assert.deepEqual(fromStored({ splitDown: ["Ctrl+Shift+D"], favorite: ["X"], next: "J" }), {
    splitDown: ["Ctrl+Shift+D", 'Ctrl+B "'],
    favorite: ["X"],
  });
  const moved = fromStored({ pane: ["Ctrl+G"], splitDown: ["Ctrl+Shift+D"] });
  assert.deepEqual(moved.splitDown, ["Ctrl+Shift+D", 'Ctrl+G "']);
  assert.deepEqual(moved.splitRight, ["Ctrl+\\", "Ctrl+G %"], "no override of its own: the default key stays");
  assert.deepEqual(moved.paneLeft, ["Ctrl+H", "Ctrl+G ArrowLeft", "Ctrl+G H"]);
  assert.deepEqual(moved.nextTab, ["Ctrl+Tab", "G T", "Ctrl+G N"], "a two-key default under another first key stays as it is");
  assert.deepEqual(fromStored({ view: ["X"] }), { view: ["X"] }, "so does an override of one");
  assert.deepEqual(fromStored({ pane: [] }).closePane, []);
  assert.deepEqual(fromStored({ splitDown: ["Ctrl+Shift+D"], pane: ["Ctrl+G"], version: 2 }), { splitDown: ["Ctrl+Shift+D"] });
});

test("custom keys: setting an action's defaults back clears its override; reset restores one action or all", () => {
  setKeys("next", ["N"]);
  assert.deepEqual(getBindings().next, ["N"]);
  assert.ok(isCustom("next"));
  setKeys("next", [...DEFAULT_BINDINGS.next]);
  assert.ok(!isCustom("next"), "a later change to the defaults reaches this action again");
  setKeys("prev", ["P"]);
  setKeys("favorite", ["X"]);
  resetKeys("prev");
  assert.deepEqual([getBindings().prev, isCustom("favorite")], [DEFAULT_BINDINGS.prev, true]);
  replaceKeys({});
  assert.deepEqual(getBindings(), DEFAULT_BINDINGS);
});

test("replaceKeys returns the keys it replaced, and passing them back restores the bindings", () => {
  setKeys("next", ["N"]);
  setKeys("favorite", []);
  const before = getBindings();
  const prev = replaceKeys({});
  assert.deepEqual(getBindings(), DEFAULT_BINDINGS);
  replaceKeys(prev);
  assert.deepEqual(getBindings(), before);
  replaceKeys({});
});

test("a shortcuts file holds only the changed keys, marked, and reads back as them", () => {
  setKeys("next", ["N"]);
  setKeys("favorite", []);
  const file = shortcutsFile();
  assert.deepEqual(JSON.parse(file), { format: "lattice.shortcuts", version: 2, next: ["N"], favorite: [] });
  replaceKeys({});
  assert.deepEqual(parseShortcutsFile(file), { next: ["N"], favorite: [] });
});

test("a file without the marker, or not JSON, reads as nothing rather than as no changed keys", () => {
  assert.equal(parseShortcutsFile(JSON.stringify({ next: ["N"], version: 2 })), null, "the stored value alone");
  assert.equal(parseShortcutsFile(JSON.stringify({})), null);
  for (const version of [undefined, 1, 3, "2"]) {
    assert.equal(parseShortcutsFile(JSON.stringify({ format: "lattice.shortcuts", version, splitDown: ["Ctrl+-"] })), null, `version ${version}`);
  }
  for (const text of ["not json", "", "null", "[]", '"lattice.shortcuts"']) {
    assert.equal(parseShortcutsFile(text), null, text);
  }
});

test("a file's repeated and empty keys are dropped, and an action with a key that is not text is left out", () => {
  const file = JSON.stringify({ format: "lattice.shortcuts", version: 2, next: ["N", "N", "", "M"], prev: ["K", 3], favorite: "X" });
  assert.deepEqual(parseShortcutsFile(file), { next: ["N", "M"] });
});
