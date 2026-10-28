import { test, expect, list, callsOf } from "./harness.ts";
import { ARTICLES } from "./fixtures.ts";

// The list's default order: newest saved first.
const order = [...ARTICLES].sort((a, b) => b.saved_at.localeCompare(a.saved_at) || b.id - a.id);
const label = (i: number) => order[i].title ?? order[i].original_url;

test("j / k move the cursor without opening; Enter opens it in the Reader", async ({ app }) => {
  const cur = list(app).locator(".row.cur .t");
  await app.keyboard.press("j");
  await expect(cur).toHaveText(label(0));
  await app.keyboard.press("j");
  await app.keyboard.press("ArrowDown");
  await expect(cur).toHaveText(label(2));
  await app.keyboard.press("k");
  await expect(cur).toHaveText(label(1));
  expect(await callsOf(app, "get_article")).toEqual([]);

  await app.keyboard.press("Enter");
  await expect(app.locator(".art-title")).toHaveText(label(1));
  await expect(list(app).locator(".row.sel .t")).toHaveText(label(1));
  expect(await callsOf(app, "set_read")).toEqual([{ id: order[1].id, read: true }]);
});

test("the cursor reaches the end of the virtualized list, its row scrolled into view and focused", async ({ app }) => {
  await list(app).locator(".row").first().focus();
  for (let i = 1; i < order.length; i++) {
    await app.keyboard.press("j");
  }
  const cur = list(app).locator(".row.cur");
  await expect(cur.locator(".t")).toHaveText(label(order.length - 1));
  await expect(cur).toBeInViewport();
  await expect(cur).toBeFocused();
  // Back up to the first row: rows scrolled out of view are mounted again.
  for (let i = 1; i < order.length; i++) {
    await app.keyboard.press("k");
  }
  await expect(cur.locator(".t")).toHaveText(label(0));
  await expect(cur).toBeInViewport();
  await expect(cur).toBeFocused();
});

test("Shift+Enter opens the cursor's article as a page", async ({ app }) => {
  await app.keyboard.press("j");
  await app.keyboard.press("Shift+Enter");
  await expect.poll(() => callsOf(app, "browser_open")).toEqual([expect.objectContaining({ url: order[0].original_url })]);
  await expect(app.getByRole("group", { name: "表示" }).getByRole("button", { name: /Page/ })).toHaveAttribute("aria-pressed", "true");
});

test("rows and headings keep the fixed heights the virtualized list is given, in a narrow list too", async ({ app }) => {
  // ROW_H / HEAD_H in ListPane.tsx: a row or heading of another height makes the scrollbar drift from the mouse.
  await list(app).getByRole("button", { name: "並び順とまとめ方" }).click();
  await app.getByRole("menuitemradio", { name: "ソース" }).click();
  await expect(list(app).locator(".grp-h").first()).toBeVisible();
  for (const width of [null, "260px"]) {
    if (width) {
      await app.locator(".list").evaluate((e, w) => void ((e as HTMLElement).style.width = w), width);
    }
    const heights = (sel: string) =>
      list(app)
        .locator(sel)
        .evaluateAll((els) => [...new Set(els.map((e) => e.getBoundingClientRect().height))]);
    expect(await heights(".row")).toEqual([104]);
    expect(await heights(".grp-h")).toEqual([27]);
  }
});

test("a click on a row below the fold opens it", async ({ app }) => {
  // The click focuses the row, which moves the cursor. Revealing the cursor's row then scrolled the list again (Virtuoso
  // had not caught up with the click's own scroll), moving another row under the mouse before mouseup.
  for (const title of [label(4), label(8)]) {
    await list(app).locator(".row", { hasText: title }).click();
    await expect(app.locator(".art-title")).toHaveText(title);
  }
});
