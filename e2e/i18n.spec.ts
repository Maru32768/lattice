import { test, expect, callsOf } from "./harness.ts";

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

  await app.getByLabel("Display language").selectOption("ja");
  await expect(app.locator(".stg main h1")).toHaveText("表示言語");
});
