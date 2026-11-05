import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BINDINGS } from "./keymap.ts";
import { fromStored, getBindings, isCustom, resetKeys, setKeys } from "./keys.ts";

test("fromStored: version 1's pane keys and fixed second keys become two-key bindings; version 2 stays as saved", () => {
  assert.deepEqual(fromStored({ splitDown: ["Ctrl+Shift+D"], favorite: ["X"], next: "J" }), {
    splitDown: ["Ctrl+Shift+D", 'Ctrl+B "'],
    favorite: ["X"],
  });
  const moved = fromStored({ pane: ["Ctrl+G"], splitDown: ["Ctrl+Shift+D"] });
  assert.deepEqual(moved.splitDown, ["Ctrl+Shift+D", 'Ctrl+G "']);
  assert.deepEqual(moved.splitRight, ["Ctrl+\\", "Ctrl+G %"], "no override of its own: the default key stays");
  assert.deepEqual(moved.paneLeft, ["Ctrl+G ArrowLeft", "Ctrl+G H"]);
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
  resetKeys();
  assert.deepEqual(getBindings(), DEFAULT_BINDINGS);
});
