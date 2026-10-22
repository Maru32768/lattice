import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const { window } = new JSDOM(`<!doctype html><body>
  <nav data-pane="nav"><button class="ni">a</button><button class="ni" disabled>b</button><button class="ni">c</button></nav>
  <div data-pane="list"></div>
  <section data-pane="doc" data-pane-id="1"></section><section data-pane="doc" data-pane-id="2"></section>
  <aside data-pane="chat"></aside></body>`);
Object.assign(globalThis, { document: window.document });
const { neighbor, paneAfter, stepNav } = await import("./panes.ts");

// nav | list | doc 1 over doc 2 | chat; jsdom lays nothing out, so each pane gets its rectangle here.
const RECTS: Record<string, [number, number, number, number]> = {
  nav: [0, 0, 200, 800], list: [200, 0, 400, 800], "doc:1": [600, 0, 600, 400], "doc:2": [600, 400, 600, 400], chat: [1200, 0, 400, 800],
};
for (const el of document.querySelectorAll<HTMLElement>("[data-pane]")) {
  const [x, y, w, h] = RECTS[el.dataset.paneId ? `doc:${el.dataset.paneId}` : el.dataset.pane!];
  el.getBoundingClientRect = () => ({ left: x, top: y, width: w, height: h }) as DOMRect;
}

const pane = (sel: string) => document.querySelector<HTMLElement>(sel)!;
const name = (el: HTMLElement | null) => (el ? el.dataset.pane + (el.dataset.paneId ? `:${el.dataset.paneId}` : "") : null);

test("paneAfter: neighbours by geometry stop at the edges, up / down reach stacked panes, o cycles", () => {
  assert.equal(name(paneAfter("L", pane("[data-pane=nav]"))), "list");
  assert.equal(name(paneAfter("ArrowLeft", pane("[data-pane=list]"))), "nav");
  assert.equal(name(paneAfter("H", pane("[data-pane=nav]"))), null);
  assert.equal(name(paneAfter("ArrowRight", pane("[data-pane=list]"))), "doc:1", "the top pane when two are stacked to the right");
  assert.equal(name(paneAfter("J", pane("[data-pane-id='1']"))), "doc:2");
  assert.equal(name(paneAfter("ArrowUp", pane("[data-pane-id='2']"))), "doc:1");
  assert.equal(name(paneAfter("K", pane("[data-pane-id='1']"))), null);
  assert.equal(name(paneAfter("L", pane("[data-pane-id='2']"))), "chat");
  assert.equal(name(paneAfter("ArrowLeft", pane("[data-pane=chat]"))), "doc:1", "the first of several candidates at the same distance");
  assert.equal(name(paneAfter("O", pane("[data-pane=chat]"))), "nav");
  assert.equal(name(paneAfter("L", null)), "nav");
  assert.equal(name(paneAfter("J", pane("[data-pane=list]"))), null, "nothing below a full-height pane");
});

test("neighbor skips panes that only touch at a corner and panes behind the start", () => {
  const a = { x: 0, y: 0, w: 100, h: 100 };
  const corner = { x: 101, y: 100, w: 100, h: 100 };
  const right = { x: 101, y: 50, w: 100, h: 100 };
  const far = { x: 300, y: 0, w: 100, h: 100 };
  assert.equal(neighbor(a, [a, corner, far, right], 1, 0), right);
  assert.equal(neighbor(a, [a, corner], 1, 0), null);
  assert.equal(neighbor(far, [a, far], -1, 0), a);
  assert.equal(neighbor(a, [a, far], -1, 0), null);
});

test("stepNav: skips disabled items and stops at both ends", () => {
  const focused = () => document.activeElement?.textContent;
  const nav = pane("[data-pane=nav]");
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
