// The title bar, the toolbars and the Reader / Page parity (H8–H14).
import { test, expect, list, callsOf } from "./harness.ts";
import type { Page } from "@playwright/test";

const more = (page: Page) => page.locator(".docbar [aria-haspopup=menu]").last();

/** Opens the first article, then its Page view, and lets the page finish loading. */
async function openPage(app: Page) {
  await list(app).locator(".row").first().click();
  await app.locator(".docbar").getByRole("button", { name: "Page" }).click();
  await expect.poll(async () => (await callsOf(app, "browser_open")).length).toBeGreaterThan(0);
  const { tab, url } = (await callsOf(app, "browser_open")).at(-1) as { tab: string; url: string };
  await app.evaluate((p) => window.__e2e.emit("browser-page", p), { tab, url, loading: false, can_go_back: false, can_go_forward: false });
}

test("the ⋯ menu draws its text in the frame it first appears (H8)", async ({ app }) => {
  await list(app).locator(".row").first().click();
  // The UI's font subsets are fetched while idle after startup.
  await app.evaluate(() => document.fonts.ready);
  await app.waitForTimeout(500);
  const first = app.evaluate(() => new Promise<boolean>((done) => {
    const frame = () => {
      const m = document.querySelector(".menu");
      if (!m) return requestAnimationFrame(frame);
      done([...m.querySelectorAll("button")].every((b) => document.fonts.check(`12px "IBM Plex Sans JP"`, b.textContent ?? "")));
    };
    requestAnimationFrame(frame);
  }));
  await more(app).click();
  expect(await first, "the menu's glyphs were loaded when it was first drawn").toBe(true);
});

test("on Page, a still captured when the pointer reaches ⋯ lets the menu hide the webview without a new capture (H8)", async ({ app }) => {
  await openPage(app);
  await more(app).hover();
  await expect.poll(async () => (await callsOf(app, "browser_capture")).length).toBe(1);
  await more(app).click();
  await expect(app.getByRole("menu")).toBeVisible();
  await expect.poll(async () => (await callsOf(app, "browser_hide")).length).toBeGreaterThan(0);
  expect(await callsOf(app, "browser_capture")).toHaveLength(1);
  await expect(app.locator(".page-still")).toBeVisible();
});
