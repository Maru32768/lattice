// The page webview's visibility as the UI drives it (the native webview itself is not in the mock).
import { test, expect, callsOf, list, navItem } from "./harness.ts";
import { GROUPS } from "./fixtures.ts";
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

test("a page's tab shows the overlay's translation while it runs, and nothing once it is done", async ({ shell }) => {
  await shell.addInitScript((l) => localStorage.setItem("lattice.layout", l), JSON.stringify(LAYOUT));
  await shell.goto("/");
  const tab = shell.getByRole("tab", { name: "P" });
  await expect(tab).toBeVisible({ timeout: 30_000 });
  await shell.evaluate(() => window.__e2e.emit("browser-translate", { tab: "k1", done: 3, total: 10 }));
  await expect(tab.getByRole("status")).toHaveText("翻訳中3/10");
  await shell.evaluate(() => window.__e2e.emit("browser-translate", { tab: "k1", done: 10, total: 10 }));
  await expect(tab.getByRole("status")).toHaveCount(0);
});

test("a link the page opens in a new window (middle-click) opens a tab behind its own, which stays in front", async ({ shell }) => {
  await shell.addInitScript((l) => localStorage.setItem("lattice.layout", l), JSON.stringify(LAYOUT));
  await shell.goto("/");
  await expect(shell.getByRole("tab", { name: "P" })).toBeVisible({ timeout: 30_000 });
  await shell.evaluate(() => window.__e2e.emit("browser-new-tab", { tab: "k1", url: "https://example.com/q" }));
  const tabs = shell.getByRole("tab");
  await expect(tabs).toHaveCount(2);
  await expect(tabs.first()).toHaveAccessibleName(/P/);
  await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "false");
  await tabs.nth(1).click();
  await expect
    .poll(() => shell.evaluate(() => window.__e2e.calls.filter((c) => c.cmd === "browser_open").map((c) => (c.args as { url: string }).url)))
    .toContain("https://example.com/q");
});

test("saving a page while a group's list is open puts it in that group too", async ({ shell }) => {
  await shell.addInitScript((l) => localStorage.setItem("lattice.layout", l), JSON.stringify(LAYOUT));
  await shell.goto("/");
  await expect(list(shell).locator(".row").first()).toBeVisible({ timeout: 30_000 });
  const group = GROUPS[0];
  await navItem(shell, group.name).click();
  const save = shell.getByRole("button", { name: "ライブラリに保存" });
  await expect(save).toHaveAttribute("title", new RegExp(`開いているグループ「${group.name}」にも入れます`));
  await save.click();
  await expect.poll(async () => (await callsOf(shell, "group_add")).at(-1)).toMatchObject({ id: group.id });
  await expect(list(shell).locator(".row", { hasText: "Saved page" })).toBeVisible();
});

test("a page that fails to open is not opened again and again", async ({ shell }) => {
  await shell.addInitScript((l) => localStorage.setItem("lattice.layout", l), JSON.stringify(LAYOUT));
  await shell.goto("/");
  await expect(shell.getByRole("tab", { name: "P" })).toBeVisible({ timeout: 30_000 });
  // From now on no webview can be made (as with os error 1455), and none is there.
  await shell.evaluate(() => {
    type Invoke = (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__;
    const invoke = internals.invoke;
    internals.invoke = (cmd, args, options) => {
      if (cmd === "browser_open") {
        window.__e2e.calls.push({ cmd, args });
        return Promise.reject(new Error("os error 1455"));
      }
      return cmd === "browser_set_bounds" ? Promise.resolve(false) : invoke(cmd, args, options);
    };
  });
  const before = (await callsOf(shell, "browser_open")).length;
  await shell.evaluate(() => window.__e2e.emit("browser-new-tab", { tab: "k1", url: "https://example.com/q" }));
  await shell.getByRole("tab").nth(1).click();
  await expect(shell.getByRole("alert")).toContainText("1455");
  await shell.waitForTimeout(1500);
  expect((await callsOf(shell, "browser_open")).length - before, "not a loop of opens").toBeLessThan(4);
});

test("a window that reloads with a layout that lost a Page tab asks the backend to close that tab's webview", async ({ app }) => {
  const kept = async () => ((await callsOf(app, "browser_retain")) as { keep: string[] }[]).map((c) => c.keep);
  await app.evaluate((l) => localStorage.setItem("lattice.layout", l), JSON.stringify(LAYOUT));
  await app.reload();
  await expect(app.getByRole("tab", { name: "P" })).toBeVisible({ timeout: 30_000 });
  await expect.poll(kept).toContainEqual(["k1"]);

  // The stored layout is replaced while k1's webview is open, as a script or another build of the app can.
  const other = { root: { kind: "pane", id: 1, tabs: [{ kind: "page", id: 4, key: "k2", url: "https://example.com/q", title: "Q" }], active: 4 }, focused: 1 };
  await app.evaluate((l) => localStorage.setItem("lattice.layout", l), JSON.stringify(other));
  await app.reload();
  await expect(app.getByRole("tab", { name: "Q" })).toBeVisible({ timeout: 30_000 });
  await expect.poll(kept).toContainEqual(["k2"]);
  expect((await kept()).flat(), "k1 is no tab of this window now").not.toContain("k1");
});
