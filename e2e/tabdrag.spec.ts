// Dragging tabs between windows (design-review §26) over the mock. The backend runs the drag and
// tells windows what to do through events; the specs send those events and check what this page
// (the main window, or a pop-out with `?window=`) does and asks of the backend.
import { test, expect, list, callsOf } from "./harness.ts";
import { ARTICLES } from "./fixtures.ts";
import type { Page } from "@playwright/test";

const [a, b, c] = ARTICLES;
const row = (page: Page, title: string) => list(page).locator(".row", { hasText: title });
const tabs = (page: Page) => page.locator(".dpane").first().getByRole("tab");
const titles = (page: Page) => tabs(page).locator(".tab-t");
const emit = (page: Page, event: string, payload: unknown = null) => page.evaluate(([e, p]) => window.__e2e.emit(e as string, p), [event, payload]);
/** The tabs this window handed to other windows during a drag (`tab-drag-take`), oldest first. */
const sentTabs = async (page: Page) =>
  ((await callsOf(page, "plugin:event|emit_to")) as { target: { label: string }; event: string; payload: unknown }[])
    .filter((e) => e.event === "tab-drag-take")
    .map((e) => [e.target.label, e.payload]);

async function openTwo(app: Page) {
  await row(app, a.title!).click();
  await row(app, b.title!).click({ modifiers: ["Control"] });
  await expect(titles(app)).toHaveText([a.title!, b.title!]);
}

/** Presses the second tab and moves it past the click threshold; the button stays down. */
async function dragSecond(app: Page) {
  const box = (await tabs(app).nth(1).boundingBox())!;
  await app.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await app.mouse.down();
  await app.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2, { steps: 3 });
  return box;
}

test("a drag starts in the backend with the tab, its slot and this window's strips, and ends when the backend says so", async ({ app }) => {
  await openTwo(app);
  await tabs(app).first().click();
  const box = await dragSecond(app);
  await expect(tabs(app).nth(1), "the dragged tab shows its content").toHaveAttribute("aria-selected", "true");
  await expect(tabs(app).nth(1)).toHaveClass(/held/);
  await expect(app.locator(".tab-ghost"), "no ghost: the tab stays in its strip").toHaveCount(0);
  const [start] = (await callsOf(app, "tab_drag_start")) as { start: { width: number; geom: { strips: { tabs: number[][]; held: number }[] } } }[];
  expect(start).toMatchObject({
    start: { pane: 1, index: 1, alone: false, geom: { label: "main", x: 0, y: 0, scale: 1 } },
  });
  expect(start.start.width).toBeCloseTo(box.width, 0);
  expect(start.start.geom.strips[0].tabs).toHaveLength(2);
  expect(start.start.geom.strips[0].held, "which tab is dragged").toBe(1);

  await app.keyboard.press("Escape");
  await app.mouse.up();
  expect(await callsOf(app, "tab_drag_release")).toEqual([{ cancel: true }, { cancel: false }]);
  await emit(app, "tab-drag-end");
  await expect(tabs(app).nth(1)).not.toHaveClass(/held/);
  await expect(titles(app), "nothing moved: the backend did not say where").toHaveText([a.title!, b.title!]);
});

test("the dragged tab follows the cursor along its strip where the backend says, kept within the tabs", async ({ app }) => {
  await openTwo(app);
  await dragSecond(app);
  const second = tabs(app).nth(1);
  const at = (await second.boundingBox())!.x;
  const strip = (await app.locator(".dpane .tabs").first().boundingBox())!;
  await emit(app, "tab-drag-slide", { pane: 1, x: at - strip.x - 30 });
  await expect.poll(async () => (await second.boundingBox())!.x).toBeCloseTo(at - 30, 0);
  await emit(app, "tab-drag-slide", { pane: 1, x: -500 });
  const first = (await tabs(app).first().boundingBox())!.x;
  await expect.poll(async () => (await second.boundingBox())!.x, "not past the first tab").toBeCloseTo(first, 0);
  await emit(app, "tab-drag-slide", null);
  await expect.poll(async () => (await second.boundingBox())!.x, "back in its slot").toBeCloseTo(at, 0);
  await app.mouse.up();
  await emit(app, "tab-drag-end");
});

test("the window a drag started in marks the slot it is told", async ({ app }) => {
  await openTwo(app);
  await emit(app, "tab-drag-over", { pane: 1, index: 1 });
  await expect(tabs(app).nth(1)).toHaveClass(/drop-before/);
  await emit(app, "tab-drag-over", { pane: 1, index: 2 });
  await expect(tabs(app).nth(1)).toHaveClass(/drop-after/);
  await emit(app, "tab-drag-end");
  await expect(app.locator(".tab.drop-before, .tab.drop-after")).toHaveCount(0);
});

test("every window reports its strips while any window drags, and again when its tabs change", async ({ app }) => {
  await openTwo(app);
  const reported = async () =>
    ((await callsOf(app, "tab_drag_strips")) as { geom: { label: string; strips: { tabs: number[][] }[] } }[]).map((r) => r.geom.strips[0].tabs.length);
  await emit(app, "tab-drag-start");
  await expect.poll(reported).toEqual([2]);
  await row(app, c.title!).click({ modifiers: ["Control"] });
  await expect.poll(reported).toEqual([2, 3]);
  await emit(app, "tab-drag-end");
  await titles(app).first().click();
  await row(app, a.title!).click({ modifiers: ["Control"] });
  await expect(titles(app)).toHaveCount(4);
  expect(await reported()).toEqual([2, 3]);
});

test("torn off, the tab leaves for a new document window that the backend creates and places", async ({ app }) => {
  await openTwo(app);
  await dragSecond(app);
  await emit(app, "tab-drag-tear");
  await expect(titles(app)).toHaveText([a.title!]);
  expect(await callsOf(app, "tab_drag_float")).toEqual([{ label: "doc-1" }]);
  expect(await callsOf(app, "open_window")).toEqual([]);
  expect(JSON.parse((await app.evaluate(() => localStorage.getItem("lattice.window.doc-1")))!)).toMatchObject({
    root: { tabs: [{ kind: "reader", articleId: b.id }] },
  });
  await app.mouse.up();
  await emit(app, "tab-drag-end");
});

test("the window holding the tab moves it in its own strips or hands it to the slot in another window", async ({ app }) => {
  await openTwo(app);
  await dragSecond(app);
  await emit(app, "tab-drag-drop", { label: "main", pane: 1, index: 0 });
  await expect(titles(app)).toHaveText([b.title!, a.title!]);
  await app.mouse.up();
  await emit(app, "tab-drag-end");

  await dragSecond(app);
  await emit(app, "tab-drag-drop", { label: "doc-1", pane: 1, index: 0 });
  await expect(titles(app)).toHaveText([b.title!]);
  await expect(app.locator(".tab.held"), "the tab is no longer here").toHaveCount(0);
  expect(await sentTabs(app)).toEqual([["doc-1", { doc: { kind: "reader", articleId: a.id }, at: { pane: 1, index: 0 } }]]);
  await app.mouse.up();
  await emit(app, "tab-drag-end");
});

test("a tab handed to this window during a drag opens at its slot at once, and the window says when it has it", async ({ app }) => {
  await openTwo(app);
  await emit(app, "tab-drag-start");
  await emit(app, "tab-drag-take", { doc: { kind: "reader", articleId: c.id }, at: { pane: 1, index: 1 } });
  await expect(titles(app)).toHaveText([a.title!, c.title!, b.title!]);
  await expect(tabs(app).nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(app.locator(".art-title"), "its content, not only its tab").toHaveText(c.title!);
  await expect.poll(() => callsOf(app, "tab_drag_held")).toHaveLength(1);

  await emit(app, "tab-drag-drop", { label: "main", pane: 1, index: 3 });
  await expect(titles(app), "later moves are of that tab").toHaveText([a.title!, b.title!, c.title!]);
  await emit(app, "tab-drag-drop", { label: "doc-2" });
  await expect(titles(app)).toHaveText([a.title!, b.title!]);
  expect(await sentTabs(app)).toEqual([["doc-2", { doc: { kind: "reader", articleId: c.id } }]]);
  await emit(app, "tab-drag-end");
});

test("split into panes, a tab dropped on the other pane's strip moves there, and an empty strip marks the slot", async ({ app }) => {
  await openTwo(app);
  await app.getByRole("button", { name: "右に分割" }).click();
  const panes = app.locator(".dpane");
  await expect(panes).toHaveCount(2);
  const right = Number(await panes.nth(1).getAttribute("data-pane-id"));
  await dragSecond(app);
  const [start] = (await callsOf(app, "tab_drag_start")) as { start: { geom: { strips: { pane: number }[] } } }[];
  expect(
    start.start.geom.strips.map((s) => s.pane),
    "both strips are reported",
  ).toEqual([1, right]);

  await emit(app, "tab-drag-over", { pane: right, index: 0 });
  await expect(panes.nth(1).locator(".tab-mark")).toHaveCount(1);
  await emit(app, "tab-drag-drop", { label: "main", pane: right, index: 0 });
  await expect(panes.nth(0).locator(".tab-t")).toHaveText([a.title!]);
  await expect(panes.nth(1).locator(".tab-t")).toHaveText([b.title!]);
  await app.mouse.up();
  await emit(app, "tab-drag-end");
  await expect(app.locator(".tab-mark")).toHaveCount(0);
});

/** Opens a and b in the first pane and c in a pane split off to its right; returns that pane's id. */
async function splitThree(app: Page) {
  await openTwo(app);
  await app.getByRole("button", { name: "右に分割" }).click();
  await row(app, c.title!).click();
  const panes = app.locator(".dpane");
  await expect(panes.nth(1).locator(".tab-t")).toHaveText([c.title!]);
  return Number(await panes.nth(1).getAttribute("data-pane-id"));
}

test("split into panes, the window reports each pane's body under its strip, and draws the zone a drag is over", async ({ app }) => {
  const right = await splitThree(app);
  const panes = app.locator(".dpane");
  await dragSecond(app);
  const [start] = (await callsOf(app, "tab_drag_start")) as {
    start: { geom: { strips: { pane: number; y: number; height: number; body: { x: number; y: number; width: number; height: number } }[] } };
  }[];
  const pane = (await panes.nth(1).boundingBox())!;
  const strip = start.start.geom.strips.find((s) => s.pane === right)!;
  expect(strip.body.y).toBeCloseTo(strip.y + strip.height, 0);
  expect(strip.body.x).toBeCloseTo(pane.x, 0);
  expect(strip.body.width).toBeCloseTo(pane.width, 0);
  expect(strip.body.y + strip.body.height).toBeCloseTo(pane.y + pane.height, 0);

  const zone = panes.nth(1).locator(".drop-zone");
  await emit(app, "tab-drag-over", { pane: right, zone: "center" });
  await expect(zone).toHaveClass(/center/);
  const whole = (await zone.boundingBox())!;
  expect(whole.y).toBeCloseTo(strip.body.y, 0);
  expect(whole.height).toBeCloseTo(strip.body.height, 0);
  await emit(app, "tab-drag-over", { pane: right, zone: "right" });
  const half = (await zone.boundingBox())!;
  expect(half.width).toBeCloseTo(whole.width / 2, 0);
  expect(half.x + half.width).toBeCloseTo(whole.x + whole.width, 0);
  await expect(panes.nth(1).locator(".tab.drop-before, .tab.drop-after"), "no strip marker").toHaveCount(0);
  await emit(app, "tab-drag-over", null);
  await expect(app.locator(".drop-zone")).toHaveCount(0);
  await app.mouse.up();
  await emit(app, "tab-drag-end");
});

test("dropped on another pane's center the tab joins that pane; on an edge it splits that pane and takes the new one", async ({ app }) => {
  const right = await splitThree(app);
  const panes = app.locator(".dpane");
  await dragSecond(app);
  await emit(app, "tab-drag-drop", { label: "main", pane: right, zone: "center" });
  await expect(panes.nth(0).locator(".tab-t")).toHaveText([a.title!]);
  await expect(panes.nth(1).locator(".tab-t")).toHaveText([c.title!, b.title!]);
  await expect(panes.nth(1).getByRole("tab", { name: b.title! })).toHaveAttribute("aria-selected", "true");
  await app.mouse.up();
  await emit(app, "tab-drag-end");

  const box = (await panes.nth(1).getByRole("tab").nth(1).boundingBox())!;
  await app.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await app.mouse.down();
  await app.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2, { steps: 3 });
  await emit(app, "tab-drag-drop", { label: "main", pane: right, zone: "bottom" });
  await expect(panes).toHaveCount(3);
  await expect(panes.nth(1).locator(".tab-t")).toHaveText([c.title!]);
  await expect(panes.nth(2).locator(".tab-t")).toHaveText([b.title!]);
  await expect(panes.nth(2)).toHaveClass(/focused/);
  await expect(app.getByRole("separator", { name: "ペインの高さ" }), "split down").toBeVisible();
  await app.mouse.up();
  await emit(app, "tab-drag-end");
});

test("a pop-out split into panes moves a tab between them the same way", async ({ shell }) => {
  const split = {
    root: {
      kind: "split",
      id: 9,
      dir: "row",
      sizes: [0.5, 0.5],
      children: [
        {
          kind: "pane",
          id: 1,
          active: 2,
          tabs: [
            { kind: "reader", id: 2, articleId: a.id },
            { kind: "reader", id: 3, articleId: b.id },
          ],
        },
        { kind: "pane", id: 4, active: 5, tabs: [{ kind: "reader", id: 5, articleId: c.id }] },
      ],
    },
    focused: 1,
  };
  await shell.addInitScript(([k, v]) => localStorage.setItem(k, v), ["lattice.window.doc-1", JSON.stringify(split)]);
  await shell.goto("/?window=doc-1");
  const panes = shell.locator(".dpane");
  await expect(panes.nth(1).locator(".tab-t")).toHaveText([c.title!]);
  await dragSecond(shell);
  await expect.poll(() => callsOf(shell, "tab_drag_start")).toHaveLength(1);
  await emit(shell, "tab-drag-over", { pane: 4, zone: "left" });
  await expect(panes.nth(1).locator(".drop-zone.left")).toHaveCount(1);
  await emit(shell, "tab-drag-drop", { label: "doc-1", pane: 4, zone: "left" });
  await expect(panes).toHaveCount(3);
  await expect(panes.nth(1).locator(".tab-t")).toHaveText([b.title!]);
  await emit(shell, "tab-drag-drop", { label: "doc-1", pane: 4, index: 0 });
  await expect(panes, "its emptied pane is gone").toHaveCount(2);
  await expect(panes.nth(1).locator(".tab-t"), "then onto the other pane's strip").toHaveText([b.title!, c.title!]);
  await shell.mouse.up();
  await emit(shell, "tab-drag-end");
});

test("a window opens what is dropped on it at that slot", async ({ app }) => {
  await openTwo(app);
  await emit(app, "main-request", { kind: "open", docs: [{ kind: "reader", articleId: c.id }], at: { pane: 1, index: 0 } });
  await expect(titles(app)).toHaveText([c.title!, a.title!, b.title!]);
  await expect(tabs(app).nth(0)).toHaveAttribute("aria-selected", "true");
});

test("a document window dragged by its only tab follows the cursor itself; a torn-off window drops its only tab", async ({ shell }) => {
  await shell.addInitScript(
    (k) => localStorage.setItem(k, JSON.stringify({ root: { kind: "pane", id: 1, tabs: [{ kind: "reader", id: 2, articleId: 1 }], active: 2 }, focused: 1 })),
    "lattice.window.doc-1",
  );
  await shell.goto("/?window=doc-1");
  await expect(shell.locator(".art-title")).toHaveText(a.title!);
  expect((await callsOf(shell, "window_ready")).length, "shown once its UI is up").toBeGreaterThan(0);
  await shell.evaluate((id) => window.__e2e.emit("main-request", { kind: "open", docs: [{ kind: "reader", articleId: id }], at: { pane: 1, index: 0 } }), b.id);
  await expect(titles(shell)).toHaveText([b.title!, a.title!]);
  await tabs(shell).first().locator(".x").click();
  await expect(titles(shell)).toHaveText([a.title!]);

  const box = (await tabs(shell).first().boundingBox())!;
  await shell.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await shell.mouse.down();
  await shell.mouse.move(box.x + box.width / 2 + 12, box.y + 40, { steps: 3 });
  await expect
    .poll(() => callsOf(shell, "tab_drag_start"))
    .toEqual([expect.objectContaining({ start: expect.objectContaining({ alone: true, pane: 1, index: 0 }) })]);
  await expect(tabs(shell).first(), "the window carries its tab: it does not slide in its strip").not.toHaveClass(/held/);
  await shell.mouse.up();
  await emit(shell, "tab-drag-end");

  // A torn-off window has no drag of its own: told where the tab goes, it sends its only tab.
  await emit(shell, "tab-drag-drop", { label: "main", pane: 1, index: 2 });
  expect(await sentTabs(shell)).toEqual([["main", { doc: { kind: "reader", articleId: a.id }, at: { pane: 1, index: 2 } }]]);
  await shell.waitForTimeout(300);
  expect(await callsOf(shell, "close_window"), "kept while the drag may bring the tab back").toHaveLength(0);
  await emit(shell, "tab-drag-take", { doc: { kind: "reader", articleId: a.id } });
  await expect(titles(shell), "back in its window").toHaveText([a.title!]);
  await emit(shell, "tab-drag-drop", { label: "main", pane: 1, index: 2 });
  await emit(shell, "tab-drag-end");
  await expect.poll(() => callsOf(shell, "close_window"), "empty when the drag ended").toHaveLength(1);
});
