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

const paneWidthHandle = (app: Page) => app.getByRole("separator", { name: "ペインの幅" });

test("Ctrl+B Shift+H and L move the focused document's border, and the second key alone repeats", async ({ shell }) => {
  await twoReaders(shell);
  await expect(paneWidthHandle(shell)).toHaveAttribute("aria-valuenow", "50");
  await press(shell, "Control+b", "Shift+H");
  await expect(paneWidthHandle(shell), "the right pane grows to its left").toHaveAttribute("aria-valuenow", "46");
  await shell.keyboard.press("Shift+H");
  await expect(paneWidthHandle(shell)).toHaveAttribute("aria-valuenow", "42");
  await press(shell, "Control+b", "Control+ArrowRight");
  await expect(paneWidthHandle(shell)).toHaveAttribute("aria-valuenow", "46");
});

test("Ctrl+B Shift+K and J move the border of stacked documents", async ({ shell }) => {
  await open(shell, down(90, pane(1, reader(2, 0)), pane(3, reader(4, 1))), 1);
  const handle = shell.getByRole("separator", { name: "ペインの高さ" });
  await expect(handle).toHaveAttribute("aria-valuenow", "50");
  await press(shell, "Control+b", "Shift+J");
  await expect(handle).toHaveAttribute("aria-valuenow", "54");
  await press(shell, "Control+b", "Shift+K");
  await expect(handle).toHaveAttribute("aria-valuenow", "50");
  await press(shell, "Control+b", "Shift+H");
  await expect(handle, "no split that way: nothing moves").toHaveAttribute("aria-valuenow", "50");
});

test("with the keyboard in the list, the nav or the chat, the same keys change that pane's width", async ({ shell }) => {
  await twoReaders(shell);
  const width = (name: string) => shell.getByRole("separator", { name });
  await list(shell).locator(".row").first().focus();
  await press(shell, "Control+b", "Shift+L");
  await expect(width("記事一覧の幅")).toHaveAttribute("aria-valuenow", "428");
  await press(shell, "Control+b", "Shift+H");
  await expect(width("記事一覧の幅")).toHaveAttribute("aria-valuenow", "396");
  await press(shell, "Control+b", "Shift+K");
  await expect(width("記事一覧の幅"), "a side pane has no height to change").toHaveAttribute("aria-valuenow", "396");
  await expect(paneWidthHandle(shell)).toHaveAttribute("aria-valuenow", "50");

  await shell.keyboard.press("Control+h");
  await press(shell, "Control+b", "Shift+L");
  await expect(width("ナビゲーションの幅")).toHaveAttribute("aria-valuenow", "260");

  await shell.getByRole("button", { name: "対話" }).click();
  await shell.locator("#chat-q").click();
  await press(shell, "Control+b", "Shift+H");
  await expect(width("対話ペインの幅"), "the chat's border is on its left").toHaveAttribute("aria-valuenow", "462");
  await expect(shell.locator("#chat-q"), "the keys typed nothing").toHaveValue("");
});

test("a page's Ctrl+B Shift+L grows its document", async ({ shell }) => {
  await open(shell, across(90, pane(1, page(2, "k1")), pane(3, page(4, "k2"))), 1);
  await shell.evaluate(() => window.__e2e.emit("browser-key", { tab: "k1", key: "Ctrl+B Shift+L", count: 1 }));
  await expect(paneWidthHandle(shell)).toHaveAttribute("aria-valuenow", "54");
});

test("Ctrl+B } and { swap the focused pane with the next and the previous; the focus goes with its tabs", async ({ shell }) => {
  await open(shell, across(90, pane(1, reader(2, 0)), pane(3, reader(4, 1)), pane(5, reader(6, 2))), 1);
  const titles = shell.locator(".dpane .art-title");
  await expect(titles).toHaveText([label(0), label(1), label(2)]);
  await list(shell).locator(".row").first().focus();
  await shell.keyboard.press("Control+l");
  await expect(panes(shell).first().locator(".doc-scroll")).toBeFocused();

  await press(shell, "Control+b", "}");
  await expect(titles).toHaveText([label(1), label(0), label(2)]);
  await expect(focusedTitle(shell)).toHaveText(label(0));
  await expect(panes(shell).nth(1).locator(".doc-scroll"), "the keyboard goes along").toBeFocused();

  await press(shell, "Control+b", "{");
  await expect(titles).toHaveText([label(0), label(1), label(2)]);
  await expect(focusedTitle(shell)).toHaveText(label(0));

  await press(shell, "Control+b", "{");
  await expect(titles, "from the first it wraps to the last").toHaveText([label(2), label(1), label(0)]);
  await expect(panes(shell).nth(2)).toHaveClass(/focused/);
});

test("a swap places both pages' webviews where their tabs now are, without reloading them", async ({ shell }) => {
  await twoPages(shell);
  const xOf = async (key: string) =>
    ((await callsOf(shell, "browser_set_bounds")) as { tab: string; bounds: { x: number } }[]).findLast((c) => c.tab === key)?.bounds.x;
  await expect.poll(() => xOf("k2")).toBeGreaterThan(0);
  const [left, right] = [await xOf("k1"), await xOf("k2")];
  const opened = (await callsOf(shell, "browser_open")).length;

  await press(shell, "Control+b", "}");
  await expect.poll(() => xOf("k1")).toBe(right);
  await expect.poll(() => xOf("k2")).toBe(left);
  expect(await callsOf(shell, "browser_open")).toHaveLength(opened);
  await shell.waitForTimeout(300);
  expect(await lastOf(shell, "k1"), "the move's unmount sent no hide after the show").toBe("browser_set_bounds");
  expect(await lastOf(shell, "k2")).toBe("browser_set_bounds");
});

test("Ctrl+B Shift+E evens out every split", async ({ shell }) => {
  await open(shell, across(90, pane(1, reader(2, 0)), down(91, pane(3, reader(4, 1)), pane(5, reader(6, 2)))), 3);
  await press(shell, "Control+b", "Shift+H");
  await press(shell, "Control+b", "Shift+K");
  await expect(paneWidthHandle(shell)).toHaveAttribute("aria-valuenow", "46");
  await expect(shell.getByRole("separator", { name: "ペインの高さ" })).toHaveAttribute("aria-valuenow", "46");
  await press(shell, "Control+b", "Shift+E");
  await expect(paneWidthHandle(shell)).toHaveAttribute("aria-valuenow", "50");
  await expect(shell.getByRole("separator", { name: "ペインの高さ" })).toHaveAttribute("aria-valuenow", "50");
});

test("Ctrl+B ; goes back to the pane focused before, and the keyboard goes with it", async ({ shell }) => {
  await twoReaders(shell);
  await press(shell, "Control+b", ";");
  await expect(panes(shell).nth(1), "no pane before it yet").toHaveClass(/focused/);

  await list(shell).locator(".row").first().focus();
  await shell.keyboard.press("Control+l");
  await expect(panes(shell).first()).toHaveClass(/focused/);
  await expect(panes(shell).first().locator(".doc-scroll")).toBeFocused();

  await press(shell, "Control+b", ";");
  await expect(panes(shell).nth(1)).toHaveClass(/focused/);
  await expect(panes(shell).nth(1).locator(".doc-scroll")).toBeFocused();
  await press(shell, "Control+b", ";");
  await expect(panes(shell).first()).toHaveClass(/focused/);
  await expect(panes(shell).first().locator(".doc-scroll")).toBeFocused();
});

test("Ctrl+B ; from the list takes the keyboard into that document; from under the zoom it ends the zoom", async ({ shell }) => {
  await twoReaders(shell);
  await panes(shell).first().locator(".doc-scroll").click();
  await expect(panes(shell).first()).toHaveClass(/focused/);
  await list(shell).locator(".row").first().focus();
  await press(shell, "Control+b", ";");
  await expect(panes(shell).nth(1)).toHaveClass(/focused/);
  await expect(panes(shell).nth(1).locator(".doc-scroll")).toBeFocused();
  await expect(shell.locator(".app")).toHaveAttribute("data-kb-pane", "doc");

  await press(shell, "Control+b", "z");
  await expect(panes(shell).first()).toBeHidden();
  await press(shell, "Control+b", ";");
  await expect(panes(shell).first()).toBeVisible();
  await expect(panes(shell).first()).toHaveClass(/focused/);
  await expect(panes(shell).first().locator(".doc-scroll")).toBeFocused();
});

const palette = (app: Page) => app.getByRole("dialog", { name: "コマンドパレット" });
/** Three tabs in two panes: an article and a page, and another article. */
const threeTabs = (shell: Page) => open(shell, across(90, pane(1, reader(2, 0), page(3, "k1")), pane(4, reader(5, 1))), 1);

test("Ctrl+B w lists every tab of the window under t:, and Enter shows the one picked, in its pane", async ({ shell }) => {
  await threeTabs(shell);
  await press(shell, "Control+b", "w");
  const input = palette(shell).getByRole("combobox");
  await expect(input).toHaveValue("t:");
  await expect(input).toBeFocused();
  const options = palette(shell).getByRole("option");
  await expect(options.locator(".it-l")).toHaveText([label(0), "k1", label(1)]);
  await expect(options.locator(".r")).toHaveText(["ドキュメント1", "ドキュメント1", "ドキュメント2"]);
  await expect(palette(shell).locator(".ft")).toContainText("t: 開いているタブ");

  await shell.keyboard.press("ArrowDown");
  await shell.keyboard.press("Enter");
  await expect(palette(shell)).toBeHidden();
  await expect(panes(shell).first().locator(".page-host")).toBeVisible();
  await expect(panes(shell).first()).toHaveClass(/focused/);
});

test("the tab list narrows by title; picking a tab of a pane under the zoom ends the zoom", async ({ shell }) => {
  await threeTabs(shell);
  await press(shell, "Control+b", "z");
  await expect(panes(shell).nth(1)).toBeHidden();
  await press(shell, "Control+b", "w");
  await shell.keyboard.type(label(1).slice(0, 12));
  const options = palette(shell).getByRole("option");
  await expect(options).toHaveCount(1);
  await expect(options.locator(".it-l mark")).toHaveText(label(1).slice(0, 12));
  await shell.keyboard.press("Enter");
  await expect(panes(shell).nth(1)).toBeVisible();
  await expect(panes(shell).nth(1)).toHaveClass(/focused/);
});

test("the tab list picked from the palette's own commands opens on its query", async ({ shell }) => {
  await threeTabs(shell);
  await shell.keyboard.press(":");
  await shell.keyboard.type("タブの一覧");
  await palette(shell)
    .getByRole("option", { name: /タブの一覧/ })
    .click();
  const input = palette(shell).getByRole("combobox");
  await expect(input).toHaveValue("t:");
  await expect(input).toBeFocused();
  await expect(palette(shell).getByRole("option")).toHaveCount(3);
});

const numbers = (app: Page) => app.getByRole("status", { name: "ペインの番号を表示" });

test("Ctrl+B q numbers the panes on screen in order, each over its pane, and a digit takes the keyboard there", async ({ shell }) => {
  await twoReaders(shell);
  await press(shell, "Control+b", "q");
  await expect(numbers(shell).locator("b")).toHaveText(["1", "2", "3", "4"]);
  const third = await numbers(shell).locator("span").nth(2).boundingBox();
  const left = await panes(shell).first().boundingBox();
  expect(third).toEqual(left);

  await shell.keyboard.press("3");
  await expect(numbers(shell)).toBeHidden();
  await expect(panes(shell).first()).toHaveClass(/focused/);
  await expect(panes(shell).first().locator(".doc-scroll")).toBeFocused();
  await expect(shell.locator(".app")).toHaveAttribute("data-kb-pane", "doc");

  await press(shell, "Control+b", "q");
  await shell.keyboard.press("2");
  await expect(numbers(shell)).toBeHidden();
  await expect(shell.locator(".app")).toHaveAttribute("data-kb-pane", "list");
  await expect(list(shell).locator(":focus")).toHaveCount(1);
  await expect(panes(shell).first(), "the documents' focus stays").toHaveClass(/focused/);
});

test("any other key, a digit with no pane and a pointer press end the numbers and do nothing else", async ({ shell }) => {
  await twoReaders(shell);
  await list(shell).locator(".row").first().focus();
  const cursor = list(shell).locator(".row.cur .t");
  const before = await cursor.innerText();
  await press(shell, "Control+b", "q");
  await expect(numbers(shell)).toBeVisible();
  await shell.keyboard.press("j");
  await expect(numbers(shell)).toBeHidden();
  await expect(cursor, "the key was the numbers'").toHaveText(before);

  await press(shell, "Control+b", "q");
  await expect(numbers(shell)).toBeVisible();
  await shell.keyboard.press("Shift");
  await expect(numbers(shell), "a lone modifier is no key yet").toBeVisible();
  await shell.keyboard.press("Escape");
  await expect(numbers(shell)).toBeHidden();

  await press(shell, "Control+b", "q");
  await expect(numbers(shell)).toBeVisible();
  await shell.keyboard.press("9");
  await expect(numbers(shell)).toBeHidden();
  await expect(panes(shell).nth(1)).toHaveClass(/focused/);

  await press(shell, "Control+b", "q");
  await expect(numbers(shell)).toBeVisible();
  await panes(shell).first().locator(".art-title").click();
  await expect(numbers(shell)).toBeHidden();
  await expect(panes(shell).first(), "the press reaches what is under the numbers").toHaveClass(/focused/);
});

test("the numbers hide the pages under them, which come back when they end, with the keyboard", async ({ shell }) => {
  await twoPages(shell);
  await expect.poll(() => lastOf(shell, "k2")).toBe("browser_set_bounds");
  await shell.evaluate(() => window.__e2e.emit("browser-key", { tab: "k1", key: "Ctrl+B Q", count: 1 }));
  await expect(numbers(shell)).toBeVisible();
  await expect.poll(() => lastOf(shell, "k1")).toBe("browser_hide");
  await expect.poll(() => lastOf(shell, "k2")).toBe("browser_hide");
  await expect(numbers(shell)).toHaveCSS("opacity", "1");
  const before = (await callsOf(shell, "browser_focus")).length;

  await shell.keyboard.press("Escape");
  await expect(numbers(shell)).toBeHidden();
  await expect.poll(() => lastOf(shell, "k1")).toBe("browser_set_bounds");
  await expect.poll(() => lastOf(shell, "k2")).toBe("browser_set_bounds");
  await expect.poll(async () => (await callsOf(shell, "browser_focus")).slice(before), "the keyboard returns to the page").toEqual([{ tab: "k1" }]);

  await press(shell, "Control+b", "q");
  await shell.keyboard.press("4");
  await expect(numbers(shell)).toBeHidden();
  await expect(panes(shell).nth(1)).toHaveClass(/focused/);
  await expect.poll(async () => (await callsOf(shell, "browser_focus")).at(-1), "a digit takes it to that page").toEqual({ tab: "k2" });
});

test("under the zoom only the zoomed pane has a number", async ({ shell }) => {
  await twoReaders(shell);
  await press(shell, "Control+b", "z");
  await expect(panes(shell).first()).toBeHidden();
  await press(shell, "Control+b", "q");
  await expect(numbers(shell).locator("b")).toHaveText(["1"]);
  await shell.keyboard.press("Escape");
  await expect(numbers(shell)).toBeHidden();
  await expect(panes(shell).first(), "the zoom goes on").toBeHidden();
});

test("with one pane the tab list names no panes", async ({ app }) => {
  await (await listRow(app, label(0))).click();
  await press(app, "Control+b", "w");
  await expect(palette(app).getByRole("option")).toHaveCount(1);
  await expect(palette(app).locator(".it .r")).toHaveCount(0);
});
