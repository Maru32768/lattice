import { test } from "node:test";
import assert from "node:assert/strict";
import { hostOf, nextDocLabel, openWindows, pageLangOnStart, windowKey } from "./windows.ts";

test("a window's label says what it shows; anything unexpected is the main shell", () => {
  assert.deepEqual(hostOf("main"), { kind: "main" });
  assert.deepEqual(hostOf("doc-3"), { kind: "doc", label: "doc-3" });
  assert.deepEqual(hostOf("chat"), { kind: "chat" });
  assert.deepEqual(hostOf("doc-"), { kind: "main" });
  assert.deepEqual(hostOf("browser-abc"), { kind: "main" });
});

test("open pop-outs are the window keys in storage; the next document window takes the lowest free number", () => {
  const keys = ["lattice.layout", windowKey("doc-2"), "lattice.window.junk", windowKey("chat"), "lattice.shortcuts"];
  assert.deepEqual(openWindows(keys), ["doc-2", "chat"]);
  assert.equal(nextDocLabel([]), "doc-1");
  assert.equal(nextDocLabel(["doc-1", "doc-3", "chat"]), "doc-2");
});

test("only the main window sends the shared overlay config; a document window takes main's Page language", () => {
  assert.equal(pageLangOnStart(hostOf("main")), "send");
  assert.equal(pageLangOnStart(hostOf("doc-1")), "ask");
  assert.equal(pageLangOnStart(hostOf("chat")), "none");
});
