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
const { savePref } = await import("./prefs.ts");

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
