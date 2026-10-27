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

test("the data folder opens through the backend without a webview-supplied path", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  const nav = app.getByRole("navigation", { name: "設定カテゴリ" });
  await nav
    .locator(".ni")
    .filter({ has: app.locator(".label").getByText("ログ・保存場所", { exact: true }) })
    .click();
  await expect(app.locator(".stg main")).toContainText("AppData\\Roaming\\Lattice");
  await app.getByRole("button", { name: "フォルダを開く", exact: true }).click();
  await expect.poll(() => callsOf(app, "open_data_dir")).toEqual([{}]);
});

test("portable storage can be opened even though its location cannot be changed", async ({ app }) => {
  await app.evaluate(() => {
    const internals: unknown = Reflect.get(window, "__TAURI_INTERNALS__");
    if (!internals || typeof internals !== "object" || !("invoke" in internals) || typeof internals.invoke !== "function") {
      throw new Error("Tauri invoke is unavailable");
    }
    const invoke = internals.invoke;
    internals.invoke = async (cmd: string, args?: unknown, options?: unknown): Promise<unknown> => {
      const result: unknown = await Reflect.apply(invoke, internals, [cmd, args, options]);
      if (cmd === "get_settings" && result && typeof result === "object") {
        return { ...result, location: "portable", data_dir: "C:\\Lattice\\data" };
      }
      return result;
    };
  });
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  const nav = app.getByRole("navigation", { name: "設定カテゴリ" });
  await nav
    .locator(".ni")
    .filter({ has: app.locator(".label").getByText("ログ・保存場所", { exact: true }) })
    .click();
  await expect(app.locator(".stg main")).toContainText("C:\\Lattice\\data");
  await expect(app.getByRole("button", { name: "変更…", exact: true })).toBeHidden();
  await app.getByRole("button", { name: "フォルダを開く", exact: true }).click();
  await expect.poll(() => callsOf(app, "open_data_dir")).toEqual([{}]);
});

test("article download rules are not exposed in settings", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  const nav = app.getByRole("navigation", { name: "設定カテゴリ" });
  await expect(nav.getByRole("button", { name: "通信先の制限", exact: true })).toHaveCount(0);
  await expect(app.getByLabel("許可する通信先", { exact: true })).toHaveCount(0);
  await expect.poll(() => callsOf(app, "get_network_settings")).toEqual([]);
  await expect.poll(() => callsOf(app, "set_network_settings")).toEqual([]);
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
