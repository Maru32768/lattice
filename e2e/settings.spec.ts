import { test, expect, navItem, callsOf } from "./harness.ts";

const SECTIONS = [
  "AI プロバイダ",
  "自分について",
  "取り込み・JS 描画",
  "取り込みフィルタ",
  "画像",
  "翻訳",
  "要約・対話",
  "ブラウザ",
  "自動分類",
  "重要度",
  "復習",
  "表示言語",
  "ショートカット",
  "起動・タスクバー",
  "アップデート",
  "バックアップ",
  "クラウドバックアップ (R2)",
  "エクスポート",
  "ログ・保存場所",
];

test("every settings section renders, and Esc goes back to the library", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  const nav = app.getByRole("navigation", { name: "設定カテゴリ" });
  const heading = app.locator(".stg main h1");
  await expect(nav.locator(".ni .label")).toHaveText(SECTIONS);
  await expect(nav.locator(".sec")).toHaveText(["AI", "集める", "読む", "整理", "学ぶ", "アプリ", "データ"]);
  await expect(nav.getByRole("button", { name: "フィード →" })).toHaveCount(0);
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

test("翻訳しないサイト shows the stored patterns and saves the edited list", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  const nav = app.getByRole("navigation", { name: "設定カテゴリ" });
  await nav
    .locator(".ni")
    .filter({ has: app.locator(".label").getByText("翻訳", { exact: true }) })
    .click();
  const sites = app.getByRole("textbox", { name: "翻訳しないサイト" });
  await expect(sites).toHaveValue("www.google.*\nduckduckgo.com");
  const save = app.locator(".set.wide").filter({ has: sites }).getByRole("button", { name: "保存" });
  await expect(save, "nothing changed yet").toBeDisabled();
  await sites.fill("www.google.*\nhttps://Example.com/*\n");
  await save.click();
  expect(await callsOf(app, "set_page_translate_skip_sites")).toEqual([{ text: "www.google.*\nhttps://Example.com/*\n" }]);
  await expect(sites, "as stored").toHaveValue("www.google.*\nhttps://example.com/*");
  await expect(save).toBeDisabled();
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

test("自分について and 要約・対話 each save their own instructions without clearing the other's", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  const nav = app.getByRole("navigation", { name: "設定カテゴリ" });
  await nav.getByRole("button", { name: "要約・対話" }).click();
  await expect(app.getByLabel("自分について")).toHaveCount(0);
  await app.getByLabel("要約の追加の指示").fill("箇条書きで");
  await app.getByRole("button", { name: "保存", exact: true }).click();
  await nav.getByRole("button", { name: "自分について" }).click();
  await expect(app.getByLabel("要約の追加の指示")).toHaveCount(0);
  await app.getByLabel("自分について").fill("DB の運用担当");
  await app.getByRole("button", { name: "保存", exact: true }).click();
  await expect(app.getByRole("status")).toHaveText("保存しました");
  expect((await callsOf(app, "set_custom_instructions")).at(-1)).toEqual({ settings: { profile: "DB の運用担当", summary: "箇条書きで", chat: "" } });
});

test("要約を自動で作る starts off and saves all articles or an importance threshold", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  await app.getByRole("navigation", { name: "設定カテゴリ" }).getByRole("button", { name: "要約・対話" }).click();
  const auto = app.getByLabel("要約を自動で作る");
  await expect(auto).toHaveValue("off");
  await auto.selectOption({ label: "重要度 4 以上の記事" });
  await auto.selectOption({ label: "すべての記事" });
  await expect.poll(() => callsOf(app, "set_auto_summarize")).toEqual([{ mode: { important: 4 } }, { mode: "all" }]);
});

test("取り込みフィルタ links to the per-feed filters in the feed manager", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  await app.getByRole("navigation", { name: "設定カテゴリ" }).getByRole("button", { name: "取り込みフィルタ" }).click();
  await app.locator(".stg main").getByRole("button", { name: "フィードを管理" }).click();
  await expect(app.locator("main.manage h1")).toHaveText("フィードを管理");
});

test("the palette opens a settings section by name", async ({ app }) => {
  await app.keyboard.press("Control+k");
  await app.keyboard.type(">設定: 翻訳");
  await expect(app.getByRole("dialog", { name: "コマンドパレット" }).getByRole("option").first()).toHaveText(/^設定: 翻訳/);
  await app.keyboard.press("Enter");
  await expect(app.locator(".stg main h1")).toHaveText("翻訳");
});
