// The default keys: where the keyboard is decides what they mean.
import { test, expect, list, listRow, callsOf } from "./harness.ts";
import { ARTICLES } from "./fixtures.ts";
import type { Page } from "@playwright/test";

const order = [...ARTICLES].sort((a, b) => b.saved_at.localeCompare(a.saved_at) || b.id - a.id);
const label = (i: number) => order[i].title ?? order[i].original_url;
const palette = (page: Page) => page.getByRole("dialog", { name: "コマンドパレット" });
const hint = (page: Page) => page.locator(".prefix-hint");

async function press(page: Page, ...keys: string[]) {
  for (const k of keys) {
    await page.keyboard.press(k);
  }
}

/** The first article in the Reader, long enough to scroll, with the keyboard in its pane. */
async function intoReader(app: Page, i = 0) {
  await (await listRow(app, label(i))).click();
  await expect(app.locator(".art-title")).toHaveText(label(i));
  await app.locator(".reader").evaluate((el) => void ((el as HTMLElement).style.minHeight = "6000px"));
  await app.keyboard.press("Control+l");
  await expect(app.locator(".doc-scroll")).toBeFocused();
}
const scrollTop = (app: Page) => app.locator(".doc-scroll").evaluate((el) => el.scrollTop);

test("in the Reader j scrolls it and leaves the list cursor; k comes back", async ({ app }) => {
  await intoReader(app);
  const cur = list(app).locator(".row.cur .t");
  await expect(cur).toHaveText(label(0));
  await app.keyboard.press("j");
  await expect.poll(() => scrollTop(app)).toBeGreaterThan(0);
  await expect(cur).toHaveText(label(0));
  await app.keyboard.press("k");
  await expect.poll(() => scrollTop(app)).toBe(0);
});

test("a count scrolls that many times as far", async ({ app }) => {
  await intoReader(app);
  await app.keyboard.press("j");
  await expect.poll(() => scrollTop(app)).toBeGreaterThan(0);
  const line = await scrollTop(app);
  await app.keyboard.press("k");
  await expect.poll(() => scrollTop(app)).toBe(0);
  await press(app, "5", "j");
  await expect.poll(() => scrollTop(app)).toBe(5 * line);
  await press(app, "1", "0", "j");
  await expect.poll(() => scrollTop(app)).toBe(15 * line);
});

test("gg, G and half a screen in the Reader", async ({ app }) => {
  await intoReader(app);
  await app.keyboard.press("Shift+G");
  const max = await app.locator(".doc-scroll").evaluate((el) => el.scrollHeight - el.clientHeight);
  await expect.poll(() => scrollTop(app)).toBe(max);
  await press(app, "g", "g");
  await expect.poll(() => scrollTop(app)).toBe(0);
  const half = await app.locator(".doc-scroll").evaluate((el) => el.clientHeight / 2);
  await app.keyboard.press("d");
  await expect.poll(() => scrollTop(app)).toBe(half);
  await app.keyboard.press("Control+u");
  await expect.poll(() => scrollTop(app)).toBe(0);
});

test("J and K open the next and previous article in the focused pane, which keeps the keyboard", async ({ app }) => {
  await intoReader(app);
  await app.keyboard.press("Shift+J");
  await expect(app.locator(".art-title")).toHaveText(label(1));
  await expect(app.locator(".doc-scroll")).toBeFocused();
  await expect(app.locator(".dpane").getByRole("tab")).toHaveCount(1);
  await press(app, "2", "Shift+J");
  await expect(app.locator(".art-title")).toHaveText(label(3));
  await app.keyboard.press("Shift+K");
  await expect(app.locator(".art-title")).toHaveText(label(2));
});

test("in the list j moves the cursor, gg and G go to its ends, and a count multiplies", async ({ app }) => {
  const cur = list(app).locator(".row.cur .t");
  await app.keyboard.press("j");
  await expect(cur).toHaveText(label(0));
  await press(app, "3", "j");
  await expect(cur).toHaveText(label(3));
  await app.keyboard.press("Shift+G");
  await expect(cur).toHaveText(label(order.length - 1));
  await press(app, "g", "g");
  await expect(cur).toHaveText(label(0));
  await app.keyboard.press("d");
  await expect(list(app).locator(".row.cur")).toHaveCount(1);
  await expect(cur).not.toHaveText(label(0));
  await app.keyboard.press("u");
  await expect(cur).toHaveText(label(0));
});

test("Ctrl+P opens the palette; : and ; open it on its commands, and a plain : in a field stays typed", async ({ app }) => {
  await app.keyboard.press("Control+p");
  await expect(palette(app).getByRole("combobox")).toBeFocused();
  await expect(palette(app).getByRole("combobox")).toHaveValue("");
  await app.keyboard.press("Escape");
  await expect(palette(app)).toBeHidden();

  await app.keyboard.press(":");
  await expect(palette(app).getByRole("combobox")).toHaveValue(">");
  await app.keyboard.type("all:");
  await expect(palette(app).getByRole("combobox")).toHaveValue(">all:");
  await app.keyboard.press("Escape");

  await app.keyboard.press(";");
  await expect(palette(app).getByRole("combobox")).toHaveValue(">");
  await app.keyboard.press("Escape");
  await expect(palette(app)).toBeHidden();
});

test("Ctrl+B 2 selects the second tab of the focused pane, and Ctrl+B 1 the first", async ({ app }) => {
  await (await listRow(app, label(0))).click();
  await (await listRow(app, label(1))).click({ modifiers: ["Control"] });
  await expect(app.locator(".art-title")).toHaveText(label(0));
  await press(app, "Control+b", "2");
  await expect(app.locator(".art-title")).toHaveText(label(1));
  await press(app, "Control+b", "1");
  await expect(app.locator(".art-title")).toHaveText(label(0));
  await press(app, "Control+b", "9");
  await expect(app.locator(".art-title"), "no such tab: nothing happens").toHaveText(label(0));
  await expect(hint(app)).toBeHidden();
});

test("Ctrl+B ? and ? list every binding by where it runs; Esc and ? close the list", async ({ app }) => {
  const help = app.getByRole("dialog", { name: "キー一覧" });
  await press(app, "Control+b", "?");
  await expect(help).toBeVisible();
  await expect(help.locator("h3")).toHaveText(["どこでも", "一覧", "本文"]);
  const keysOf = (label: string) =>
    help
      .locator(".it")
      .filter({ has: app.locator(".it-l").getByText(label, { exact: true }) })
      .locator(".kbd");
  await expect(keysOf("下へスクロール")).toHaveText(["j"]);
  await expect(keysOf("次の項目へ")).toHaveText(["j", "↓"]);
  await app.keyboard.press("j");
  await expect(list(app).locator(".row.cur"), "the list owns no keys under it").toHaveCount(0);
  await app.keyboard.press("Escape");
  await expect(help).toBeHidden();

  await app.keyboard.press("?");
  await expect(help).toBeVisible();
  await app.keyboard.press("?");
  await expect(help).toBeHidden();
});

test("the hint shows only after a moment, lists what follows, and Esc ends the sequence without acting", async ({ app }) => {
  // In the page itself: a `press` from here could take longer than the delay.
  const shownAtOnce = await app.evaluate(async () => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "g", bubbles: true, cancelable: true }));
    await new Promise(requestAnimationFrame);
    return document.querySelector(".prefix-hint") != null;
  });
  expect(shownAtOnce).toBe(false);
  await expect(hint(app)).toBeVisible();
  await expect(hint(app)).toContainText("一覧の先頭へ");
  await expect(hint(app), "the list's scope").not.toContainText("本文の先頭へ");

  await app.keyboard.press("Escape");
  await expect(hint(app)).toBeHidden();
  await app.keyboard.press("g");
  await expect(hint(app)).toBeVisible();
  await app.mouse.click(700, 400);
  await expect(hint(app), "a pointer press ends it too").toBeHidden();
});

test("an unbound second key ends the sequence and does nothing else", async ({ app }) => {
  const cur = list(app).locator(".row.cur");
  await press(app, "g", "j");
  await expect(cur).toHaveCount(0);
  await app.keyboard.press("j");
  await expect(cur).toHaveCount(1);
});

test("what a page sends runs by its whole sequence, with its count", async ({ app }) => {
  const fromPage = (key: string, count = 1) => app.evaluate(({ key, count }) => window.__e2e.emit("browser-key", { tab: "none", key, count }), { key, count });
  await (await listRow(app, label(0))).click();
  await expect(app.locator(".art-title")).toHaveText(label(0));
  await fromPage("Shift+J", 3);
  await expect(app.locator(".art-title")).toHaveText(label(3));

  await fromPage("Ctrl+B");
  await expect(hint(app)).toBeVisible();
  await expect(hint(app), "a page's keys are the document's").toContainText("ビジュアルモード");
  await fromPage("");
  await expect(hint(app), "the page ended it").toBeHidden();
});

test("moving into a pane that shows a page gives the page the keyboard", async ({ shell }) => {
  const LAYOUT = { root: { kind: "pane", id: 1, tabs: [{ kind: "page", id: 3, key: "k1", url: "https://example.com/p", title: "P" }], active: 3 }, focused: 1 };
  await shell.addInitScript((l) => localStorage.setItem("lattice.layout", l), JSON.stringify(LAYOUT));
  await shell.goto("/");
  await list(shell).locator(".row").first().focus();
  await expect(shell.locator(".page-host")).toBeVisible();
  await shell.keyboard.press("Control+l");
  await expect.poll(() => callsOf(shell, "browser_focus")).toEqual([{ tab: "k1" }]);
  await expect(shell.locator(".app")).toHaveAttribute("data-kb-pane", "doc");
});
