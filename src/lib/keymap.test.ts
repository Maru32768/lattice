import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTIONS,
  DEFAULT_BINDINGS,
  EX_ALIASES,
  IDLE,
  REPEAT_MS,
  actionFor,
  afterFirst,
  chordFrom,
  conflicts,
  keyLabel,
  keyOf,
  merge,
  pageKeys,
  passesOn,
  scopeOf,
  stepKeys,
  type Bindings,
  type KeyScope,
  type KeySeq,
  type KeyStep,
} from "./keymap.ts";

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
  assert.equal(keyLabel('Ctrl+A "'), 'Ctrl A › "');
  assert.equal(keyLabel("Ctrl+A X"), "Ctrl A › x");
  assert.equal(keyLabel("G Space"), "g › Space");
});

test("actionFor: defaults, several keys per action, overrides replace an action's keys, and the scope picks among a key's actions", () => {
  assert.equal(actionFor(DEFAULT_BINDINGS, "J", "list")?.id, "next");
  assert.equal(actionFor(DEFAULT_BINDINGS, "J", "doc")?.id, "scrollDown");
  assert.equal(actionFor(DEFAULT_BINDINGS, "ArrowDown", "list")?.id, "next");
  assert.equal(actionFor(DEFAULT_BINDINGS, "ArrowDown", "doc"), undefined, "the arrows scroll a document natively");
  assert.equal(actionFor(DEFAULT_BINDINGS, "Ctrl+P", "doc")?.id, "palette");
  assert.equal(actionFor(DEFAULT_BINDINGS, "Q", "list"), undefined);
  const b = merge({ next: ["N"] });
  assert.equal(actionFor(b, "N", "list")?.id, "next");
  assert.equal(actionFor(b, "J", "list"), undefined);
  assert.equal(actionFor(b, "K", "list")?.id, "prev");
});

test("the default table has no conflict, and every Ex name is a real action", () => {
  assert.deepEqual([...conflicts(DEFAULT_BINDINGS).keys()], []);
  assert.equal(new Set(ACTIONS.map((a) => a.id)).size, ACTIONS.length);
  const ids = new Set(ACTIONS.map((a) => a.id));
  assert.ok(Object.values(EX_ALIASES).every((id) => ids.has(id)));
  assert.equal(EX_ALIASES.vsplit, "splitRight");
  assert.equal(EX_ALIASES.only, EX_ALIASES.zoom);
});

test("conflicts: only where the scopes overlap, first in registry order wins", () => {
  const ids = (b: Bindings, key: string) =>
    conflicts(b)
      .get(key)
      ?.map((a) => a.id);
  assert.equal(ids(DEFAULT_BINDINGS, "J"), undefined, "next in a list, scrollDown in a document");
  const fav = merge({ favorite: ["S", "J"] });
  assert.deepEqual(ids(fav, "J"), ["favorite", "next", "scrollDown"], "an everywhere action overlaps both scopes");
  assert.equal(actionFor(fav, "J", "list")?.id, "favorite");
  const twoList = merge({ search: ["/", "D"] });
  assert.deepEqual(ids(twoList, "D"), ["search", "listHalfDown"], "the document's D does not overlap the list's two");
});

test("chordFrom and afterFirst: any first key, by scope, with what can follow it", () => {
  assert.equal(actionFor(DEFAULT_BINDINGS, 'Ctrl+A "', "list")?.id, "splitDown");
  assert.equal(actionFor(DEFAULT_BINDINGS, '"', "list"), undefined, "not without the first key");

  assert.equal(chordFrom(DEFAULT_BINDINGS, "Y", "doc")?.id, "copyUrl");
  assert.equal(chordFrom(DEFAULT_BINDINGS, "Y", "list"), undefined, "y y is the document's");
  assert.equal(chordFrom(DEFAULT_BINDINGS, "S", "doc"), undefined);

  const b = merge({ favorite: ["S", "G Q"], read: ["G Q", "G M"], splitDown: ["Ctrl+-"] });
  assert.deepEqual(
    afterFirst(b, "G", "list").filter(([id]) => id === "favorite" || id === "read"),
    [
      ["favorite", ["Q"]],
      ["read", ["M"]],
    ],
  );
  assert.ok(!afterFirst(b, "Ctrl+A", "doc").some(([id]) => id === "splitDown"), "a removed key leaves the hint");
  assert.ok(afterFirst(DEFAULT_BINDINGS, "Ctrl+A", "doc").some(([id]) => id === "visual"));
  assert.ok(!afterFirst(DEFAULT_BINDINGS, "Ctrl+A", "list").some(([id]) => id === "visual"), "the hint filters by scope");
});

test("chordFrom: a first key works in fields if any of its bindings does", () => {
  const b = merge({ favorite: ["Ctrl+G S"], newTab: ["Ctrl+G T"] });
  assert.equal(chordFrom(b, "Ctrl+G")?.id, "newTab");
});

test("scopeOf: documents and the chat log read, everything else is a list", () => {
  assert.deepEqual(["doc", "chat", "list", "nav", null, undefined].map(scopeOf), ["doc", "doc", "list", "list", "list", "list"]);
});

// ---- stepKeys -----------------------------------------------------------------------------------

const NOW = 1000;
const step = (key: string, seq: KeySeq = IDLE, o: { scope?: KeyScope; inField?: boolean; now?: number; b?: Bindings } = {}) =>
  stepKeys(o.b ?? DEFAULT_BINDINGS, seq, key, { scope: o.scope ?? "list", inField: o.inField ?? false, now: o.now ?? NOW });

/** Each key in turn, from idle. */
function press(keys: string[], o: Parameters<typeof step>[2] = {}): KeyStep {
  let seq = IDLE;
  let last: KeyStep = { kind: "none", seq };
  for (const k of keys) {
    last = step(k, seq, o);
    seq = last.seq;
  }
  return last;
}
const ran = (s: KeyStep) => (s.kind === "run" ? [s.action.id, s.count, s.sequence] : s.kind);

test("stepKeys: a single key runs its action, an unbound one is left alone", () => {
  assert.deepEqual(ran(step("J")), ["next", 1, "J"]);
  assert.equal(step("Q").kind, "none");
  assert.deepEqual(step("Q").seq, IDLE);
});

test("stepKeys: a chord's first key waits, and the second runs it", () => {
  const first = step("Ctrl+A");
  assert.equal(first.kind, "wait");
  assert.equal(first.seq.first, "Ctrl+A");
  assert.deepEqual(ran(step("X", first.seq)), ["closePane", 1, "Ctrl+A X"]);
  assert.deepEqual(step("X", first.seq).seq, IDLE);
  assert.deepEqual(ran(press(["G", "T"])), ["nextTab", 1, "G T"]);
  assert.deepEqual(ran(press(["Ctrl+A", "2"])), ["tabByNumber", 1, "Ctrl+A 2"], "a digit as the second key is no count");
});

test("stepKeys: a key that starts a chord never runs alone", () => {
  const b = merge({ favorite: ["G"] });
  assert.equal(step("G", IDLE, { b }).kind, "wait");
});

test("stepKeys: Esc and an unbound second key cancel, and are swallowed", () => {
  const first = step("Ctrl+A").seq;
  assert.equal(step("Escape", first).kind, "cancel");
  assert.deepEqual(step("Escape", first).seq, IDLE);
  assert.equal(step("Q", step("G").seq).kind, "cancel");
  assert.deepEqual(step("Q", step("G").seq).seq, IDLE);
  assert.equal(press(["5", "Escape"]).kind, "cancel", "a count on its own, too");
  assert.deepEqual(ran(step("Escape")), ["escape", 1, "Escape"], "Esc with nothing pending is an action");
});

test("stepKeys: a count multiplies a counted action and only those", () => {
  assert.equal(step("5").kind, "wait");
  assert.deepEqual(ran(press(["5", "J"])), ["next", 5, "J"]);
  assert.deepEqual(ran(press(["1", "2", "J"])), ["next", 12, "J"]);
  assert.deepEqual(ran(press(["1", "0", "J"])), ["next", 10, "J"], "0 once a count has begun");
  assert.deepEqual(ran(press(["5", "S"])), ["favorite", 1, "S"], "not counted: the count is ignored");
  assert.equal(step("0").kind, "none", "0 cannot start a count");
  assert.deepEqual(press(["5", "Q"]).seq, IDLE, "an unbound key forgets the count");
  assert.equal(press(["5", "Q"]).kind, "none");
});

test("stepKeys: a count before a chord reaches the action when it is counted", () => {
  const b = merge({ listHalfDown: ["Z Z"] });
  assert.deepEqual(ran(press(["3", "Z", "Z"], { b })), ["listHalfDown", 3, "Z Z"]);
  assert.deepEqual(ran(press(["3", "G", "G"])), ["listFirst", 1, "G G"]);
});

test("stepKeys: a digit bound where the keyboard is, is no count", () => {
  const b = merge({ favorite: ["1"], read: ["2 M"] });
  assert.deepEqual(ran(step("1", IDLE, { b })), ["favorite", 1, "1"]);
  assert.equal(step("2", IDLE, { b }).seq.first, "2", "nor a chord's first key");
  const onlyInDoc = merge({ scrollDown: ["1"] });
  assert.deepEqual(ran(step("1", IDLE, { b: onlyInDoc, scope: "doc" })), ["scrollDown", 1, "1"]);
  assert.equal(step("1", IDLE, { b: onlyInDoc, scope: "list" }).seq.count, 1, "bound only elsewhere: a count here");
});

test("stepKeys: the second key alone repeats a repeat action within the window, which each repeat extends", () => {
  const s = press(["Ctrl+A", "Shift+H"], { scope: "list" });
  assert.deepEqual(ran(s), ["paneGrowLeft", 1, "Ctrl+A Shift+H"]);
  assert.deepEqual(s.seq.repeat, { first: "Ctrl+A", until: NOW + REPEAT_MS });

  const late = NOW + REPEAT_MS - 1;
  const again = step("Shift+H", s.seq, { now: late });
  assert.deepEqual(ran(again), ["paneGrowLeft", 1, "Ctrl+A Shift+H"]);
  assert.equal(again.seq.repeat?.until, late + REPEAT_MS);
  assert.deepEqual(ran(step("Shift+L", s.seq, { now: late })), ["paneGrowRight", 1, "Ctrl+A Shift+L"], "any repeat action under the same first key");
});

test("stepKeys: past the window, or on another key, the key is read fresh", () => {
  const s = press(["Ctrl+A", "Shift+H"], { scope: "doc" });
  assert.deepEqual(ran(step("Shift+H", s.seq, { scope: "doc", now: NOW + REPEAT_MS })), ["docBack", 1, "Shift+H"], "expired");
  const other = step("J", s.seq, { scope: "doc", now: NOW + 1 });
  assert.deepEqual(ran(other), ["scrollDown", 1, "J"], "Ctrl+A J exists but does not repeat");
  assert.equal(other.seq.repeat, null);
  assert.equal(press(["Ctrl+A", "X"]).seq.repeat, null, "an action that does not repeat opens no window");
});

test("stepKeys: Ctrl+F and Ctrl+B move a screen in each scope, and Ctrl+B is no prefix", () => {
  assert.deepEqual(ran(step("Ctrl+F", IDLE, { scope: "doc" })), ["pageDown", 1, "Ctrl+F"]);
  assert.deepEqual(ran(step("Ctrl+F", IDLE, { scope: "list" })), ["listPageDown", 1, "Ctrl+F"]);
  assert.deepEqual(ran(press(["3", "Ctrl+F"], { scope: "doc" })), ["pageDown", 3, "Ctrl+F"]);
  assert.deepEqual(ran(step("Ctrl+B", IDLE, { scope: "list" })), ["listPageUp", 1, "Ctrl+B"]);
  const up = step("Ctrl+B", IDLE, { scope: "doc" });
  assert.deepEqual(ran(up), ["pageUp", 1, "Ctrl+B"]);
  assert.equal(up.seq.repeat, null, "a single key needs no repeat window");
  assert.deepEqual(ran(press(["2", "Ctrl+B"], { scope: "doc" })), ["pageUp", 2, "Ctrl+B"]);
  const grown = press(["Ctrl+A", "Shift+H"], { scope: "doc" });
  const prefix = step("Ctrl+A", grown.seq, { scope: "doc", now: NOW + 1 });
  assert.equal(prefix.kind, "wait", "in a repeat window the prefix starts a chord, as in tmux");
  assert.deepEqual(ran(step("Shift+E", prefix.seq, { scope: "doc", now: NOW + 2 })), ["paneEven", 1, "Ctrl+A Shift+E"]);
  const inPage = pageKeys(DEFAULT_BINDINGS).bindings;
  assert.deepEqual(ran(stepKeys(inPage, IDLE, "Ctrl+F", { scope: "doc", inField: false, now: NOW })), ["pageDown", 1, "Ctrl+F"], "in a page too");
  assert.deepEqual(ran(stepKeys(inPage, IDLE, "Ctrl+B", { scope: "doc", inField: false, now: NOW })), ["pageUp", 1, "Ctrl+B"]);
});

test("stepKeys: the prefix twice sends the prefix wherever the keyboard is, a field too, passing its key on", () => {
  for (const o of [{ scope: "list" as const }, { scope: "doc" as const }, { inField: true }]) {
    const s = press(["Ctrl+A", "Ctrl+A"], o);
    assert.deepEqual(ran(s), ["sendPrefix", 1, "Ctrl+A Ctrl+A"]);
    assert.equal(passesOn(s), true);
    assert.deepEqual(s.seq, IDLE, "the sequence is over");
  }
  assert.deepEqual(merge({ sendPrefix: ["<prefix> A"] }).sendPrefix, ["Ctrl+A Ctrl+A"], "its keys are fixed: another last key is no prefix to pass on");
  const inPage = pageKeys(DEFAULT_BINDINGS).bindings;
  const first = stepKeys(inPage, IDLE, "Ctrl+A", { scope: "doc", inField: true, now: NOW });
  assert.deepEqual(
    ran(stepKeys(inPage, first.seq, "Ctrl+A", { scope: "doc", inField: true, now: NOW })),
    ["sendPrefix", 1, "Ctrl+A Ctrl+A"],
    "in a page's field",
  );
});

// ---- the prefix ---------------------------------------------------------------------------------

test("merge reads <prefix> as the prefix it is given, in either key of a binding", () => {
  const b = merge({ favorite: ["S", "<prefix> S"], read: ["Ctrl+G M"] }, "Ctrl+B");
  assert.deepEqual(b.splitDown, ["Ctrl+-", 'Ctrl+B "']);
  assert.deepEqual(b.tabByNumber.slice(0, 2), ["Ctrl+B 1", "Ctrl+B 2"]);
  assert.deepEqual(b.favorite, ["S", "Ctrl+B S"], "the user's keys too");
  assert.deepEqual(b.read, ["Ctrl+G M"], "a key without it stays as it is");
  assert.deepEqual(b.sendPrefix, ["Ctrl+B Ctrl+B"], "the second key too");
});

test("the default keys clash with none of these prefixes, and a prefix bound alone becomes a first key", () => {
  for (const prefix of ["Ctrl+Space", "Alt+A", "Ctrl+B"]) {
    assert.deepEqual([...conflicts(merge({}, prefix)).keys()], [], prefix);
  }
  // A resize key as the prefix: pressed twice it is both send-prefix and that resize, which Settings flags on the resize row.
  assert.deepEqual([...conflicts(merge({}, "Ctrl+ArrowUp")).keys()], ["Ctrl+ArrowUp Ctrl+ArrowUp"]);
  assert.equal(chordFrom(DEFAULT_BINDINGS, "Ctrl+B", "doc"), undefined);
  const b = merge({}, "Ctrl+B");
  assert.ok(chordFrom(b, "Ctrl+B", "doc"), "Ctrl+B pages up no more: Settings says so on that row");
  assert.equal(chordFrom(b, "Ctrl+A", "doc"), undefined);
});

test("stepKeys with the prefix Ctrl+B: its chords run, Ctrl+A is no first key, and Ctrl+B twice sends the prefix", () => {
  const b = merge({}, "Ctrl+B");
  assert.deepEqual(ran(press(["Ctrl+B", '"'], { b })), ["splitDown", 1, 'Ctrl+B "']);
  assert.equal(step("Ctrl+A", IDLE, { b }).kind, "none");
  assert.equal(step("Ctrl+A", IDLE, { b, inField: true }).kind, "none", "a field selects all by itself");
  assert.equal(step("Ctrl+B", IDLE, { b, scope: "doc" }).kind, "wait", "no page up alone");
  for (const o of [{ b }, { b, inField: true }]) {
    const s = press(["Ctrl+B", "Ctrl+B"], o);
    assert.deepEqual(ran(s), ["sendPrefix", 1, "Ctrl+B Ctrl+B"]);
    assert.equal(passesOn(s), true);
  }
});

test("stepKeys: a plain key in a field never runs or starts a chord, even on an inFields action", () => {
  const inField = { inField: true };
  assert.equal(step("G", IDLE, inField).kind, "none", "g t runs in fields, a typed g stays typed");
  assert.equal(step("?", IDLE, inField).kind, "none");
  assert.equal(step(":", IDLE, inField).kind, "none");
  assert.equal(step("Shift+G", IDLE, inField).kind, "none");
  assert.equal(step("5", IDLE, inField).kind, "none", "no count either");
  assert.equal(step("J", IDLE, inField).kind, "none");
});

test("stepKeys: Space in a field types a space, even bound to an inFields action or as a chord's first key", () => {
  const single = merge({ keyHelp: ["?", "Space"] });
  assert.equal(step("Space", IDLE, { b: single, inField: true }).kind, "none");
  assert.deepEqual(ran(step("Space", IDLE, { b: single })), ["keyHelp", 1, "Space"], "outside a field it runs");
  const chord = merge({ palette: ["Ctrl+P", "Space P"] });
  assert.equal(step("Space", IDLE, { b: chord, inField: true }).kind, "none");
  assert.deepEqual(ran(press(["Space", "P"], { b: chord })), ["palette", 1, "Space P"]);
  assert.equal(step("Shift+Space", IDLE, { b: merge({ keyHelp: ["Shift+Space"] }), inField: true }).kind, "none");
});

test("stepKeys: Esc and modified keys in a field follow inFields", () => {
  const inField = { inField: true };
  assert.deepEqual(ran(step("Ctrl+P", IDLE, inField)), ["palette", 1, "Ctrl+P"]);
  assert.deepEqual(ran(step("Escape", IDLE, inField)), ["escape", 1, "Escape"]);
  assert.equal(step("Ctrl+D", IDLE, inField).kind, "none", "halfDown is not inFields");
  assert.equal(step("Enter", IDLE, inField).kind, "none");
  assert.equal(step("Ctrl+A", IDLE, inField).kind, "wait");
  assert.deepEqual(ran(press(["Ctrl+A", "Shift+E"], inField)), ["paneEven", 1, "Ctrl+A Shift+E"]);
  const b = merge({ favorite: ["Ctrl+A S"] });
  assert.equal(press(["Ctrl+A", "S"], { b, inField: true }).kind, "cancel", "the second key's action must run in fields too");
});

test("stepKeys: the same key means what it means in the keyboard's scope", () => {
  assert.deepEqual(ran(step("J", IDLE, { scope: "list" })), ["next", 1, "J"]);
  assert.deepEqual(ran(step("J", IDLE, { scope: "doc" })), ["scrollDown", 1, "J"]);
  assert.deepEqual(ran(press(["G", "G"], { scope: "list" })), ["listFirst", 1, "G G"]);
  assert.deepEqual(ran(press(["G", "G"], { scope: "doc" })), ["docTop", 1, "G G"]);
  assert.equal(step("ArrowDown", IDLE, { scope: "doc" }).kind, "none");
  assert.equal(press(["G", "W"], { scope: "list" }).kind, "cancel", "g w is the document's");
  assert.deepEqual(ran(press(["G", "W"], { scope: "doc" })), ["wordHints", 1, "G W"]);
});

// ---- pageKeys -----------------------------------------------------------------------------------

test("pageKeys: the page's own keys and the list's are out; the rest stepKeys reads in the doc scope", () => {
  const k = pageKeys(DEFAULT_BINDINGS);
  const inPage = (key: string, seq = IDLE, inField = false) => stepKeys(k.bindings, seq, key, { scope: "doc", inField, now: NOW });
  assert.deepEqual(ran(inPage("J")), ["scrollDown", 1, "J"]);
  assert.equal(inPage("Enter").kind, "none", "the page's");
  assert.equal(inPage("Escape").kind, "none");
  assert.equal(inPage("ArrowDown").kind, "none");
  assert.equal(inPage("Alt+ArrowLeft").kind, "none", "its history");
  assert.equal(inPage("W").kind, "none", "the overlay has its own button for a selected word");
  assert.equal(inPage("R").kind, "none");
  assert.deepEqual(ran(inPage("Ctrl+P", IDLE, true)), ["palette", 1, "Ctrl+P"], "even from a page field");
  assert.equal(inPage("J", IDLE, true).kind, "none", "typing in a page field");
});

test("pageKeys: sequences are the app's actions, first the chords' first keys", () => {
  const k = pageKeys(DEFAULT_BINDINGS);
  assert.ok(k.sequences.includes("Ctrl+P") && k.sequences.includes("Ctrl+A X") && k.sequences.includes("Shift+J"));
  assert.ok(!k.sequences.includes("J"), "a local action never reaches the app");
  assert.ok(!k.sequences.includes("G G"));
  assert.ok(!k.sequences.includes("Enter") && !k.sequences.includes("Alt+ArrowLeft"));
  assert.deepEqual(k.first.sort(), ["Ctrl+A", "G", "Y", "[", "]"]);

  const custom = pageKeys(merge({ favorite: ["G Q", "Ctrl+G S"], read: ["Enter X"], view: ["Space"], summary: ["Shift+Space Y"] }));
  assert.ok(custom.first.includes("Ctrl+G"));
  assert.ok(!custom.first.includes("Enter"), "Enter stays the page's, also as a first key");
  assert.deepEqual(custom.bindings.read, []);
  assert.deepEqual(custom.bindings.view, ["Space"], "a bound Space reaches a page, as it does the app");
  assert.deepEqual(custom.bindings.summary, ["Shift+Space Y"]);
  assert.ok(custom.first.includes("Shift+Space"), "a Space chord's first key brings the hint");
});
