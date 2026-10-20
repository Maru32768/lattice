import { test, expect, callsOf } from "./harness.ts";
import type { Page } from "@playwright/test";

const section = (app: Page, title: string) =>
  app.getByRole("navigation", { name: "設定カテゴリ" }).locator(".ni").filter({ has: app.locator(".label").getByText(title, { exact: true }) });

test("the chat budget is a setting under 要約・対話 and persists", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  await section(app, "要約・対話").click();
  const budget = app.getByLabel("対話で使う範囲");
  await expect(budget).toHaveValue("standard");
  await budget.selectOption({ label: "多め（約 15 万字）" });
  expect(await callsOf(app, "set_chat_budget")).toEqual([{ budget: "large" }]);

  await section(app, "翻訳").click();
  await section(app, "要約・対話").click();
  await expect(app.getByLabel("対話で使う範囲")).toHaveValue("large");
});
