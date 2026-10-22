import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BINDINGS, actionFor, conflicts, getBindings, isCustom, keyLabel, merge, pageKeys, resetKeys, setKeys } from "./keys.ts";
import { keyOf } from "./keyname.ts";

const ev = (key: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

test("keyOf: canonical keys; Shift only where the key does not print it", () => {
  assert.equal(keyOf(ev("j")), "J");
  assert.equal(keyOf(ev("J", { shiftKey: true })), "Shift+J");
  assert.equal(keyOf(ev("k", { ctrlKey: true })), "Ctrl+K");
  assert.equal(keyOf(ev("k", { metaKey: true })), "Ctrl+K");
  assert.equal(keyOf(ev("?", { shiftKey: true })), "?");
  assert.equal(keyOf(ev("Enter", { shiftKey: true })), "Shift+Enter");
  assert.equal(keyOf(ev(" ")), "Space");
  assert.equal(keyOf(ev("Control", { ctrlKey: true })), null);
  assert.equal(keyOf(ev("Shift", { shiftKey: true })), null);
});

test("keyLabel: display form", () => {
  assert.deepEqual(["Ctrl+K", "J", "Shift+J", "ArrowDown", "Escape", "Ctrl++", "/"].map(keyLabel), ["Ctrl K", "j", "Shift J", "↓", "Esc", "Ctrl +", "/"]);
});

test("actionFor: defaults, several keys per action, overrides replace an action's keys", () => {
  assert.equal(actionFor(DEFAULT_BINDINGS, "J")?.id, "next");
  assert.equal(actionFor(DEFAULT_BINDINGS, "ArrowDown")?.id, "next");
  assert.equal(actionFor(DEFAULT_BINDINGS, "Ctrl+K")?.id, "palette");
  assert.equal(actionFor(DEFAULT_BINDINGS, "Q"), undefined);
  const b = merge({ next: ["N"] });
  assert.equal(actionFor(b, "N")?.id, "next");
  assert.equal(actionFor(b, "J"), undefined);
  assert.equal(actionFor(b, "K")?.id, "prev");
});

test("conflicts: a key bound to two actions, first in registry order wins", () => {
  assert.equal(conflicts(DEFAULT_BINDINGS).size, 0);
  const b = merge({ favorite: ["S", "J"] });
  assert.deepEqual([...conflicts(b)], [["J", ["next", "favorite"]]]);
  assert.equal(actionFor(b, "J")?.id, "next");
});

test("pageKeys: Ctrl keys of in-field actions go from page fields too; named keys stay the page's", () => {
  const k = pageKeys(DEFAULT_BINDINGS);
  assert.deepEqual(k.inFields, ["Ctrl+K", "Ctrl+B", "Ctrl+T", "Ctrl+W", "Ctrl+Tab", "Ctrl+Shift+Tab", "Ctrl+\\", "Ctrl+-", "Ctrl+Shift+N"]);
  assert.deepEqual(k.outside, ["/", "J", "K", "S", "M", "F", "V", "[", "]"]);
  assert.deepEqual(k.prefix, ["Ctrl+B"]);
  assert.ok(![...k.inFields, ...k.outside].some((x) => x.startsWith("Alt+Arrow")), "back / forward over a page are the page's own history");
  const custom = pageKeys(merge({ palette: ["P"], favorite: ["Ctrl+S"], next: ["Shift+J", "Space"] }));
  assert.ok(custom.outside.includes("P") && !custom.inFields.includes("P"), "a plain key never from a field");
  assert.ok(custom.outside.includes("Ctrl+S"), "an action that skips the app's fields skips the page's");
  assert.ok(custom.outside.includes("Shift+J") && !custom.outside.includes("Space"));
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
