// Dragging tabs between windows (design-review §26) over the mock: this page is the main window;
// other windows exist only as the strip geometry a spec sends it and the events it sends them.
import { test, expect, list, callsOf } from "./harness.ts";
import { ARTICLES } from "./fixtures.ts";
import type { Page } from "@playwright/test";

const [a, b, c] = ARTICLES;
const row = (page: Page, title: string) => list(page).locator(".row", { hasText: title });
const tabs = (page: Page) => page.locator(".dpane").first().getByRole("tab");
const titles = (page: Page) => tabs(page).locator(".tab-t");
/** The events this window sent to other windows, oldest first. */
const sent = async (page: Page, event: string) =>
  (await callsOf(page, "plugin:event|emit_to") as { target: { label: string }; event: string; payload: unknown }[])
    .filter((e) => e.event === event).map((e) => [e.target.label, e.payload]);

async function twoTabs(app: Page) {
  await row(app, a.title!).click();
  await row(app, b.title!).click({ modifiers: ["Control"] });
  await expect(titles(app)).toHaveText([a.title!, b.title!]);
  const box = (await tabs(app).nth(1).boundingBox())!;
  await app.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await app.mouse.down();
  await app.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2, { steps: 3 });
  await expect(app.locator(".tab-ghost .tab-t")).toHaveText(b.title!);
  return box;
}

test("a tab dropped away from every strip tears off into a new window under the pointer", async ({ app }) => {
  const box = await twoTabs(app);
  await app.mouse.move(box.x + 200, box.y + 300, { steps: 4 });
  await app.mouse.up();
  await expect(titles(app)).toHaveText([a.title!]);
  await expect(app.locator(".tab-ghost")).toHaveCount(0);
  expect(await callsOf(app, "open_window")).toEqual([{ label: "doc-1", at: { x: box.x + 200, y: box.y + 300 } }]);
  expect(JSON.parse((await app.evaluate(() => localStorage.getItem("lattice.window.doc-1")))!)).toMatchObject({ root: { tabs: [{ kind: "reader", articleId: b.id }] } });
});

test("a tab dropped on another window's strip is sent there, marked at its slot while over it", async ({ app }) => {
  await twoTabs(app);
  // A document window to the right of this one, at double scale, with one tab whose center is at client x 60.
  await app.evaluate((x) => window.__e2e.emit("tab-strips", { label: "doc-1", x, y: 0, width: 800, height: 600, scale: 2, strips: [{ pane: 1, x: 0, y: 32, width: 400, height: 34, mids: [60] }] }), 1440);
  // Physical (1640, 100) is its client (100, 50): on the strip, past the tab's center.
  await app.mouse.move(1440 + 200, 100, { steps: 4 });
  await expect.poll(async () => (await sent(app, "tab-drag-over")).at(-1)).toEqual(["doc-1", { pane: 1, index: 1 }]);
  await app.mouse.move(1440 + 40, 100, { steps: 2 });
  await expect.poll(async () => (await sent(app, "tab-drag-over")).at(-1)).toEqual(["doc-1", { pane: 1, index: 0 }]);
  await app.mouse.up();
  await expect(titles(app)).toHaveText([a.title!]);
  expect(await sent(app, "main-request")).toEqual([["doc-1", { kind: "open", docs: [{ kind: "reader", articleId: b.id }], at: { pane: 1, index: 0 } }]]);
  expect((await sent(app, "tab-drag-over")).at(-1), "the marker is cleared").toEqual(["doc-1", null]);
  expect(await callsOf(app, "open_window")).toEqual([]);
});

test("a window marks the slot another window's drag is over, and opens what is dropped there at that slot", async ({ app }) => {
  await row(app, a.title!).click();
  await row(app, b.title!).click({ modifiers: ["Control"] });
  await app.evaluate(() => window.__e2e.emit("tab-drag-over", { pane: 1, index: 1 }));
  await expect(tabs(app).nth(1)).toHaveClass(/drop-before/);
  await app.evaluate(() => window.__e2e.emit("tab-drag-over", null));
  await expect(tabs(app).nth(1)).not.toHaveClass(/drop-before/);

  await app.evaluate((id) => window.__e2e.emit("main-request", { kind: "open", docs: [{ kind: "reader", articleId: id }], at: { pane: 1, index: 0 } }), c.id);
  await expect(titles(app)).toHaveText([c.title!, a.title!, b.title!]);
  await expect(tabs(app).nth(0)).toHaveAttribute("aria-selected", "true");
});

test("a document window takes a tab dropped on it too", async ({ shell }) => {
  await shell.addInitScript((k) => localStorage.setItem(k, JSON.stringify({ root: { kind: "pane", id: 1, tabs: [{ kind: "reader", id: 2, articleId: 1 }], active: 2 }, focused: 1 })), "lattice.window.doc-1");
  await shell.goto("/?window=doc-1");
  await expect(shell.locator(".art-title")).toHaveText(a.title!);
  await shell.evaluate((id) => window.__e2e.emit("main-request", { kind: "open", docs: [{ kind: "reader", articleId: id }], at: { pane: 1, index: 0 } }), b.id);
  await expect(titles(shell)).toHaveText([b.title!, a.title!]);
});
