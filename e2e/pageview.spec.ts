// The page webview's visibility as the UI drives it (the native webview itself is not in the mock).
import { test, expect, list, navItem } from "./harness.ts";
import type { Page } from "@playwright/test";

const LAYOUT = { root: { kind: "pane", id: 1, tabs: [{ kind: "page", id: 3, key: "k1", url: "https://example.com/p", title: "P" }], active: 3 }, focused: 1 };
/** set_bounds (shows the webview) and hide calls for the tab, in the order they were sent. */
const shows = (page: Page) =>
  page.evaluate(() =>
    window.__e2e.calls.filter((c) => c.cmd === "browser_set_bounds" || c.cmd === "browser_hide").map((c) => (c.cmd === "browser_hide" ? "hide" : "show")),
  );

test("leaving the library hides the page, and coming back shows it with no hide sent after the show", async ({ shell }) => {
  await shell.addInitScript((l) => localStorage.setItem("lattice.layout", l), JSON.stringify(LAYOUT));
  await shell.goto("/");
  await expect(list(shell).locator(".row").first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => shows(shell)).toContain("show");
  // StrictMode mounts the view twice: no hide goes out between the two mounts' shows.
  expect(await shows(shell)).not.toContain("hide");

  await navItem(shell, "処理状況").click();
  await expect.poll(async () => (await shows(shell)).at(-1)).toBe("hide");
  const before = (await shows(shell)).length;
  await navItem(shell, "すべての記事").click();
  await expect.poll(async () => (await shows(shell)).slice(before)).toContain("show");
  await shell.waitForTimeout(300);
  const after = (await shows(shell)).slice(before);
  expect(after.at(-1), `sent after coming back: ${after.join(", ")}`).toBe("show");
  expect(after).not.toContain("hide");
});
