// Where lists and articles were left: kept on this device, and found again after a remount or a restart.
import { test, expect, callsOf, list, listRow, navItem } from "./harness.ts";
import { ARTICLES } from "./fixtures.ts";
import type { Locator, Page } from "@playwright/test";

// The first article is the snapshot fixture, with blocks of its own.
const LONG = ARTICLES[1].title!;
const para = (i: number) => `Paragraph ${i} of the long article.`;

/** The fixtures with 150 more articles and a long first one, then the app. */
async function start(shell: Page) {
  // The dev server serves from e2e/: the module is /fixtures.ts.
  await shell.route(/\/fixtures\.ts(\?|$)/, async (route) => {
    const res = await route.fetch();
    const more = [
      "ARTICLES.push(...Array.from({ length: 150 }, (_, i) => ({ ...ARTICLES[2], id: 5000 + i, title: `Extra ${i}` })));",
      "genericBlocks = ((plain) => (a) => (a.id === 2 ? [...plain(a), ...Array.from({ length: 80 }, (_, i) => ['paragraph', `Paragraph ${i} of the long article.`, null])] : plain(a)))(genericBlocks);",
    ].join("\n");
    await route.fulfill({ response: res, body: `${await res.text()}\n${more}\n` });
  });
  await shell.goto("/");
  await expect(list(shell).locator(".row").first()).toBeVisible({ timeout: 30_000 });
}

/** The row at the top of the list, and how far past its top the list is scrolled. */
const listTop = (shell: Page) =>
  list(shell)
    .locator(".list-body")
    .evaluate((el) => {
      const top = el.getBoundingClientRect().top;
      const row = [...el.querySelectorAll<HTMLElement>(".row")].find((r) => r.getBoundingClientRect().bottom > top);
      return row && { title: row.querySelector(".t")?.textContent, past: Math.round(top - row.getBoundingClientRect().top) };
    });

/** The text of the block at the top of the Reader. */
const readerTop = (doc: Locator) =>
  doc.evaluate((el) => {
    const top = el.getBoundingClientRect().top;
    return [...el.querySelectorAll("[id^='b-']")].find((b) => b.getBoundingClientRect().bottom > top)?.textContent;
  });

const stored = (shell: Page, key: string) => shell.evaluate((k) => localStorage.getItem(k) ?? "", key);

test("the list comes back where it was left: after the settings, another list, closing it, and a restart", async ({ shell }) => {
  await start(shell);
  await list(shell)
    .locator(".list-body")
    .evaluate((el) => el.scrollTo(0, 3037));
  await expect.poll(() => stored(shell, "lattice.listPlaces")).toContain("offset");
  const left = await listTop(shell);
  expect(left?.past, "a row partly scrolled past").toBeGreaterThan(0);

  await shell.locator(".nav").getByRole("button", { name: "設定" }).click();
  await shell.keyboard.press("Escape");
  await expect.poll(() => listTop(shell)).toEqual(left);

  await navItem(shell, "お気に入り").click();
  await expect.poll(() => listTop(shell)).not.toEqual(left);
  await navItem(shell, "すべての記事").click();
  await expect.poll(() => listTop(shell)).toEqual(left);

  await list(shell).getByRole("button", { name: "記事一覧を閉じる" }).click();
  await shell.getByRole("button", { name: "記事一覧を開く" }).click();
  await expect.poll(() => listTop(shell)).toEqual(left);

  await shell.reload();
  await expect.poll(() => listTop(shell), { timeout: 30_000 }).toEqual(left);
});

test("a list scrolled back to its top opens at its top", async ({ shell }) => {
  await start(shell);
  const body = list(shell).locator(".list-body");
  await body.evaluate((el) => el.scrollTo(0, 3000));
  await expect.poll(() => stored(shell, "lattice.listPlaces")).toContain("offset");
  await body.evaluate((el) => el.scrollTo(0, 0));
  await expect.poll(() => stored(shell, "lattice.listPlaces")).toBe("[]");
  await shell.reload();
  await expect(list(shell).locator(".row").first()).toBeVisible({ timeout: 30_000 });
  expect(await body.evaluate((el) => el.scrollTop)).toBe(0);
});

test("an article opens where it was left, also after a restart, and a search result still goes to its passage", async ({ shell }) => {
  await start(shell);
  await (await listRow(shell, LONG)).click();
  const doc = shell.locator(".doc-scroll");
  await doc.getByText(para(40)).evaluate((el) => el.scrollIntoView({ block: "start" }));
  await expect.poll(() => stored(shell, "lattice.readingPlaces")).toContain(para(40));

  await (await listRow(shell, ARTICLES[2].title!)).click();
  await expect(doc.getByText(para(40))).toHaveCount(0);
  await (await listRow(shell, LONG)).click();
  await expect.poll(() => readerTop(doc)).toBe(para(40));

  await shell.reload();
  await expect.poll(() => readerTop(doc), { timeout: 30_000 }).toBe(para(40));

  // "mvcc" is in the article's second block, near its top.
  await shell.keyboard.press("/");
  await shell.keyboard.type("mvcc");
  await shell.keyboard.press("Enter");
  await shell.getByRole("region", { name: "検索結果" }).locator(".sgrp", { hasText: LONG }).locator(".hit").click();
  await expect(doc.locator("#b-202")).toBeInViewport();
  await expect.poll(() => readerTop(doc)).not.toBe(para(40));

  await doc.evaluate((el) => el.scrollTo(0, 0));
  await expect.poll(() => stored(shell, "lattice.readingPlaces")).not.toContain(para(40));
});

test("the Page view opens where the Reader was, and the Reader where the Page view was", async ({ shell }) => {
  await start(shell);
  await (await listRow(shell, LONG)).click();
  const doc = shell.locator(".doc-scroll");
  await doc.getByText(para(30)).evaluate((el) => el.scrollIntoView({ block: "start" }));
  await shell.getByRole("button", { name: "Page", exact: true }).click();
  const opened = async () => ((await callsOf(shell, "browser_open")).at(-1) as { place: { text: string; at: number } | null }).place;
  await expect.poll(async () => (await opened())?.text).toBe(para(30));
  expect((await opened())!.at, "near the block's top").toBeLessThan(0.5);

  const tab = ((await callsOf(shell, "browser_open")).at(-1) as { tab: string }).tab;
  const url = ARTICLES[1].original_url;
  await shell.evaluate(
    ([t, u]) => window.__e2e.emit("browser-page", { tab: t, url: u, loading: false, can_go_back: false, can_go_forward: false }),
    [tab, url],
  );
  // Taken once the page's article is looked up for its address: until then the tab's article may be the last page's.
  await expect
    .poll(async () => {
      await shell.evaluate((t) => window.__e2e.emit("browser-place", { tab: t, place: { text: "Paragraph 60 of the long", at: 0 } }), tab);
      return stored(shell, "lattice.readingPlaces");
    })
    .toContain("Paragraph 60 of the long");
  await shell.getByRole("button", { name: "Reader", exact: true }).click();
  await expect.poll(() => readerTop(doc)).toBe(para(60));

  // The page read back to its top: the article, and this tab's Reader too, start at the top.
  await shell.getByRole("button", { name: "Page", exact: true }).click();
  await expect.poll(async () => (await opened())?.text).toBe(para(60));
  const again = ((await callsOf(shell, "browser_open")).at(-1) as { tab: string }).tab;
  await shell.evaluate(
    ([t, u]) => window.__e2e.emit("browser-page", { tab: t, url: u, loading: false, can_go_back: false, can_go_forward: false }),
    [again, url],
  );
  await expect
    .poll(async () => {
      await shell.evaluate((t) => window.__e2e.emit("browser-place", { tab: t, place: null }), again);
      return stored(shell, "lattice.readingPlaces");
    })
    .not.toContain("Paragraph 60");
  await shell.getByRole("button", { name: "Reader", exact: true }).click();
  await expect(doc.getByText(para(79))).toBeAttached();
  await shell.waitForTimeout(300);
  expect(await doc.evaluate((el) => el.scrollTop)).toBe(0);
});

test("the same article in two tabs keeps a place in each", async ({ shell }) => {
  await start(shell);
  await (await listRow(shell, LONG)).click();
  const doc = shell.locator(".doc-scroll");
  await doc.getByText(para(20)).evaluate((el) => el.scrollIntoView({ block: "start" }));
  await (await listRow(shell, LONG)).click({ modifiers: ["Control"] });
  const tabs = shell.getByRole("tab");
  await expect(tabs).toHaveCount(2);
  await tabs.nth(1).click();
  await expect.poll(() => readerTop(doc), "a new tab opens where the article was left").toBe(para(20));
  await doc.getByText(para(50)).evaluate((el) => el.scrollIntoView({ block: "start" }));
  await expect.poll(() => stored(shell, "lattice.readingPlaces")).toContain(para(50));
  await tabs.nth(0).click();
  await expect.poll(() => readerTop(doc)).toBe(para(20));
  await tabs.nth(1).click();
  await expect.poll(() => readerTop(doc)).toBe(para(50));
});
