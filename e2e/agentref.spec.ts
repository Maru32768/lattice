// エージェント用にコピー: the reference to an article, or to the passage selected in it, that an agent's `get` reads.
import { test, expect, list } from "./harness.ts";
import { ARTICLES, SNAPSHOT_ID } from "./fixtures.ts";
import type { Page } from "@playwright/test";

const article = ARTICLES.find((a) => a.id !== SNAPSHOT_ID && a.title && a.fetch_status === "ok" && a.language !== "ja")!;
/** Its two paragraphs, after the heading. */
const [first, second] = [article.id * 100 + 2, article.id * 100 + 3];
const ref = `lattice:article/${article.id}`;

const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());
const menu = (page: Page) => page.getByRole("menu");
const bar = (page: Page) => page.locator(".vw-cap");

test.beforeEach(async ({ app }) => {
  await app.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await app.evaluate(() => navigator.clipboard.writeText(""));
});

test("the row's, the tab's and the Reader's menus copy the article's reference", async ({ app }) => {
  const row = list(app).locator(".row", { hasText: article.title! });
  await row.click({ button: "right" });
  await menu(app).getByRole("menuitem", { name: "エージェント用にコピー" }).click();
  await expect.poll(() => clipboard(app)).toBe(ref);

  await row.click();
  await expect(app.locator(".art-title")).toHaveText(article.title!);
  await app.evaluate(() => navigator.clipboard.writeText(""));
  await app.locator(".dpane").first().getByRole("tab").first().click({ button: "right" });
  await menu(app).getByRole("menuitem", { name: "エージェント用にコピー" }).click();
  await expect.poll(() => clipboard(app)).toBe(ref);

  await app.evaluate(() => navigator.clipboard.writeText(""));
  await app.locator(".docbar [aria-haspopup=menu]").last().click();
  await menu(app).getByRole("menuitem", { name: "エージェント用にコピー" }).click();
  await expect.poll(() => clipboard(app)).toBe(ref);

  // A right-click leaves the open article selected: the item copies the row's article, not that one.
  const other = ARTICLES.find((a) => a.id !== article.id && a.title && a.fetch_status === "ok")!;
  await app.evaluate(() => navigator.clipboard.writeText(""));
  await list(app).locator(".row", { hasText: other.title! }).click({ button: "right" });
  await expect(app.locator(".art-title")).toHaveText(article.title!);
  await menu(app).getByRole("menuitem", { name: "エージェント用にコピー" }).click();
  await expect.poll(() => clipboard(app)).toBe(`lattice:article/${other.id}`);
});

test("the bar over a selected passage copies the blocks it starts and ends in", async ({ app }) => {
  await list(app).locator(".row", { hasText: article.title! }).click();
  await expect(app.locator(".art-title")).toHaveText(article.title!);

  // A triple click selects up to the start of the next block, which the passage does not take.
  await app.locator(`#b-${first} p`).click({ clickCount: 3 });
  await bar(app).getByRole("button", { name: "エージェント用にコピー" }).click();
  await expect(bar(app)).toHaveText("参照をコピーしました");
  await expect.poll(() => clipboard(app)).toBe(`${ref}#b${first}`);

  await app.evaluate(
    ([from, to]) => {
      const [start, end] = [from, to].map((id) => document.querySelector(`#b-${id} p`)!);
      const r = document.createRange();
      r.setStart(start, 0);
      r.setEnd(end, end.childNodes.length);
      start.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(r);
      end.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    },
    [first, second],
  );
  await bar(app).getByRole("button", { name: "エージェント用にコピー" }).click();
  await expect.poll(() => clipboard(app)).toBe(`${ref}#b${first}-b${second}`);

  // A drag from the blank space after a paragraph's last line starts at that paragraph's end, taking none of it.
  await app.evaluate(
    ([from, to]) => {
      const [start, end] = [from, to].map((id) => document.querySelector(`#b-${id} p`)!);
      const r = document.createRange();
      r.setStart(start, start.childNodes.length);
      r.setEnd(end, end.childNodes.length);
      start.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(r);
      end.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    },
    [first, second],
  );
  await bar(app).getByRole("button", { name: "エージェント用にコピー" }).click();
  await expect.poll(() => clipboard(app)).toBe(`${ref}#b${second}`);
});

test("an open tooltip's text does not make the paragraph it hangs from part of the reference", async ({ app }) => {
  const snapshot = ARTICLES.find((a) => a.id === SNAPSHOT_ID)!;
  await list(app).locator(".row", { hasText: snapshot.title! }).click();
  await app.locator("#b-102 .sent").hover();
  await expect(app.locator("#b-102 .pop")).toBeVisible();
  // As a drag down from the blank after the first paragraph's line, across its tooltip.
  await app.evaluate(() => {
    const [start, end] = ["#b-102 p", "#b-103 p"].map((s) => document.querySelector(s)!);
    const r = document.createRange();
    r.setStart(start, start.childNodes.length);
    r.setEnd(end, end.childNodes.length);
    start.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(r);
    end.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await bar(app).getByRole("button", { name: "エージェント用にコピー" }).click();
  await expect.poll(() => clipboard(app)).toBe(`lattice:article/${SNAPSHOT_ID}#b103`);
});
