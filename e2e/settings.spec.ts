import { test, expect, navItem, callsOf } from "./harness.ts";

const SECTIONS = [
  "AI プロバイダ",
  "翻訳",
  "要約・対話",
  "自動分類",
  "重要度",
  "ジャンル",
  "取り込み・JS 描画",
  "取り込みフィルタ",
  "画像",
  "通信先の制限",
  "復習",
  "表示言語",
  "ショートカット",
  "ブラウザ",
  "起動・タスクバー",
  "バックアップ",
  "クラウドバックアップ（R2）",
  "エクスポート",
  "ログ・保存場所",
  "アップデート",
];

test("every settings section renders, and Esc goes back to the library", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  const nav = app.getByRole("navigation", { name: "設定カテゴリ" });
  const heading = app.locator(".stg main h1");
  await expect(nav.locator(".ni .label")).toHaveText(SECTIONS);
  const section = (title: string) => nav.locator(".ni").filter({ has: app.locator(".label").getByText(title, { exact: true }) });
  for (const title of SECTIONS) {
    await section(title).click();
    await expect(heading).toHaveText(title);
  }
  await section("ログ・保存場所").click();
  await expect(app.locator(".stg main")).toContainText("lattice.db");
  await section("AI プロバイダ").click();
  await expect(section("AI プロバイダ")).toContainText("2 段");

  await app.keyboard.press("Escape");
  await expect(nav).toBeHidden();
  await expect(navItem(app, "すべての記事")).toBeVisible();
});

test("the launch-at-sign-in switch keeps what was chosen", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  const nav = app.getByRole("navigation", { name: "設定カテゴリ" });
  const section = (title: string) => nav.locator(".ni").filter({ has: app.locator(".label").getByText(title, { exact: true }) });
  await section("起動・タスクバー").click();
  const autostart = app.getByRole("switch", { name: "Windows の起動時に Lattice を起動" });
  await expect(autostart).not.toBeChecked();
  await autostart.click();
  await section("ブラウザ").click();
  await section("起動・タスクバー").click();
  await expect(autostart).toBeChecked();
});

test("network rules save together, persist on reopening and keep invalid drafts out of saved settings", async ({ app }, testInfo) => {
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  const nav = app.getByRole("navigation", { name: "設定カテゴリ" });
  const section = (title: string) => nav.locator(".ni").filter({ has: app.locator(".label").getByText(title, { exact: true }) });
  await section("通信先の制限").click();
  const allow = app.getByLabel("許可する通信先", { exact: true });
  const deny = app.getByLabel("拒否する通信先", { exact: true });
  await expect(allow).toBeEnabled();
  expect((await allow.boundingBox())?.height).toBeGreaterThanOrEqual(100);
  await expect(allow).toHaveValue("");
  await allow.fill("localhost\n192.168.1.0/24\n*.example.com\n");
  await deny.fill("blocked.example.com");
  await app.getByText("詳細設定", { exact: true }).click();
  await app.getByLabel("許可方式", { exact: true }).selectOption("allowlist");
  await app.getByRole("button", { name: "保存", exact: true }).click();
  await expect(app.getByRole("status")).toHaveText("保存しました");
  expect(await callsOf(app, "set_network_settings")).toEqual([
    { settings: { mode: "allowlist", allow: ["localhost", "192.168.1.0/24", "*.example.com"], deny: ["blocked.example.com"] } },
  ]);
  await section("ブラウザ").click();
  await section("通信先の制限").click();
  await expect(allow).toHaveValue("localhost\n192.168.1.0/24\n*.example.com");
  await expect(deny).toHaveValue("blocked.example.com");
  await expect(app.locator(".stg main")).toContainText("最終的な接続先 IP を確認できない");
  await expect(app.locator(".stg main")).toContainText("内蔵ブラウザ・JS 描画");

  await allow.fill("https://bad.example/path");
  await app.getByRole("button", { name: "保存", exact: true }).click();
  await expect(app.getByRole("alert")).toContainText("通信先のルールが無効です");
  await section("ブラウザ").click();
  await section("通信先の制限").click();
  await expect(allow).toHaveValue("localhost\n192.168.1.0/24\n*.example.com");
  await app.getByText("詳細設定", { exact: true }).click();
  await expect(app.getByLabel("許可方式", { exact: true })).toHaveValue("allowlist");
  await app.getByLabel("許可方式", { exact: true }).selectOption("unrestricted");
  await app.getByRole("button", { name: "保存", exact: true }).click();
  await expect(app.getByRole("status")).toHaveText("保存しました");
  await section("ブラウザ").click();
  await section("通信先の制限").click();
  await app.getByText("詳細設定", { exact: true }).click();
  await expect(app.getByLabel("許可方式", { exact: true })).toHaveValue("unrestricted");
  await app.screenshot({ path: testInfo.outputPath("network-settings.png") });
});

test("in a narrow window the provider chain wraps instead of squeezing its selects to nothing", async ({ app }) => {
  await app.setViewportSize({ width: 820, height: 800 });
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  await app
    .getByRole("navigation", { name: "設定カテゴリ" })
    .locator(".ni")
    .filter({ has: app.locator(".label").getByText("AI プロバイダ", { exact: true }) })
    .click();
  for (const name of ["1 段目のモデル", "1 段目の effort", "2 段目のモデル", "2 段目の effort"]) {
    const box = await app.getByRole("combobox", { name }).boundingBox();
    // A custom model ID shares the line with its select: each keeps at least 7em.
    expect(box?.width, name).toBeGreaterThanOrEqual(80);
  }
});
