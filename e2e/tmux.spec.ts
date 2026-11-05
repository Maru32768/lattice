// The tmux pane operations: what their keys do to the panes, and to the page webviews drawn over them.
import { test, expect, list, listRow, callsOf } from "./harness.ts";
import { ARTICLES } from "./fixtures.ts";
import type { Page } from "@playwright/test";

const order = [...ARTICLES].sort((a, b) => b.saved_at.localeCompare(a.saved_at) || b.id - a.id);
const label = (i: number) => order[i].title ?? order[i].original_url;

const reader = (id: number, i: number) => ({ kind: "reader", id, articleId: order[i].id });
const page = (id: number, key: string) => ({ kind: "page", id, key, url: `https://example.com/${key}`, title: key });
const pane = (id: number, ...tabs: { id: number }[]) => ({ kind: "pane", id, tabs, active: tabs[0].id });
const across = (id: number, ...children: unknown[]) => ({ kind: "split", id, dir: "row", children, sizes: children.map(() => 1 / children.length) });
const down = (id: number, ...children: unknown[]) => ({ kind: "split", id, dir: "column", children, sizes: children.map(() => 1 / children.length) });

async function press(app: Page, ...keys: string[]) {
  for (const k of keys) {
    await app.keyboard.press(k);
  }
}

/** The main window showing this layout, with the keyboard nowhere yet. */
async function open(shell: Page, root: unknown, focused: number) {
  await shell.addInitScript((l) => localStorage.setItem("lattice.layout", l), JSON.stringify({ root, focused }));
  await shell.goto("/");
  await expect(list(shell).locator(".row").first()).toBeVisible({ timeout: 30_000 });
}

/** Two Readers side by side, the right one focused. */
const twoReaders = (shell: Page) => open(shell, across(90, pane(1, reader(2, 0)), pane(3, reader(4, 1))), 3);

const panes = (app: Page) => app.locator(".dpane");
const focusedTitle = (app: Page) => app.locator(".dpane.focused .art-title");
const zoomButton = (app: Page) => app.locator(".dpane.focused").getByRole("button", { name: "フォーカスモード(Ctrl+B z)" });

test("Ctrl+B z leaves the focused pane alone on the screen, and again brings back everything as it was", async ({ shell }) => {
  await twoReaders(shell);
  await expect(focusedTitle(shell)).toHaveText(label(1));
  await shell.getByRole("button", { name: "対話" }).click();
  await expect(shell.locator(".chat")).toBeVisible();
  await list(shell).getByRole("button", { name: "記事一覧を閉じる" }).click();
  await expect(shell.locator(".list-rail")).toBeVisible();

  await press(shell, "Control+b", "z");
  await expect(panes(shell).first()).toBeHidden();
  await expect(panes(shell).nth(1)).toBeVisible();
  await expect(shell.locator(".nav")).toBeHidden();
  await expect(shell.locator(".list-rail")).toBeHidden();
  await expect(shell.locator(".chat")).toBeHidden();
  await expect(shell.locator(".splitter:visible")).toHaveCount(0);
  const box = await panes(shell).nth(1).boundingBox();
  expect(box?.width, "it fills the window").toBe(1440);
  await expect(zoomButton(shell)).toHaveAttribute("aria-pressed", "true");

  await press(shell, "Control+b", "z");
  await expect(panes(shell).first()).toBeVisible();
  await expect(shell.locator(".nav")).toBeVisible();
  await expect(shell.locator(".chat")).toBeVisible();
  await expect(shell.locator(".list-rail"), "the list stays closed as the user left it").toBeVisible();
  await expect(zoomButton(shell)).toHaveAttribute("aria-pressed", "false");
});

test("the focus-mode button zooms the pane it is in", async ({ shell }) => {
  await twoReaders(shell);
  const left = panes(shell).first();
  const button = left.getByRole("button", { name: "フォーカスモード(Ctrl+B z)" });
  await button.click();
  await expect(panes(shell).nth(1)).toBeHidden();
  await expect(left).toBeVisible();
  await expect(shell.locator(".nav")).toBeHidden();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await button.click();
  await expect(panes(shell).nth(1)).toBeVisible();
  await expect(shell.locator(".nav")).toBeVisible();
});

test("a Reader under the zoom keeps its scroll, and the list its place", async ({ shell }) => {
  await twoReaders(shell);
  const scroller = panes(shell).first().locator(".doc-scroll");
  await expect(scroller).toBeVisible();
  await panes(shell)
    .first()
    .locator(".reader")
    .evaluate((el) => void ((el as HTMLElement).style.minHeight = "6000px"));
  await scroller.evaluate((el) => el.scrollTo(0, 800));
  await press(shell, "Control+b", "z");
  await expect(scroller).toBeHidden();
  await press(shell, "Control+b", "z");
  await expect(scroller).toBeVisible();
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(800);
  await expect(list(shell).locator(".row").first()).toBeVisible();
});

test("with the keyboard in the list, the zoom takes it into the document", async ({ app }) => {
  await (await listRow(app, label(0))).click();
  await expect(app.locator(".art-title")).toHaveText(label(0));
  await app.locator(".reader").evaluate((el) => void ((el as HTMLElement).style.minHeight = "6000px"));
  await (await listRow(app, label(0))).focus();
  await press(app, "Control+b", "z");
  await expect(list(app)).toBeHidden();
  await expect(app.locator(".doc-scroll")).toBeFocused();
  await app.keyboard.press("j");
  await expect.poll(() => app.locator(".doc-scroll").evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
});

test("moving to another pane ends the zoom and goes by where the panes then are", async ({ shell }) => {
  await twoReaders(shell);
  await press(shell, "Control+b", "z");
  await expect(panes(shell).first()).toBeHidden();
  await shell.keyboard.press("Control+h");
  await expect(panes(shell).first()).toBeVisible();
  await expect(panes(shell).first()).toHaveClass(/focused/);
  await expect(focusedTitle(shell)).toHaveText(label(0));
  await expect(shell.locator(".nav")).toBeVisible();
});

test("a split and closing the pane end the zoom", async ({ shell }) => {
  await twoReaders(shell);
  await press(shell, "Control+b", "z");
  await expect(shell.locator(".nav")).toBeHidden();
  await shell.keyboard.press("Control+\\");
  await expect(panes(shell)).toHaveCount(3);
  await expect(shell.locator(".nav")).toBeVisible();
  await expect(panes(shell).first()).toBeVisible();

  await press(shell, "Control+b", "z");
  await expect(shell.locator(".nav")).toBeHidden();
  await press(shell, "Control+b", "x");
  await expect(panes(shell)).toHaveCount(2);
  await expect(shell.locator(".nav")).toBeVisible();
});

test("asking for what the zoom hides ends it: the chat, a filter, a search", async ({ shell }) => {
  await twoReaders(shell);
  const zoom = async () => {
    await press(shell, "Control+b", "z");
    await expect(shell.locator(".nav")).toBeHidden();
  };
  await zoom();
  await shell.locator(".dpane.focused").getByRole("button", { name: "質問" }).click();
  await expect(shell.locator(".chat")).toBeVisible();
  await expect(shell.locator(".nav")).toBeVisible();
  await expect(panes(shell).first()).toBeVisible();

  await list(shell).locator(".row").first().focus();
  await zoom();
  await shell.keyboard.press("Control+p");
  await shell.keyboard.type(">unread");
  await shell.keyboard.press("Enter");
  await expect(list(shell)).toBeVisible();

  await zoom();
  await shell.keyboard.press("Control+p");
  await shell.keyboard.type("?isolation");
  await shell.keyboard.press("Enter");
  await expect(shell.locator(".list.search")).toBeVisible();
});

/** A page's webview in the mock: what the UI last told the backend to do with it. */
const lastOf = (app: Page, key: string) =>
  app.evaluate(
    (k) => window.__e2e.calls.filter((c) => (c.cmd === "browser_set_bounds" || c.cmd === "browser_hide") && (c.args as { tab: string }).tab === k).at(-1)?.cmd,
    key,
  );
const twoPages = (shell: Page) => open(shell, across(90, pane(1, page(2, "k1")), pane(3, page(4, "k2"))), 1);

test("the zoom hides the webviews of the panes out of sight at once, grows the one in view and brings the others back", async ({ shell }) => {
  await twoPages(shell);
  await expect.poll(() => lastOf(shell, "k2")).toBe("browser_set_bounds");
  const width = async () =>
    ((await callsOf(shell, "browser_set_bounds")) as { tab: string; bounds: { width: number } }[]).findLast((c) => c.tab === "k1")?.bounds.width ?? 0;
  await expect.poll(width).toBeGreaterThan(0);
  const half = await width();

  await press(shell, "Control+b", "z");
  await expect.poll(() => callsOf(shell, "browser_hide")).toEqual([{ tab: "k2" }]);
  await expect.poll(width, "the page in view fills the window").toBeGreaterThan(1400);
  expect(await callsOf(shell, "browser_capture"), "no still stands in for a page out of sight").toEqual([]);
  await shell.waitForTimeout(300);
  expect(await lastOf(shell, "k2"), "nothing shows it again under the zoom").toBe("browser_hide");
  expect(await lastOf(shell, "k1")).toBe("browser_set_bounds");

  await press(shell, "Control+b", "z");
  await expect.poll(() => lastOf(shell, "k2")).toBe("browser_set_bounds");
  await expect.poll(width).toBe(half);
  await shell.waitForTimeout(300);
  expect(await lastOf(shell, "k2"), "no hide comes after the show").toBe("browser_set_bounds");
});

test("the focus a hidden page reports does not end the zoom", async ({ shell }) => {
  await twoPages(shell);
  await press(shell, "Control+b", "z");
  await expect.poll(() => callsOf(shell, "browser_hide")).toEqual([{ tab: "k2" }]);
  await shell.evaluate(() => window.__e2e.emit("browser-focus", { tab: "k2" }));
  await shell.waitForTimeout(100);
  await expect(panes(shell).nth(1)).toBeHidden();
  await expect(panes(shell).first()).toBeVisible();
});

test("a zoomed pane of a document window holds its window controls", async ({ shell }) => {
  const root = down(90, pane(1, reader(2, 0)), pane(3, reader(4, 1)));
  await shell.addInitScript((l) => localStorage.setItem("lattice.window.doc-1", l), JSON.stringify({ root, focused: 3 }));
  await shell.goto("/?window=doc-1");
  const controls = (pane: number) => panes(shell).nth(pane).getByRole("button", { name: "閉じる", exact: true });
  await expect(controls(0)).toBeVisible();
  await expect(controls(1)).toHaveCount(0);
  await press(shell, "Control+b", "z");
  await expect(controls(1)).toBeVisible();
});
