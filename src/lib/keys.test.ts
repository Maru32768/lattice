import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// A window with storage, so the store saves where a test can read it and loads on a storage event as in the app.
const { window } = new JSDOM("", { url: "http://localhost/" });
Object.assign(globalThis, { window, localStorage: window.localStorage });

const { ACTIONS, DEFAULT_BINDINGS, PREFIX } = await import("./keymap.ts");
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
  // Ctrl+Enter sends a text field (the chat, a note) and Esc leaves one, which read them before the app could; Windows takes Ctrl+Esc and Alt+Esc.
  for (const prefix of ["J", "Escape", "Shift+J", "Ctrl+B X", "Ctrl+Enter", "Ctrl+Shift+Enter", "Alt+Enter", "Ctrl+Escape", "Alt+Escape", 3, null]) {
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

test("editing a row keeps every stored key the row shows as one, and a literal key that looks like a default under this prefix stays a change", () => {
  // Two stored keys that are one under Ctrl+B: adding a key keeps both.
  setPrefix("Ctrl+B");
  setKeys("paneNumbers", [...getBindings().paneNumbers, "Ctrl+A Q"]);
  setPrefix("Ctrl+A");
  setKeys("paneNumbers", [...getBindings().paneNumbers, "M"]);
  assert.deepEqual(stored(), { version: 4, paneNumbers: ["<prefix> Q", "Ctrl+A Q", "M"] });
  replaceKeys(DEFAULTS);
  // A literal Ctrl+B Q, which is paneNumbers' default under Ctrl+B: adding and removing a key there leaves it a change.
  setKeys("paneNumbers", ["Ctrl+B Q"]);
  setPrefix("Ctrl+B");
  setKeys("paneNumbers", [...getBindings().paneNumbers, "Ctrl+B W"]);
  setKeys(
    "paneNumbers",
    getBindings().paneNumbers.filter((k) => k !== "Ctrl+B W"),
  );
  assert.deepEqual(stored(), { version: 4, prefix: "Ctrl+B", paneNumbers: ["Ctrl+B Q"] });
  setPrefix("Ctrl+A");
  assert.deepEqual(getBindings().paneNumbers, ["Ctrl+B Q"]);
});

test("a stored key with <prefix> as its second key or alone keeps that form when its row changes", () => {
  replaceKeys({ prefix: "Ctrl+A", overrides: { favorite: ["G <prefix>", "<prefix>", "S"] } });
  setKeys(
    "favorite",
    getBindings().favorite.filter((k) => k !== "S"),
  );
  assert.deepEqual(stored(), { version: 4, favorite: ["G <prefix>", "<prefix>"] });
});

test("random edits in Settings never lose a stored key, and a prefix round trip, Undo, Load and a reload change nothing", () => {
  const rows = ["paneNumbers", "favorite", "read", "closeTab"] as const;
  const prefixes = ["Ctrl+A", "Ctrl+B", "Alt+A", "Ctrl+W"];
  let seed = 0;
  // mulberry32: a plain LCG's low bits cycle, and the steps came out correlated.
  const rnd = (n: number) => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
  const pick = <T>(xs: readonly T[]) => xs[rnd(xs.length)];
  const own = (id: string) => (stored() as Record<string, string[] | undefined>)[id] ?? ACTIONS.find((a) => a.id === id)!.keys;
  // Compared as values: a stored value is the same whatever order its actions are written in.
  const snap = () => structuredClone({ prefix: getPrefix(), stored: stored(), bindings: getBindings() });
  for (let run = 0; run < 300; run++) {
    seed = run + 1;
    replaceKeys(DEFAULTS);
    const steps: string[] = [];
    for (let step = 0; step < 14; step++) {
      const id = pick(rows);
      const prefix = getPrefix();
      const shown = getBindings()[id];
      const had = own(id);
      const before = snap();
      const op = rnd(8);
      const at = () => `${steps.join(" | ")} (run ${run})`;
      if (op <= 2) {
        // As Settings records a key: one not on the row yet, added to what the row shows.
        const key = rnd(4) ? `${pick(prefixes)} ${pick(["Q", "S", "W", "Ctrl+A", "Ctrl+B"])}` : pick(["S", "M", "Ctrl+B", "G Ctrl+A"]);
        steps.push(`record ${id} ${key}`);
        if (!shown.includes(key)) {
          setKeys(id, [...shown, key]);
          assert.deepEqual(getBindings()[id], [...shown, key], at());
          had.forEach((k) => assert.ok(own(id).includes(k), `${at()}: lost ${k}`));
        }
      } else if (op === 3 && shown.length) {
        const key = pick(shown);
        steps.push(`× ${id} ${key}`);
        setKeys(
          id,
          shown.filter((k) => k !== key),
        );
        had.filter((k) => k.replaceAll(PREFIX, prefix) !== key).forEach((k) => assert.ok(own(id).includes(k), `${at()}: lost ${k}`));
      } else if (op === 4) {
        const next = pick(prefixes);
        steps.push(`prefix ${next} and back`);
        setPrefix(next);
        setPrefix(prefix);
        assert.deepEqual(snap(), before, at());
        if (rnd(2)) {
          setPrefix(next);
        }
      } else if (op === 5) {
        steps.push("reset all, undo");
        replaceKeys(replaceKeys(DEFAULTS));
        assert.deepEqual(snap(), before, at());
      } else if (op === 6) {
        steps.push("export, load");
        const file = shortcutsFile();
        replaceKeys(DEFAULTS);
        replaceKeys(parseShortcutsFile(file)!);
        assert.deepEqual(snap(), before, at());
      } else {
        steps.push("reload");
        storedElsewhere(stored());
        assert.deepEqual(snap(), before, at());
      }
      for (const r of rows) {
        assert.equal(isCustom(r), Object.hasOwn(stored() as object, r), `${at()}: changed mark of ${r}`);
        assert.equal(new Set(getBindings()[r]).size, getBindings()[r].length, `${at()}: ${r} shows a key twice`);
      }
    }
  }
});
