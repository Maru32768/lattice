import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BINDINGS, actionFor, conflicts, keyLabel, keyOf, merge } from "./keys.ts";

const ev = (key: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {}) =>
  ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

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
