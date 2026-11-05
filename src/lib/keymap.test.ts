import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BINDINGS, actionFor, afterFirst, chordFrom, conflicts, keyLabel, keyOf, merge, pageKeys } from "./keymap.ts";

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
  assert.deepEqual(k.outside, ["/", "J", "K", "S", "M", "F", "V", "Y", "[", "]"]);
  assert.deepEqual(k.prefix, ["Ctrl+B"]);
  assert.ok(![...k.inFields, ...k.outside].some((x) => x.startsWith("Alt+Arrow")), "back / forward over a page are the page's own history");
  const custom = pageKeys(merge({ palette: ["P"], favorite: ["Ctrl+S"], next: ["Shift+J", "Space"] }));
  assert.ok(custom.outside.includes("P") && !custom.inFields.includes("P"), "a plain key never from a field");
  assert.ok(custom.outside.includes("Ctrl+S"), "an action that skips the app's fields skips the page's");
  assert.ok(custom.outside.includes("Shift+J") && !custom.outside.includes("Space"));
});

test("two-key bindings: any first key, shown in turn, with what can follow it", () => {
  assert.equal(actionFor(DEFAULT_BINDINGS, 'Ctrl+B "')?.id, "splitDown");
  assert.equal(actionFor(DEFAULT_BINDINGS, '"'), undefined, "not without the first key");
  assert.equal(keyLabel('Ctrl+B "'), 'Ctrl B › "');
  assert.equal(keyLabel("Ctrl+B X"), "Ctrl B › x");
  assert.equal(keyLabel("G Space"), "g › Space");

  const b = merge({ favorite: ["S", "G G"], read: ["G G", "G M"], splitDown: ["Ctrl+-"] });
  assert.equal(chordFrom(b, "G")?.id, "favorite");
  assert.equal(chordFrom(b, "S"), undefined);
  assert.deepEqual(afterFirst(b, "G"), [
    ["favorite", ["G"]],
    ["read", ["M"]],
  ]);
  assert.ok(!afterFirst(b, "Ctrl+B").some(([id]) => id === "splitDown"), "a removed key leaves the hint");
  assert.deepEqual(afterFirst(DEFAULT_BINDINGS, "Ctrl+B")[0], ["focus", ["Z"]]);
});

test("chordFrom: a first key works in fields if any of its bindings does", () => {
  const b = merge({ favorite: ["Ctrl+G S"], newTab: ["Ctrl+G T"] });
  assert.equal(chordFrom(b, "Ctrl+G")?.id, "newTab");
});

test("pageKeys: a two-key binding forwards its first key by the same rules, and arms the overlay", () => {
  const k = pageKeys(merge({ favorite: ["G G", "Ctrl+G S"], read: ["Enter X"], next: ["Ctrl+Y Y"] }));
  assert.ok(k.outside.includes("G") && !k.inFields.includes("G"), "a plain first key never from a field");
  assert.ok(k.outside.includes("Ctrl+G"), "an action that skips the app's fields skips the page's");
  assert.ok(!k.outside.includes("Enter") && !k.prefix.includes("Enter"), "Enter stays the page's, also as a first key");
  assert.deepEqual(k.prefix.sort(), ["Ctrl+B", "Ctrl+G", "Ctrl+Y", "G"]);
  assert.ok(![...k.inFields, ...k.outside].some((x) => x.includes(" ")));
});
