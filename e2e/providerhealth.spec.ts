import { test, expect, navItem } from "./harness.ts";

test("a chain step that fails while another answers is shown in AI プロバイダ and 処理状況", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  await app.getByRole("navigation", { name: "設定カテゴリ" }).getByText("AI プロバイダ", { exact: true }).click();
  await expect(app.locator(".provider-health"), "every step answers").toHaveCount(0);

  // The mock's Codex CLI step fails as if the CLI were not installed.
  await app.getByRole("combobox", { name: "3 段目のプロバイダ" }).selectOption({ label: "Codex CLI" });
  await app.locator(".btn-row").getByRole("button", { name: "保存", exact: true }).click();
  const notice = app.locator(".provider-health");
  await expect(notice).toContainText(/Codex CLI \(.+\) の直近の呼び出しが失敗しました/);
  await expect(notice).toContainText("codex: not found");
  await expect(notice).toContainText("5 分間はほかの段を先に使います");

  await app.getByRole("button", { name: "ライブラリに戻る" }).click();
  await navItem(app, "処理状況").click();
  await expect(app.locator("main.manage .provider-health")).toContainText("codex: not found");
});
