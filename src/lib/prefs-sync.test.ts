// syncPrefs and savePref against a stub of Tauri's invoke and of localStorage. prefs.ts reaches both through globals,
// so they are set before it is imported.
import { test } from "node:test";
import assert from "node:assert/strict";

type Handler = (cmd: string, args: unknown) => Promise<unknown>;
const cache = new Map<string, string>();
let handler: Handler = () => Promise.resolve(null);
Object.assign(globalThis, {
  window: globalThis,
  dispatchEvent: () => true,
  localStorage: {
    getItem: (k: string) => cache.get(k) ?? null,
    setItem: (k: string, v: string) => void cache.set(k, v),
    removeItem: (k: string) => void cache.delete(k),
  },
  StorageEvent: class extends Event {},
  __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => handler(cmd, args) },
});
const { savePref, syncPrefs } = await import("./prefs.ts");

const tick = () => new Promise((r) => setTimeout(r, 0));

test("writes go to the library one at a time, in the order they were made", async () => {
  const sent: unknown[] = [];
  const pending: (() => void)[] = [];
  handler = (cmd, args) => {
    sent.push({ cmd, args });
    return new Promise<void>((r) => pending.push(r));
  };
  savePref("lattice.vocabMarks", "off");
  savePref("lattice.vocabMarks", "on");
  await tick();
  assert.deepEqual(sent, [{ cmd: "set_ui_prefs", args: { prefs: { "lattice.vocabMarks": "off" } } }], "the second waits for the first");
  pending.shift()!();
  await tick();
  assert.deepEqual(sent.at(-1), { cmd: "set_ui_prefs", args: { prefs: { "lattice.vocabMarks": "on" } } });
  pending.shift()!();
  await tick();
  assert.equal(cache.get("lattice.vocabMarks"), "on");
});

test("a write that fails does not stop the ones after it", async () => {
  const sent: unknown[] = [];
  handler = (_cmd, args) => {
    sent.push(args);
    return sent.length === 1 ? Promise.reject(new Error("disk full")) : Promise.resolve(null);
  };
  savePref("lattice.vocabAutoplay", "off");
  savePref("lattice.vocabAutoplay", "on");
  await tick();
  await tick();
  assert.deepEqual(sent, [{ prefs: { "lattice.vocabAutoplay": "off" } }, { prefs: { "lattice.vocabAutoplay": "on" } }]);
});

test("a setting changed while the start-up sync waits for the rows keeps its change, in the cache and the library", async () => {
  cache.clear();
  cache.set("lattice.shortcuts", "old");
  cache.set("lattice.vocabMarks", "off");
  cache.set("lattice.vimrc", "cached");
  const sent: unknown[] = [];
  let release: (rows: Record<string, string>) => void = () => {};
  handler = (cmd, args) => {
    if (cmd === "get_ui_prefs") {
      return new Promise((r) => (release = r));
    }
    sent.push(args);
    return Promise.resolve(null);
  };
  const sync = syncPrefs();
  savePref("lattice.shortcuts", "new");
  savePref("lattice.vocabMarks", "on");
  release({ "lattice.shortcuts": "row", "lattice.vimrc": "library" });
  await sync;
  await tick();
  assert.equal(cache.get("lattice.shortcuts"), "new", "the row does not undo the change made meanwhile");
  assert.equal(cache.get("lattice.vocabMarks"), "on");
  assert.equal(cache.get("lattice.vimrc"), "library", "a key left alone takes the row");
  assert.deepEqual(sent, [{ prefs: { "lattice.shortcuts": "new" } }, { prefs: { "lattice.vocabMarks": "on" } }], "nothing but the changes went to the library");
});

test("a change made after the start-up sync's plan waits for the copy it sends", async () => {
  cache.clear();
  cache.set("lattice.vimrc", "cached");
  const sent: unknown[] = [];
  const pending: (() => void)[] = [];
  handler = (cmd, args) => {
    if (cmd === "get_ui_prefs") {
      return Promise.resolve({});
    }
    sent.push(args);
    return new Promise<void>((r) => pending.push(r));
  };
  const sync = syncPrefs();
  await tick();
  savePref("lattice.vimrc", "new");
  await tick();
  assert.deepEqual(sent, [{ prefs: { "lattice.vimrc": "cached" } }], "the change waits for the copy");
  pending.shift()!();
  await sync;
  await tick();
  assert.deepEqual(sent.at(-1), { prefs: { "lattice.vimrc": "new" } }, "and lands after it");
  pending.shift()!();
});
