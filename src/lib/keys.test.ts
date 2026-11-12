import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// A window with storage, so the store saves where a test can read it and loads on a storage event as in the app.
const { window } = new JSDOM("", { url: "http://localhost/" });
Object.assign(globalThis, { window, localStorage: window.localStorage });

const { DEFAULT_BINDINGS } = await import("./keymap.ts");
const { fromStored, getBindings, getPrefix, isCustom, parseShortcutsFile, replaceKeys, resetKeys, setKeys, setPrefix, shortcutsFile } =
  await import("./keys.ts");

const KEY = "lattice.shortcuts";
const DEFAULTS = { prefix: "Ctrl+A", overrides: {} };
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? "null") as unknown;
// Each test starts from the defaults, so that one that fails leaves the next its own start.
beforeEach(() => void replaceKeys(DEFAULTS));

/** What another window or the start-up sync does: the value changes and the store reads it again. */
function storedElsewhere(value: unknown) {
  localStorage.setItem(KEY, JSON.stringify(value));
  window.dispatchEvent(new window.StorageEvent("storage", { key: KEY }));
}

test("fromStored: the prefix and keys of version 4 as saved; another version reads as nothing, and a prefix that cannot be one as the default", () => {
  assert.deepEqual(fromStored({ version: 4, prefix: "Ctrl+B", splitDown: ['<prefix> "'], favorite: ["S", "S", ""] }), {
    prefix: "Ctrl+B",
    overrides: { splitDown: ['<prefix> "'], favorite: ["S"] },
  });
  for (const version of [undefined, 1, 2, 3, "4"]) {
    assert.deepEqual(fromStored({ splitDown: ['Ctrl+A "'], prefix: "Ctrl+B", version }), DEFAULTS, `version ${version}`);
  }
  for (const prefix of ["J", "Escape", "Shift+J", "Ctrl+B X", 3, null]) {
    assert.equal(fromStored({ version: 4, prefix }).prefix, "Ctrl+A", String(prefix));
  }
});

test("custom keys: setting an action's defaults back clears its override; reset restores one action or all", () => {
  setKeys("next", ["N"]);
  assert.deepEqual(getBindings().next, ["N"]);
  assert.ok(isCustom("next"));
  assert.deepEqual(stored(), { version: 4, next: ["N"] }, "the default prefix is not stored");
  setKeys("next", [...DEFAULT_BINDINGS.next]);
  assert.ok(!isCustom("next"), "a later change to the defaults reaches this action again");
  setKeys("prev", ["P"]);
  setKeys("favorite", ["X"]);
  resetKeys("prev");
  assert.deepEqual([getBindings().prev, isCustom("favorite")], [DEFAULT_BINDINGS.prev, true]);
  replaceKeys(DEFAULTS);
  assert.deepEqual(getBindings(), DEFAULT_BINDINGS);
});

test("a key recorded under the prefix is stored with <prefix> and follows the prefix; a key under another first key stays as it is", () => {
  setPrefix("Ctrl+B");
  setKeys("favorite", ["S", "Ctrl+B Q", "Ctrl+G Q", "G Ctrl+B"]);
  assert.deepEqual(stored(), { version: 4, prefix: "Ctrl+B", favorite: ["S", "<prefix> Q", "Ctrl+G Q", "G Ctrl+B"] });
  setPrefix("Alt+A");
  assert.equal(getPrefix(), "Alt+A");
  assert.deepEqual(getBindings().favorite, ["S", "Alt+A Q", "Ctrl+G Q", "G Ctrl+B"]);
  assert.deepEqual(getBindings().splitDown, ["Ctrl+-", 'Alt+A "'], "the defaults move too");
  assert.deepEqual(getBindings().sendPrefix, ["Alt+A Alt+A"]);
  assert.deepEqual(stored(), { version: 4, prefix: "Alt+A", favorite: ["S", "<prefix> Q", "Ctrl+G Q", "G Ctrl+B"] });
});

test("the prefix recorded as a key alone stays that key when the prefix changes", () => {
  setPrefix("Ctrl+B");
  setKeys("favorite", ["S", "Ctrl+B"]);
  setPrefix("Alt+A");
  assert.deepEqual(getBindings().favorite, ["S", "Ctrl+B"]);
  assert.deepEqual(stored(), { version: 4, prefix: "Alt+A", favorite: ["S", "Ctrl+B"] });
});

test("a key whose name begins with the prefix's, as Ctrl+ArrowLeft does Ctrl+A's, is not under the prefix", () => {
  setKeys("favorite", ["Ctrl+ArrowLeft", "Ctrl+Alt+S"]);
  setPrefix("Ctrl+B");
  assert.deepEqual(getBindings().favorite, ["Ctrl+ArrowLeft", "Ctrl+Alt+S"]);
  assert.deepEqual(stored(), { version: 4, prefix: "Ctrl+B", favorite: ["Ctrl+ArrowLeft", "Ctrl+Alt+S"] });
});

test("a default key that moved with the prefix is no change, and recording it back clears the override", () => {
  setPrefix("Ctrl+B");
  assert.deepEqual(getBindings().splitDown, ["Ctrl+-", 'Ctrl+B "']);
  assert.ok(!isCustom("splitDown"));
  setKeys("splitDown", ["Ctrl+-"]);
  assert.ok(isCustom("splitDown"));
  setKeys("splitDown", ["Ctrl+-", 'Ctrl+B "']);
  assert.ok(!isCustom("splitDown"));
  assert.deepEqual(stored(), { version: 4, prefix: "Ctrl+B" });
  replaceKeys(DEFAULTS);
  assert.deepEqual(stored(), { version: 4 });
});

test("what is stored loads back as the same prefix and bindings; a value of version 3 loads as the defaults", () => {
  setPrefix("Ctrl+Space");
  setKeys("read", ["M", "Ctrl+Space M"]);
  const saved = stored();
  const before = getBindings();
  replaceKeys(DEFAULTS);
  storedElsewhere(saved);
  assert.equal(getPrefix(), "Ctrl+Space");
  assert.deepEqual(getBindings(), before);
  assert.deepEqual(getBindings().read, ["M", "Ctrl+Space M"]);

  storedElsewhere({ version: 3, read: ["Q"] });
  assert.equal(getPrefix(), "Ctrl+A");
  assert.deepEqual(getBindings(), DEFAULT_BINDINGS);
});

test("replaceKeys returns the prefix and keys it replaced, and passing them back restores the bindings", () => {
  setPrefix("Ctrl+B");
  setKeys("next", ["N"]);
  setKeys("favorite", []);
  const before = getBindings();
  const prev = replaceKeys(DEFAULTS);
  assert.deepEqual([getPrefix(), getBindings()], ["Ctrl+A", DEFAULT_BINDINGS]);
  replaceKeys(prev);
  assert.equal(getPrefix(), "Ctrl+B");
  assert.deepEqual(getBindings(), before);
});

test("a shortcuts file holds the prefix and the changed keys, marked, and reads back as them", () => {
  setKeys("next", ["N"]);
  setKeys("favorite", []);
  assert.deepEqual(JSON.parse(shortcutsFile()), { format: "lattice.shortcuts", version: 4, next: ["N"], favorite: [] });
  setPrefix("Ctrl+B");
  setKeys("next", ["N", "Ctrl+B N"]);
  const file = shortcutsFile();
  assert.deepEqual(JSON.parse(file), { format: "lattice.shortcuts", version: 4, prefix: "Ctrl+B", next: ["N", "<prefix> N"], favorite: [] });
  const before = getBindings();
  replaceKeys(DEFAULTS);
  replaceKeys(parseShortcutsFile(file)!);
  assert.equal(getPrefix(), "Ctrl+B");
  assert.deepEqual(getBindings(), before);
});

test("a file without the marker, of another version, or not JSON, reads as nothing rather than as no changed keys", () => {
  assert.equal(parseShortcutsFile(JSON.stringify({ next: ["N"], version: 4 })), null, "the stored value alone");
  assert.equal(parseShortcutsFile(JSON.stringify({})), null);
  for (const version of [undefined, 1, 2, 3, 5, "4"]) {
    assert.equal(parseShortcutsFile(JSON.stringify({ format: "lattice.shortcuts", version, splitDown: ["Ctrl+-"] })), null, `version ${version}`);
  }
  for (const text of ["not json", "", "null", "[]", '"lattice.shortcuts"']) {
    assert.equal(parseShortcutsFile(text), null, text);
  }
});

test("a file's repeated and empty keys are dropped, an action with a key that is not text is left out, and a prefix that cannot be one is the default", () => {
  const file = JSON.stringify({ format: "lattice.shortcuts", version: 4, prefix: "J", next: ["N", "N", "", "M"], prev: ["K", 3], favorite: "X" });
  assert.deepEqual(parseShortcutsFile(file), { prefix: "Ctrl+A", overrides: { next: ["N", "M"] } });
});

test("a key recorded under another first key stays as recorded once a new prefix starts it, and after that one", () => {
  setKeys("favorite", ["S", "Ctrl+B Q"]);
  setPrefix("Ctrl+B");
  assert.deepEqual(getBindings().favorite, ["S", "Ctrl+B Q"]);
  setPrefix("Alt+A");
  assert.deepEqual(getBindings().favorite, ["S", "Ctrl+B Q"]);
  assert.deepEqual(stored(), { version: 4, prefix: "Alt+A", favorite: ["S", "Ctrl+B Q"] });
});

test("going to another prefix and back leaves every key and the stored value as they were", () => {
  setKeys("favorite", ["S", "Ctrl+B Q"]);
  setKeys("read", ["Ctrl+A S", "Ctrl+B S"]);
  const before = stored();
  assert.deepEqual(before, { version: 4, favorite: ["S", "Ctrl+B Q"], read: ["<prefix> S", "Ctrl+B S"] });
  setPrefix("Ctrl+B");
  assert.deepEqual(getBindings().read, ["Ctrl+B S"], "two keys that are one under this prefix are listed once");
  setPrefix("Ctrl+A");
  assert.deepEqual(getBindings().favorite, ["S", "Ctrl+B Q"]);
  assert.deepEqual(getBindings().read, ["Ctrl+A S", "Ctrl+B S"]);
  assert.deepEqual(stored(), before);
});

test("a stored key that starts with the stored prefix loads as it is, so a reload does not move it with the next prefix", () => {
  setKeys("read", ["Ctrl+A S", "Ctrl+B S"]);
  setPrefix("Ctrl+B");
  storedElsewhere(stored());
  setPrefix("Ctrl+A");
  assert.deepEqual(getBindings().read, ["Ctrl+A S", "Ctrl+B S"]);
  assert.deepEqual(stored(), { version: 4, read: ["<prefix> S", "Ctrl+B S"] });
});

test("editing a row keeps its other keys as stored, and reads only a key recorded now as under the prefix", () => {
  setKeys("favorite", ["S", "Ctrl+B Q"]);
  setPrefix("Ctrl+B");
  // The row's × on S, then a key recorded under the prefix.
  setKeys("favorite", ["Ctrl+B Q"]);
  setKeys("favorite", ["Ctrl+B Q", "Ctrl+B W"]);
  assert.deepEqual(stored(), { version: 4, prefix: "Ctrl+B", favorite: ["Ctrl+B Q", "<prefix> W"] });
  setPrefix("Ctrl+A");
  assert.deepEqual(getBindings().favorite, ["Ctrl+B Q", "Ctrl+A W"]);
});
