import { test as base, expect, type Page } from "@playwright/test";
import { NOW } from "./fixtures.ts";

/**
 * `shell`: a page not yet navigated (a spec opens it as the main window or a pop-out). `app`: the
 * main window with the library loaded. Both fail the test when the app called a command the mock
 * does not answer, threw, or logged an error.
 */
export const test = base.extend<{ shell: Page; app: Page }>({
  shell: async ({ page }, provide) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => {
      if (m.type() === "error") {
        errors.push(m.text());
      }
    });
    await page.clock.setFixedTime(NOW);
    await provide(page);
    expect(await page.evaluate(() => window.__e2e.unmocked), "commands the mock does not answer").toEqual([]);
    expect(errors, "page errors").toEqual([]);
  },
  app: async ({ shell }, provide) => {
    await shell.goto("/");
    // The first pages after the dev server starts wait for it to transform the app.
    await expect(list(shell).locator(".row").first()).toBeVisible({ timeout: 30_000 });
    await provide(shell);
  },
});

export { expect };

/** The arguments of every call of `cmd` so far. */
export const callsOf = (page: Page, cmd: string) => page.evaluate((c) => window.__e2e.calls.filter((x) => x.cmd === c).map((x) => x.args), cmd);

/** A sidebar entry by its exact label; its count is `.n`. */
export const navItem = (page: Page, label: string) => page.locator(".nav .ni").filter({ has: page.locator(".label").getByText(label, { exact: true }) });

/** The article list, in either display language. */
export const list = (page: Page) => page.getByRole("region", { name: /^(記事一覧|Articles)$/ });
export const listCount = (page: Page) => list(page).locator(".count");

/**
 * The list row of the article titled `title`, scrolled into view first: the list is virtualized, so a row
 * out of view is not in the DOM until the list scrolls to it.
 */
export async function listRow(page: Page, title: string) {
  const row = list(page).locator(".row", { hasText: title });
  const body = list(page).locator(".list-body");
  await expect(list(page).locator(".row").first()).toBeVisible();
  // The list draws the range it scrolled to a frame or more later: a row counted before then can be unmounted after,
  // which left scrollIntoViewIfNeeded waiting for good. Such a scan starts over.
  await expect(async () => {
    await body.evaluate((el) => el.scrollTo(0, 0));
    await page.evaluate(() => new Promise(requestAnimationFrame));
    for (let i = 0; i < 100 && (await row.count()) === 0; i++) {
      const end = await body.evaluate((el) => {
        el.scrollBy(0, el.clientHeight / 2);
        return el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
      });
      // Let the list draw what it scrolled to before looking again.
      await page.evaluate(() => new Promise(requestAnimationFrame));
      if (end && i > 0 && (await row.count()) === 0) {
        break;
      }
    }
    await row.first().scrollIntoViewIfNeeded({ timeout: 2000 });
  }).toPass();
  return row;
}
