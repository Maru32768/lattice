import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const { window } = new JSDOM(`<!doctype html><body>
  <nav data-pane="nav"><button class="ni">a</button><button class="ni" disabled>b</button><button class="ni">c</button></nav>
  <div data-pane="list"></div><div data-pane="doc"></div></body>`);
Object.assign(globalThis, { document: window.document });
const { paneAfter, stepNav } = await import("./panes.ts");

const pane = (name: string) => document.querySelector<HTMLElement>(`[data-pane="${name}"]`)!;
const name = (el: HTMLElement | null) => el?.dataset.pane ?? null;

test("paneAfter: neighbours stop at the edges, o cycles, nothing focused starts at the first pane", () => {
  assert.equal(name(paneAfter("L", pane("nav"))), "list");
  assert.equal(name(paneAfter("ArrowLeft", pane("list"))), "nav");
  assert.equal(name(paneAfter("ArrowRight", pane("doc"))), null);
  assert.equal(name(paneAfter("H", pane("nav"))), null);
  assert.equal(name(paneAfter("O", pane("doc"))), "nav");
  assert.equal(name(paneAfter("L", null)), "nav");
  assert.equal(name(paneAfter("J", pane("list"))), null, "nothing above or below");
});

test("stepNav: skips disabled items and stops at both ends", () => {
  const focused = () => document.activeElement?.textContent;
  const nav = pane("nav");
  stepNav(nav, 1);
  assert.equal(focused(), "a", "nothing focused: the first item");
  stepNav(nav, 1);
  assert.equal(focused(), "c");
  stepNav(nav, 1);
  assert.equal(focused(), "c");
  stepNav(nav, -1);
  stepNav(nav, -1);
  assert.equal(focused(), "a");
});
