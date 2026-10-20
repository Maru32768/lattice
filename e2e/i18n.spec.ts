import { test, expect, callsOf, navItem } from "./harness.ts";

test("the display language switches live in Settings and is stored in the backend", async ({ app }) => {
  expect(await callsOf(app, "set_ui_language"), "the first start stores the detected language").toContainEqual({ lang: "ja" });
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  const nav = app.getByRole("navigation", { name: "設定カテゴリ" });
  await nav.getByRole("button", { name: "表示言語" }).click();
  await app.getByLabel("表示言語").selectOption("en");

  const navEn = app.getByRole("navigation", { name: "Settings categories" });
  await expect(app.locator(".stg main h1")).toHaveText("Display language");
  await expect(navEn.getByRole("button", { name: "AI providers" })).toBeVisible();
  await expect(navEn).toContainText("Back to library");
  await expect(app.locator("html")).toHaveAttribute("lang", "en");
  expect((await callsOf(app, "set_ui_language")).at(-1)).toEqual({ lang: "en" });
  await navEn.getByRole("button", { name: "Translation" }).click();
  await expect(app.getByText("Keep technical terms in English")).toBeVisible();
  await navEn.getByRole("button", { name: "Review" }).click();
  await expect(app.getByLabel("Unit of the shortest interval")).toContainText("days");
  await navEn.getByRole("button", { name: "Shortcuts" }).click();
  await expect(app.locator(".stg main")).toContainText("Command palette");
  await navEn.getByRole("button", { name: "AI providers" }).click();
  await expect(app.getByLabel("Provider for step 1")).toBeVisible();


  await app.keyboard.press("Escape");
  await expect(navItem(app, "All articles")).toBeVisible();
  await expect(app.getByRole("region", { name: "Articles" }).locator(".row").first()).toBeVisible();
  await expect(app.getByRole("button", { name: "Sort and group" })).toContainText("Date added, newest first");

  await app.locator(".nav").getByRole("button", { name: "Settings" }).click();
  await navEn.getByRole("button", { name: "Display language" }).click();
  await app.getByLabel("Display language").selectOption("ja");
  await expect(app.locator(".stg main h1")).toHaveText("表示言語");
});
