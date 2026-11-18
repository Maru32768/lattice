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

  await app.locator(".nav").getByRole("button", { name: "ソースを管理" }).click();
  expect(await style(app.locator("label", { hasText: "OPMLを読み込む" }), "cursor"), "a label opening a file picker").toBe("pointer");
});

test("a disabled button shows not-allowed and keeps its tooltip", async ({ app }) => {
  const forward = app.getByRole("banner").getByRole("button", { name: "進む" });
  await expect(forward).toBeDisabled();
  expect(await style(forward, "cursor")).toBe("not-allowed");
  await expect(forward).toHaveAttribute("title", /進む/);
});

test("a select in a chip shows one focus ring, the chip's", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "対話" }).click();
  const provider = app.getByLabel("回答するAI", { exact: true });
  await provider.focus();
  await app.keyboard.press("Shift+Tab");
  await app.keyboard.press("Tab");
  await expect(provider).toBeFocused();
  const rings = await provider.evaluate((e) => ({
    keyboard: e.matches(":focus-visible"),
    own: getComputedStyle(e).outlineStyle,
    chip: getComputedStyle(e.closest(".chip")!).boxShadow,
  }));
  expect(rings.keyboard, "focused from the keyboard").toBe(true);
  expect(rings.own).toBe("none");
  expect(rings.chip).not.toBe("none");
});
