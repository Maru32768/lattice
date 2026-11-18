// Pointer feedback and text selection (H6).
import { test, expect, chatScope, list } from "./harness.ts";
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

/** A control focused from the keyboard draws one ring: its own outline or box-shadow, or its chip's box-shadow. */
async function expectOneRing(control: Locator) {
  await expect(control).toBeFocused();
  const rings = await control.evaluate((e) => {
    const chip = e.closest(".chip")!;
    const drawn = [
      getComputedStyle(e).outlineStyle !== "none",
      getComputedStyle(e).boxShadow !== "none",
      chip !== e && getComputedStyle(chip).boxShadow !== "none",
    ];
    return { keyboard: e.matches(":focus-visible"), count: drawn.filter(Boolean).length };
  });
  expect(rings.keyboard, "focused from the keyboard").toBe(true);
  expect(rings.count, `${await control.getAttribute("aria-label")}: one ring`).toBe(1);
}

test("each control in the chat's scope and AI rows shows one focus ring: a select the chip's, the 範囲 button its own", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "対話" }).click();
  const provider = app.getByLabel("回答するAI", { exact: true });
  await provider.selectOption({ label: "Claude CLI" });
  const scope = chatScope(app);
  await scope.focus();
  await app.keyboard.press("Shift+Tab");
  await app.keyboard.press("Tab");
  for (const control of [scope, provider, app.getByLabel("回答するモデル", { exact: true }), app.getByLabel("回答するAIのeffort", { exact: true })]) {
    await expectOneRing(control);
    await app.keyboard.press("Tab");
  }
});

test("the search pane's scope select shows one focus ring, its chip's", async ({ app }) => {
  await app.keyboard.press("/");
  const scope = app.getByLabel("検索範囲");
  await scope.focus();
  await app.keyboard.press("Shift+Tab");
  await app.keyboard.press("Tab");
  await expectOneRing(scope);
});
