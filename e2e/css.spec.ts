// Pointer feedback and text selection (H6).
import { test, expect, list } from "./harness.ts";
import type { Locator } from "@playwright/test";

const style = (l: Locator, prop: "cursor" | "userSelect") => l.evaluate((e, p) => getComputedStyle(e)[p], prop);

test("clickable controls show the hand; the nav and the list do not select as text, the Reader does", async ({ app }) => {
  await list(app).locator(".row").first().click();
  expect(await style(list(app).locator(".row").first(), "cursor")).toBe("pointer");
  expect(await style(list(app).locator(".chip").first(), "cursor")).toBe("pointer");
  expect(await style(app.locator(".dpane").first().getByRole("tab").first(), "cursor")).toBe("pointer");
  expect(await style(app.locator(".nav"), "userSelect")).toBe("none");
  expect(await style(list(app), "userSelect")).toBe("none");
  expect(await style(app.locator(".art-title"), "userSelect")).not.toBe("none");

  await app.locator(".nav").getByRole("button", { name: "管理", exact: true }).click();
  expect(await style(app.locator("label", { hasText: "OPML を読み込む" }), "cursor"), "a label opening a file picker").toBe("pointer");
});

test("a disabled button shows not-allowed and keeps its tooltip", async ({ app }) => {
  const forward = app.getByRole("banner").getByRole("button", { name: "進む" });
  await expect(forward).toBeDisabled();
  expect(await style(forward, "cursor")).toBe("not-allowed");
  await expect(forward).toHaveAttribute("title", /進む/);
});
