import { test, expect, navItem, callsOf } from "./harness.ts";

const SECTIONS = [
  "AIプロバイダ",
  "自分について",
  "取り込み・JS描画",
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
  "Vim",
  "起動・タスクバー",
  "アップデート",
  "バックアップ",
  "スマホで読む",
  "クラウドバックアップ(R2)",
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
  await section("AIプロバイダ").click();
  await expect(section("AIプロバイダ")).toContainText("2モデル");

  await app.keyboard.press("Escape");
  await expect(nav).toBeHidden();
  await expect(navItem(app, "すべての記事")).toBeVisible();
});

test("the launch-at-sign-in switch keeps what was chosen", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  const nav = app.getByRole("navigation", { name: "設定カテゴリ" });
  const section = (title: string) => nav.locator(".ni").filter({ has: app.locator(".label").getByText(title, { exact: true }) });
  await section("起動・タスクバー").click();
  const autostart = app.getByRole("switch", { name: "Windowsの起動時にLatticeを起動" });
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

test("the log folder opens through the backend, apart from the data folder", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  const nav = app.getByRole("navigation", { name: "設定カテゴリ" });
  await nav
    .locator(".ni")
    .filter({ has: app.locator(".label").getByText("ログ・保存場所", { exact: true }) })
    .click();
  await expect(app.locator(".stg main")).toContainText("AppData\\Local\\Lattice\\logs");
  await app.getByRole("button", { name: "ログのフォルダを開く", exact: true }).click();
  await expect.poll(() => callsOf(app, "open_log_dir")).toEqual([{}]);
  expect(await callsOf(app, "open_data_dir")).toEqual([]);
});

test("unused translations are deleted only after a confirmation", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  await app
    .getByRole("navigation", { name: "設定カテゴリ" })
    .locator(".ni")
    .filter({ has: app.locator(".label").getByText("ログ・保存場所", { exact: true }) })
    .click();
  const button = app.getByRole("button", { name: "12件を削除…" });
  await expect(button).toBeVisible();
  // A Page view translates 3 more while the section is open.
  await app.evaluate(() => {
    const internals: unknown = Reflect.get(window, "__TAURI_INTERNALS__");
    if (!internals || typeof internals !== "object" || !("invoke" in internals) || typeof internals.invoke !== "function") {
      throw new Error("Tauri invoke is unavailable");
    }
    const invoke = internals.invoke;
    let more = 3;
    internals.invoke = async (cmd: string, args?: unknown, options?: unknown): Promise<unknown> => {
      const result: unknown = await Reflect.apply(invoke, internals, [cmd, args, options]);
      if ((cmd === "unused_translations" || cmd === "delete_unused_translations") && typeof result === "number") {
        const n = result + more;
        if (cmd === "delete_unused_translations") {
          more = 0;
        }
        return n;
      }
      return result;
    };
  });
  await button.click();
  const dialog = app.getByRole("alertdialog", { name: "使われていない訳を削除しますか？" });
  await expect(dialog).toContainText("15件の訳を削除します");
  expect(await callsOf(app, "delete_unused_translations")).toEqual([]);
  await dialog.getByRole("button", { name: "削除" }).click();
  await expect(app.getByRole("status")).toHaveText("15件の訳を削除しました");
  await expect(app.getByRole("button", { name: "0件を削除…" })).toBeDisabled();
  expect(await callsOf(app, "delete_unused_translations")).toEqual([{}]);
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
    .filter({ has: app.locator(".label").getByText("AIプロバイダ", { exact: true }) })
    .click();
  for (const name of ["1番目のモデル", "1番目のeffort", "2番目のモデル", "2番目のeffort"]) {
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
  await app.getByLabel("自分について").fill("DBの運用担当");
  await app.getByRole("button", { name: "保存", exact: true }).click();
  await expect(app.getByRole("status")).toHaveText("保存しました");
  expect((await callsOf(app, "set_custom_instructions")).at(-1)).toEqual({ settings: { profile: "DBの運用担当", summary: "箇条書きで", chat: "" } });
});

test("要約を自動で作る starts off and saves all articles or an importance threshold", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  await app.getByRole("navigation", { name: "設定カテゴリ" }).getByRole("button", { name: "要約・対話" }).click();
  const auto = app.getByLabel("要約を自動で作る");
  await expect(auto).toHaveValue("off");
  await auto.selectOption({ label: "重要度4以上の記事" });
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
  await app.keyboard.press("Control+p");
  await app.keyboard.type(">設定: 翻訳");
  await expect(app.getByRole("dialog", { name: "コマンドパレット" }).getByRole("option").first()).toHaveText(/^設定: 翻訳/);
  await app.keyboard.press("Enter");
  await expect(app.locator(".stg main h1")).toHaveText("翻訳");
});

test("serving to a phone shows the QR code, warns about the open network, and a new token changes the address", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  await app.getByRole("navigation", { name: "設定カテゴリ" }).getByText("スマホで読む", { exact: true }).click();
  await expect(app.getByRole("img", { name: "スマホで開くQRコード" })).toHaveCount(0);
  await app.getByLabel("このPCから配信").selectOption("lan");
  await expect(app.getByText("暗号化されません")).toBeVisible();
  await app.getByRole("button", { name: "保存", exact: true }).first().click();
  await expect(app.getByRole("img", { name: "スマホで開くQRコード" })).toBeVisible();
  await expect(app.getByText("http://192.168.0.2:8787/", { exact: true })).toBeVisible();
  await expect(app.getByText("#t=")).toHaveCount(0);
  await app.getByLabel("スマホが開くアドレス").fill("https://typed.example");
  await app.getByRole("button", { name: "トークンを作り直す" }).click();
  await expect.poll(() => callsOf(app, "mobile_regenerate_token").then((c) => c.length)).toBe(1);
  await expect(app.getByLabel("スマホが開くアドレス"), "what is typed but not saved stays").toHaveValue("https://typed.example");
  await app.getByLabel("ポート").fill("70000");
  await expect(app.getByText("ポートは1024〜65535にしてください")).toBeVisible();
  await expect(app.getByRole("button", { name: "保存", exact: true }).first()).toBeDisabled();
});

test("the snapshot asks for everything before it turns on, then shows its QR code", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  await app.getByRole("navigation", { name: "設定カテゴリ" }).getByText("スマホで読む", { exact: true }).click();
  await expect(app.getByRole("button", { name: "今すぐ公開" })).toBeDisabled();
  await app.getByLabel("スナップショットを公開").check();
  const saves = app.getByRole("button", { name: "保存", exact: true });
  await saves.nth(1).click();
  await expect(app.getByRole("alert")).toContainText("すべて設定してください");
  await app.getByLabel("Account ID").fill("0123456789abcdef0123456789abcdef");
  await app.getByLabel("Bucket").fill("lattice-mobile");
  await app.getByLabel("Access Key ID").fill("AKID");
  await app.getByLabel("Secret Access Key").fill("s3cret");
  await app.getByLabel("Workerのアドレス").fill("https://lattice-mobile.example.workers.dev");
  await saves.nth(1).click();
  await expect(app.getByText("まだ公開していません"), "the pass ends after the command returns").toBeVisible();
  await expect(app.getByRole("img", { name: "スナップショットをスマホで開くQRコード" }), "and the screen follows it").toBeVisible();
  await expect(app.getByText("https://lattice-mobile.example.workers.dev/", { exact: true })).toBeVisible();
  await expect(app.getByLabel("Secret Access Key"), "the secret does not come back").toHaveValue("");
  await expect(app.getByRole("button", { name: "今すぐ公開" })).toBeEnabled();
  await app.getByRole("button", { name: "今すぐ公開" }).click();
  await expect.poll(() => callsOf(app, "mobile_publish_now").then((c) => c.length)).toBe(1);
});

test("a bucket nothing reaches any more can be given up, after the screen says what that leaves behind", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  await app.getByRole("navigation", { name: "設定カテゴリ" }).getByText("スマホで読む", { exact: true }).click();
  await app.getByLabel("スナップショットを公開").check();
  await app.getByLabel("Account ID").fill("0123456789abcdef0123456789abcdef");
  await app.getByLabel("Bucket").fill("unreachable");
  await app.getByLabel("Access Key ID").fill("AKID");
  await app.getByLabel("Secret Access Key").fill("s3cret");
  await app.getByLabel("Workerのアドレス").fill("https://lattice-mobile.example.workers.dev");
  const save = app.getByRole("button", { name: "保存", exact: true }).nth(1);
  await save.click();
  await app.getByLabel("スナップショットを公開").uncheck();
  await save.click();
  await expect(app.getByRole("alert")).toContainText("保存していません");
  const giveUp = app.getByRole("button", { name: "前のbucketを諦めて保存" });
  await expect(giveUp).toHaveAccessibleDescription(/削除するまで今のトークンを受け付けます/);
  await giveUp.click();
  await expect.poll(() => callsOf(app, "mobile_snapshot_save").then((c) => (c.at(-1) as { abandon: boolean }).abandon)).toBe(true);
  await expect(giveUp).toHaveCount(0);
});

test("Tailscale Serve is turned on from the screen, and its address becomes the one the phone opens", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  await app.getByRole("navigation", { name: "設定カテゴリ" }).getByText("スマホで読む", { exact: true }).click();
  await expect(app.getByText("このPCのアドレスはhttps://desktop.example.ts.net/です。まだこのポートに中継していません。")).toBeVisible();
  await app.getByLabel("スマホが開くアドレス").fill("https://desktop.example.ts.net/");
  await app.getByRole("button", { name: "保存", exact: true }).first().click();
  await expect(app.getByText("Tailscale Serveがこのポートに中継していないので")).toBeVisible();
  await app.getByRole("button", { name: "Tailscale Serveで公開" }).click();
  await expect(app.getByText("https://desktop.example.ts.net/をこのポートに中継しています。")).toBeVisible();
  await expect(app.getByText("Tailscale Serveがこのポートに中継していないので")).toHaveCount(0);
  await expect
    .poll(() => callsOf(app, "mobile_save").then((c) => c.at(-1)))
    .toEqual({
      settings: { mode: "local", port: 8787, public_url: "https://desktop.example.ts.net/" },
    });
  await app.getByLabel("ポート").fill("9000");
  await expect(app.getByRole("button", { name: "公開をやめる" }), "stopping does not depend on the port").toBeEnabled();
  await app.getByRole("button", { name: "公開をやめる" }).click();
  await expect(app.getByRole("button", { name: "Tailscale Serveで公開" }), "Serve forwards to the saved port").toBeDisabled();
  await expect(app.getByRole("button", { name: "Tailscale Serveで公開" })).toHaveAccessibleDescription(/ポートを保存してから公開してください/);
});
