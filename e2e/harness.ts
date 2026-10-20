import { test as base, expect, type Page } from "@playwright/test";
import { NOW } from "./fixtures.ts";

/**
 * `app`: the page with the library loaded. Fails the test when the app called a command the mock
 * does not answer, threw, or logged an error.
 */
export const test = base.extend<{ app: Page }>({
  app: async ({ page }, provide) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await page.clock.setFixedTime(NOW);
    await page.goto("/");
    // The first pages after the dev server starts wait for it to transform the app.
    await expect(list(page).locator(".row").first()).toBeVisible({ timeout: 30_000 });
    await provide(page);
    expect(await page.evaluate(() => window.__e2e.unmocked), "commands the mock does not answer").toEqual([]);
    expect(errors, "page errors").toEqual([]);
  },
});

export { expect };

/** The arguments of every call of `cmd` so far. */
export const callsOf = (page: Page, cmd: string) =>
  page.evaluate((c) => window.__e2e.calls.filter((x) => x.cmd === c).map((x) => x.args), cmd);

/** A sidebar entry by its exact label; its count is `.n`. */
export const navItem = (page: Page, label: string) =>
  page.locator(".nav .ni").filter({ has: page.locator(".label").getByText(label, { exact: true }) });

/** The article list, in either display language. */
export const list = (page: Page) => page.getByRole("region", { name: /^(記事一覧|Articles)$/ });
export const listCount = (page: Page) => list(page).locator(".count");
