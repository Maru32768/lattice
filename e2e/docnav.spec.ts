// Moving around a document by keys: the Reader's host of the controller the page overlay also runs.
import { test as base, expect, callsOf } from "./harness.ts";

const PAGE_LAYOUT = {
  root: { kind: "pane", id: 1, tabs: [{ kind: "page", id: 3, key: "k1", url: "https://example.com/p", title: "P" }], active: 3 },
  focused: 1,
};

base("the second key of a chord that reached the app runs in the page, and the page gets the keyboard back", async ({ shell }) => {
  await shell.addInitScript((l) => localStorage.setItem("lattice.layout", l), JSON.stringify(PAGE_LAYOUT));
  await shell.goto("/");
  await expect(shell.locator(".page-host")).toBeVisible();
  await shell.evaluate(() => window.__e2e.emit("browser-key", { tab: "k1", key: "G", count: 1 }));
  await expect(shell.locator(".prefix-hint")).toBeVisible();
  const focused = (await callsOf(shell, "browser_focus")).length;
  await shell.keyboard.press("g");
  await expect.poll(() => callsOf(shell, "browser_run_doc")).toEqual([{ key: "k1", action: "docTop", count: 1 }]);
  await expect.poll(async () => (await callsOf(shell, "browser_focus")).length).toBeGreaterThan(focused);
  await expect(shell.locator(".prefix-hint")).toBeHidden();
});
