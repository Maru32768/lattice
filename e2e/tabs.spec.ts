import { test, expect, list, callsOf } from "./harness.ts";
import { ARTICLES } from "./fixtures.ts";

const row = (page: import("@playwright/test").Page, title: string) => list(page).locator(".row", { hasText: title });
const tabs = (page: import("@playwright/test").Page, pane = 0) => page.locator(".dpane").nth(pane).getByRole("tab");
/** The tabs' titles (without the favicon's letter). */
const titles = (page: import("@playwright/test").Page, pane = 0) => tabs(page, pane).locator(".tab-t");
const [a, b, c] = ARTICLES;

test("Ctrl-click opens a second tab; Ctrl+Tab cycles; Ctrl+W closes back to one", async ({ app }) => {
  await row(app, a.title!).click();
  await expect(titles(app)).toHaveText([a.title!]);
  await row(app, b.title!).click({ modifiers: ["Control"] });
  await expect(titles(app)).toHaveText([a.title!, b.title!]);
  await expect(tabs(app).nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(app.locator(".art-title")).toHaveText(b.title!);

  await app.keyboard.press("Control+Tab");
  await expect(app.locator(".art-title")).toHaveText(a.title!);
  await row(app, c.title!).click();
  // A plain click replaces the active tab.
  await expect(titles(app)).toHaveText([c.title!, b.title!]);

  await app.keyboard.press("Control+w");
  await expect(titles(app)).toHaveText([b.title!]);
  await expect(app.locator(".art-title")).toHaveText(b.title!);
});

test("a tab reorders by drag; middle-click closes it", async ({ app }) => {
  await row(app, a.title!).click();
  await row(app, b.title!).click({ modifiers: ["Control"] });
  const first = (await tabs(app).nth(0).boundingBox())!;
  const second = (await tabs(app).nth(1).boundingBox())!;
  await app.mouse.move(second.x + second.width / 2, second.y + second.height / 2);
  await app.mouse.down();
  await app.mouse.move(first.x + 4, first.y + first.height / 2, { steps: 6 });
  await app.mouse.up();
  // The backend runs the drag (tabdrag.spec.ts): over this window's first slot, it says so on release.
  await app.evaluate(() => window.__e2e.emit("tab-drag-drop", { label: "main", pane: 1, index: 0 }));
  await expect(titles(app)).toHaveText([b.title!, a.title!]);

  await tabs(app).nth(0).click({ button: "middle" });
  await expect(titles(app)).toHaveText([a.title!]);
});

test("split right makes a focused empty pane; the next click opens there; closing it merges back", async ({ app }) => {
  await row(app, a.title!).click();
  await app.getByRole("button", { name: "右に分割" }).click();
  const panes = app.locator(".dpane");
  await expect(panes).toHaveCount(2);
  await expect(panes.nth(1)).toHaveClass(/focused/);
  await expect(panes.nth(1)).toContainText("記事を選んでください");

  await row(app, b.title!).click();
  await expect(titles(app, 1)).toHaveText([b.title!]);
  await expect(titles(app, 0)).toHaveText([a.title!]);

  const handle = app.getByRole("separator", { name: "ペインの幅" });
  await expect(handle).toHaveAttribute("aria-valuenow", "50");
  await handle.focus();
  await app.keyboard.press("Shift+ArrowRight");
  await expect(handle).toHaveAttribute("aria-valuenow", "58");
  const [left, right] = await Promise.all([panes.nth(0).boundingBox(), panes.nth(1).boundingBox()]);
  expect(left!.width / (left!.width + right!.width)).toBeCloseTo(0.58, 1);

  await panes.nth(0).click();
  await expect(panes.nth(0)).toHaveClass(/focused/);
  await app.keyboard.press("Control+-");
  await expect(panes).toHaveCount(3);
  await expect(app.getByRole("separator", { name: "ペインの高さ" })).toBeVisible();

  await panes.nth(1).getByRole("button", { name: "ペインを閉じる" }).click();
  await expect(panes).toHaveCount(2);
  await panes.nth(1).getByRole("button", { name: "ペインを閉じる" }).click();
  await expect(panes).toHaveCount(1);
  await expect(titles(app)).toHaveText([a.title!]);
});

test("the layout with its tabs survives a reload", async ({ app }) => {
  await row(app, a.title!).click();
  await row(app, b.title!).click({ modifiers: ["Control"] });
  await app.getByRole("button", { name: "下に分割" }).click();
  await row(app, c.title!).click();
  await app.reload();
  await expect(app.locator(".dpane")).toHaveCount(2);
  await expect(titles(app, 0)).toHaveText([a.title!, b.title!]);
  await expect(titles(app, 1)).toHaveText([c.title!]);
  await expect(app.locator(".dpane").nth(1)).toHaveClass(/focused/);
});

test("a Page tab gets its own webview, titled by its host until the page names itself", async ({ app }) => {
  const url = "https://example.com/new-post";
  await app.keyboard.press("Control+k");
  await app.keyboard.insertText(url);
  await app.keyboard.press("Enter");
  await expect(titles(app)).toHaveText(["example.com"]);
  const opens = (await callsOf(app, "browser_open")) as { tab: string; url: string }[];
  expect(opens).toHaveLength(1);
  expect(opens[0]).toMatchObject({ tab: expect.stringMatching(/^[0-9a-z]+$/), url });
  const first = opens[0].tab;

  await app.keyboard.press("Control+t");
  await app.keyboard.insertText("https://example.org/other");
  await app.keyboard.press("Enter");
  await expect(titles(app)).toHaveText(["example.com", "example.org"]);
  const keys = ((await callsOf(app, "browser_open")) as { tab: string }[]).map((o) => o.tab);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(first);
  expect(keys[1], "its own webview").not.toBe(first);
  await expect.poll(() => callsOf(app, "browser_hide")).toContainEqual({ tab: first });

  await app.keyboard.press("Control+w");
  await expect(titles(app)).toHaveText(["example.com"]);
  await expect.poll(() => callsOf(app, "browser_close")).toEqual([{ tab: keys[1] }]);
});

test("a chat citation and a palette article open in a new tab on Ctrl / middle click", async ({ app }) => {
  await row(app, a.title!).click();
  await app.locator(".nav").getByRole("button", { name: "対話" }).click();
  await app.getByRole("button", { name: "会話を選ぶ" }).click();
  await app.getByRole("menuitemradio", { name: "MVCC と VACUUM の関係" }).click();
  // [1] cites the second article; a plain click would replace the active tab.
  await app
    .locator(".chat .answer > p .cite")
    .first()
    .click({ modifiers: ["Control"] });
  await expect(titles(app)).toHaveText([a.title!, b.title!]);
  await app.locator(".chat .source").first().click({ button: "middle" });
  await expect(titles(app)).toHaveText([a.title!, b.title!, b.title!]);

  await app.keyboard.press("Control+k");
  await app.keyboard.insertText(c.title!);
  await app.locator(".pal .it-l").getByText(c.title!, { exact: true }).click({ button: "middle" });
  await expect(titles(app)).toHaveText([a.title!, b.title!, b.title!, c.title!]);
});
