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
  "AIエージェント(MCP)",
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

test("the launch-at-sign-in and tray switches keep what was chosen", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  const nav = app.getByRole("navigation", { name: "設定カテゴリ" });
  const section = (title: string) => nav.locator(".ni").filter({ has: app.locator(".label").getByText(title, { exact: true }) });
  await section("起動・タスクバー").click();
  const autostart = app.getByRole("switch", { name: "Windowsの起動時にLatticeを起動" });
  const tray = app.getByRole("switch", { name: "ウィンドウを閉じてもタスクトレイに残す" });
  await expect(autostart).not.toBeChecked();
  await expect(tray).not.toBeChecked();
  // One at a time, so a switch wired to the other's setting shows up. The checked one is awaited first: an unchecked
  // switch passes before its setting has loaded.
  await tray.click();
  await section("ブラウザ").click();
  await section("起動・タスクバー").click();
  await expect(tray).toBeChecked();
  await expect(autostart).not.toBeChecked();
  await autostart.click();
  await section("ブラウザ").click();
  await section("起動・タスクバー").click();
  await expect(autostart).toBeChecked();
  await expect(tray).toBeChecked();
  await tray.click();
  await section("ブラウザ").click();
  await section("起動・タスクバー").click();
  await expect(autostart).toBeChecked();
  await expect(tray).not.toBeChecked();
  expect(await callsOf(app, "set_close_to_tray")).toEqual([{ on: true }, { on: false }]);
  expect(await callsOf(app, "set_autostart")).toEqual([{ on: true }]);
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

/** What the settings page shows for the mock's server at port 9999, which is not running. */
const REFUSED = "http://127.0.0.1:9999の翻訳サーバーに接続できません。サーバーを起動してから、もう一度試してください(connection refused)";

test("the local translation engine shows its server's model and turns off the settings it cannot follow", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  const nav = app.getByRole("navigation", { name: "設定カテゴリ" });
  const section = (title: string) => nav.locator(".ni").filter({ has: app.locator(".label").getByText(title, { exact: true }) });
  await section("翻訳").click();
  const engine = app.getByRole("combobox", { name: "翻訳エンジン" });
  const keepTerms = app.getByRole("switch", { name: "専門用語を英語のまま残す" });
  const instructions = app.getByRole("textbox", { name: "追加の指示" });
  const url = app.getByRole("textbox", { name: "翻訳サーバーのURL" });
  const connection = app.getByRole("status");
  await expect(keepTerms).toBeEnabled();
  await expect(url).toHaveCount(0);

  await engine.selectOption({ label: "ローカルの翻訳サーバー" });
  await expect(connection).toHaveText("接続済み: plamo-3-translate");
  expect(await callsOf(app, "set_translate_engine")).toEqual([{ engine: "local", localUrl: "http://127.0.0.1:8077" }]);
  await expect(keepTerms).toBeDisabled();
  await expect(keepTerms, "the stored setting stays for the AI engine").toBeChecked();
  await expect(instructions).toBeDisabled();
  await expect(app.getByText("組み込みのprompt(英語→日本語)を見る")).toHaveCount(0);
  const form = app.getByRole("combobox", { name: "文体" });
  await expect(form, "PLaMo takes a style too").toBeEnabled();
  await form.selectOption({ label: "敬体(です、ます)" });
  await expect.poll(() => callsOf(app, "set_translate_form")).toEqual([{ form: "polite" }]);

  const saveUrl = app.locator(".set.wide").filter({ has: url }).getByRole("button", { name: "保存" });
  await url.fill("http://127.0.0.1:9999/v1/");
  await saveUrl.click();
  await expect(url, "as stored").toHaveValue("http://127.0.0.1:9999");
  await expect(connection).toHaveText(REFUSED);
  await url.fill("127.0.0.1:8077");
  await saveUrl.click();
  await expect(app.getByRole("alert")).toHaveText("翻訳サーバーのURLが正しくありません(例: http://127.0.0.1:8077)");

  await section("表示言語").click();
  await section("翻訳").click();
  await expect(url, "the stored URL").toHaveValue("http://127.0.0.1:9999");
  await expect(form, "the stored style").toHaveValue("polite");
  await form.selectOption({ label: "指定しない" });
  await expect.poll(() => callsOf(app, "set_translate_form").then((c) => c.at(-1))).toEqual({ form: null });
  await expect(connection, "checked when the page opens").toHaveText(REFUSED);

  await engine.selectOption({ label: "AIプロバイダ" });
  await expect(keepTerms).toBeEnabled();
  await expect(instructions).toBeEnabled();
  await expect(url).toHaveCount(0);
});

test("a connection check that answers after a later one leaves the later one's result", async ({ app }) => {
  await app.evaluate(() => {
    const internals: unknown = Reflect.get(window, "__TAURI_INTERNALS__");
    if (!internals || typeof internals !== "object" || !("invoke" in internals) || typeof internals.invoke !== "function") {
      throw new Error("Tauri invoke is unavailable");
    }
    const invoke = internals.invoke;
    let held = false;
    internals.invoke = (cmd: string, args?: unknown, options?: unknown): Promise<unknown> => {
      const result: Promise<unknown> = Promise.resolve(Reflect.apply(invoke, internals, [cmd, args, options]));
      if (cmd !== "check_translate_local" || held) {
        return result;
      }
      held = true;
      return new Promise((resolve, reject) => {
        Object.assign(window, { releaseCheck: () => result.then(resolve, reject) });
      });
    };
  });
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  await app
    .getByRole("navigation", { name: "設定カテゴリ" })
    .locator(".ni")
    .filter({ has: app.locator(".label").getByText("翻訳", { exact: true }) })
    .click();
  await app.getByRole("combobox", { name: "翻訳エンジン" }).selectOption({ label: "ローカルの翻訳サーバー" });
  const url = app.getByRole("textbox", { name: "翻訳サーバーのURL" });
  await url.fill("http://127.0.0.1:9999");
  await app.locator(".set.wide").filter({ has: url }).getByRole("button", { name: "保存" }).click();
  const connection = app.getByRole("status");
  await expect(connection).toHaveText(REFUSED);
  await app.evaluate(async () => {
    const release: unknown = Reflect.get(window, "releaseCheck");
    if (typeof release !== "function") {
      throw new Error("The first check was not held");
    }
    await Reflect.apply(release, window, []);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await expect(connection, "not the default URL's 接続済み").toHaveText(REFUSED);
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
  await app.evaluate(() => void ((window as unknown as { __moreUnused: number }).__moreUnused = 3));
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

test("saving the provider chain sends each step's model and effort, the untouched ones as they were loaded", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  await app.getByRole("navigation", { name: "設定カテゴリ" }).getByText("AIプロバイダ", { exact: true }).click();
  await app.getByLabel("1番目のモデル", { exact: true }).selectOption("opus");
  await app.getByLabel("1番目のeffort", { exact: true }).selectOption("high");
  await app.locator(".btn-row").filter({ hasText: "各CLIのログインを使います" }).getByRole("button", { name: "保存", exact: true }).click();
  expect(await callsOf(app, "set_llm_chain")).toEqual([
    {
      chain: [
        { kind: "claude_cli", model: "opus", effort: "high" },
        { kind: "openai", model: "gpt-5-mini", effort: "low" },
      ],
    },
  ]);
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

test("agent registrations are for one target each, copy what it takes, keep their own roles, and a new token or a deletion asks first", async ({ app }) => {
  await app.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  await app.getByRole("navigation", { name: "設定カテゴリ" }).getByText("AIエージェント(MCP)", { exact: true }).click();
  await app.getByLabel("MCPサーバーを動かす").check();
  await expect.poll(() => callsOf(app, "mcp_edit")).toEqual([{ edit: { kind: "enable", on: true } }]);
  await app.getByLabel("MCPサーバーを動かす").uncheck();
  await expect(app.getByText("登録はまだありません")).toBeVisible();
  await expect(app.getByText("「対話」に会話として残ります"), "what each role may do, before one is picked").toBeVisible();
  await expect(app.getByText("削除のたびにアプリが許可を求め、2分のうちに答えなければ拒否します。")).toBeVisible();

  const row = (name: string) => app.locator(".set").filter({ has: app.locator(".h").getByText(name, { exact: true }) });
  const role = (name: string) => app.getByLabel(`「${name}」のロール`);
  const kinds = async () => (await callsOf(app, "mcp_edit")).map((c) => (c as { edit: { kind: string } }).edit.kind);
  const clipboard = () => app.evaluate(() => navigator.clipboard.readText());
  const register = app.getByRole("button", { name: "登録する" });
  const target = app.getByLabel("登録先");
  const name = app.getByLabel("新しい登録");
  const status = app.locator(".stg").getByRole("status");
  await expect(target, "the first one is for all of Claude Code").toHaveValue("claude_code");
  await expect(name, "the name it takes when left empty").toHaveAttribute("placeholder", "Claude Code");
  await app.getByLabel("ロール", { exact: true }).selectOption("edit");
  await register.click();
  await expect(row("Claude Code")).toContainText("Claude Code全体");
  await expect(status).toHaveText("Claude Codeの設定に登録しました。開いているセッションでは、つなぎ直すと使えます。");
  await expect(app.getByLabel("MCPサーバーを動かす"), "registering turns it on").toBeChecked();
  expect(await callsOf(app, "mcp_edit").then((c) => c.at(-1))).toEqual({ edit: { kind: "create", name: "", role: "edit", target: "claude_code" } });

  await expect(target, "Claude Code's user config holds one").toHaveValue("codex");
  await expect(target.locator("option[value=claude_code]")).toBeDisabled();
  await expect(name).toHaveAttribute("placeholder", "Codex");
  await register.click();
  await expect(row("Codex")).toContainText("Codex");
  await expect(status).toHaveText("Codexの設定に登録しました。開いているセッションでは、つなぎ直すと使えます。");
  await expect(target, "and so does Codex's").toHaveValue("claude_code_project");
  await expect(target.locator("option[value=codex]")).toBeDisabled();

  await expect(register, "a project's own needs a name").toBeDisabled();
  await expect(name).not.toHaveAttribute("placeholder");
  await name.fill("Research");
  await app.getByLabel("ロール", { exact: true }).selectOption("delete");
  await register.click();
  await expect(name).toHaveValue("");
  await expect(row("Research")).toContainText("Claude Codeの1つのプロジェクト");
  await expect(status, "nothing was written anywhere").toHaveText("");
  await expect(role("Claude Code")).toHaveValue("edit");
  await expect(role("Research")).toHaveValue("delete");
  await target.selectOption("other");
  await expect(register, "nor does another agent name itself").toBeDisabled();
  await name.fill("Editor");
  await register.click();
  await expect(row("Editor")).toContainText("その他");
  for (const without of ["Research", "Editor"]) {
    await expect(row(without).getByRole("button", { name: /に登録$/ }), "Lattice writes no settings for it").toHaveCount(0);
  }

  await row("Codex").getByRole("button", { name: "設定をコピー" }).click();
  await expect.poll(clipboard).toMatch(/^\[mcp_servers\.lattice\]\s/);
  await row("Editor").getByRole("button", { name: "設定をコピー" }).click();
  await expect.poll(clipboard).toMatch(/^\{"mcpServers"/);
  await row("Research").getByRole("button", { name: "コマンドをコピー" }).click();
  await expect.poll(clipboard).toMatch(/^claude mcp add --transport http --scope local lattice .* --header "Authorization: Bearer \w+"$/);
  await row("Claude Code").getByRole("button", { name: "コマンドをコピー" }).click();
  await expect(row("Claude Code").getByRole("button", { name: "コピーしました" })).toBeVisible();
  const first = await clipboard();
  expect(first).toMatch(/^claude mcp add --transport http --scope user lattice .* --header "Authorization: Bearer \w+"$/);

  await role("Research").selectOption("edit");
  await expect.poll(() => callsOf(app, "mcp_edit").then((c) => c.at(-1))).toEqual({ edit: { kind: "set_role", id: "r3", role: "edit" } });
  await expect(role("Research"), "the row shows its own registration's saved role").toHaveValue("edit");
  await role("Claude Code").selectOption("read");
  await expect(role("Claude Code")).toHaveValue("read");
  await expect(role("Research"), "the other row keeps its role").toHaveValue("edit");

  await row("Claude Code").getByRole("button", { name: "トークンを作り直す" }).click();
  const regenerate = app.getByRole("alertdialog", { name: "「Claude Code」のトークンを作り直しますか？" });
  await regenerate.getByRole("button", { name: "キャンセル" }).click();
  expect(await kinds(), "nothing before the answer").not.toContain("regenerate");
  await row("Claude Code").getByRole("button", { name: "トークンを作り直す" }).click();
  await expect(regenerate).toContainText("Claude Codeの設定のトークンも、Latticeが新しいものに替えます。開いているセッションは、つなぎ直してください。");
  await regenerate.getByRole("button", { name: "作り直す", exact: true }).click();
  await expect(status).toHaveText("Claude Codeの設定に登録しました。開いているセッションでは、つなぎ直すと使えます。");
  await expect(row("Claude Code").getByRole("button", { name: "コマンドをコピー" }), "the new token makes a new command").toBeVisible();
  await row("Claude Code").getByRole("button", { name: "コマンドをコピー" }).click();
  await expect.poll(clipboard).not.toBe(first);
  await row("Research").getByRole("button", { name: "トークンを作り直す" }).click();
  const regenerateProject = app.getByRole("alertdialog", { name: "「Research」のトークンを作り直しますか？" });
  await expect(regenerateProject, "a project's own is removed where it was added").toContainText(
    "そのプロジェクトのフォルダで、claude mcp remove lattice -s localで前の登録を消してから、新しいコマンドを実行してください。",
  );
  await regenerateProject.getByRole("button", { name: "キャンセル" }).click();
  await row("Editor").getByRole("button", { name: "トークンを作り直す" }).click();
  await expect(app.getByRole("alertdialog")).toContainText("新しい設定をコピーして、エージェントの前の設定と入れ替えてください。");
  await app.getByRole("alertdialog").getByRole("button", { name: "キャンセル" }).click();

  await name.fill("claude code");
  await register.click();
  await expect(app.getByRole("alert")).toHaveText("「claude code」という登録はもうあります");
  await expect(name, "the name stays to be changed").toHaveValue("claude code");

  await row("Research").getByRole("button", { name: "削除", exact: true }).click();
  const removeProject = app.getByRole("alertdialog", { name: "登録「Research」を削除しますか？" });
  await removeProject.getByRole("button", { name: "キャンセル" }).click();
  expect(await kinds(), "nothing before the answer").not.toContain("delete");
  await row("Research").getByRole("button", { name: "削除", exact: true }).click();
  await expect(removeProject, "a project's own is removed where it was added").toContainText(
    "そのプロジェクトのフォルダで、claude mcp remove lattice -s localで登録も消してください。",
  );
  await expect(removeProject, "removing it hands the project to the registration for all of Claude Code").toContainText(
    "消した後は、「Claude Code全体」の登録があれば、そのプロジェクトでもそちらが使われます。",
  );
  await removeProject.getByRole("button", { name: "削除", exact: true }).click();
  await expect(row("Research")).toHaveCount(0);
  await expect(role("Claude Code"), "the other registration stays").toHaveValue("read");
  await row("Editor").getByRole("button", { name: "削除", exact: true }).click();
  await expect(app.getByRole("alertdialog")).toContainText("エージェントの設定からも登録を消してください。");
  await app.getByRole("alertdialog").getByRole("button", { name: "削除", exact: true }).click();
  await row("Codex").getByRole("button", { name: "削除", exact: true }).click();
  await expect(app.getByRole("alertdialog")).toContainText("Codexの設定からも、Latticeが登録を消します。");
  await app.getByRole("alertdialog").getByRole("button", { name: "削除", exact: true }).click();
  await expect(status).toHaveText("Codexの設定からも登録を消しました。");

  await row("Claude Code").getByRole("button", { name: "削除", exact: true }).click();
  const removeAll = app.getByRole("alertdialog", { name: "登録「Claude Code」を削除しますか？" });
  await expect(removeAll).toContainText("Claude Codeの設定からも、Latticeが登録を消します。");
  await removeAll.getByRole("button", { name: "削除", exact: true }).click();
  await expect(app.getByText("登録はまだありません")).toBeVisible();
  await expect(target, "free for all of Claude Code again").toHaveValue("claude_code");
  await target.selectOption("claude_code_project");
  await name.fill("Notes");
  await register.click();
  await expect(row("Notes"), "the target picked, not the default").toContainText("Claude Codeの1つのプロジェクト");
  await expect(target, "the next one starts from the default again").toHaveValue("claude_code");

  await app.getByLabel("MCPサーバーを動かす").uncheck();
  await expect.poll(() => callsOf(app, "mcp_edit").then((c) => c.at(-1))).toEqual({ edit: { kind: "enable", on: false } });
  await expect(app.getByLabel("MCPサーバーを動かす")).not.toBeChecked();
});

test("an agent whose settings cannot be changed keeps its registration, says why, and can be tried again", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  await app.getByRole("navigation", { name: "設定カテゴリ" }).getByText("AIエージェント(MCP)", { exact: true }).click();
  const row = (name: string) => app.locator(".set").filter({ has: app.locator(".h").getByText(name, { exact: true }) });
  const alert = app.getByRole("alert");
  const status = app.locator(".stg").getByRole("status");
  const agentError = (code: string | null, params: Record<string, string> = {}) =>
    app.evaluate((e) => window.__e2e.mcpAgentError(e), code && JSON.stringify({ code, params }));

  await agentError("mcp.agentMissing", { agent: "Claude Code", program: "claude" });
  await app.getByRole("button", { name: "登録する" }).click();
  await expect(alert.locator("p")).toHaveText([
    "Claude Codeの設定を書き換えられませんでした。「claude」が見つかりません。",
    "Latticeの登録は保存しました。「Claude Codeに登録」を押すと、もう一度試します。手で登録するときは、前の登録があればclaude mcp remove lattice -s userで消してから、コピーしたものを使ってください。",
  ]);
  await expect(status).toHaveText("");
  await expect(row("Claude Code").getByRole("button", { name: "コマンドをコピー" }), "to add it by hand").toBeEnabled();

  await agentError("mcp.agentOther", { agent: "Claude Code", name: "lattice" });
  await row("Claude Code").getByRole("button", { name: "Claude Codeに登録" }).click();
  await expect(alert.locator("p"), "nothing that would remove the user's own server").toHaveText([
    "Claude Codeの設定には、Latticeのものではない「lattice」という登録がもうあるので、変えませんでした。それを消すか名前を変えると登録できます。",
  ]);

  await agentError(null);
  await row("Claude Code").getByRole("button", { name: "Claude Codeに登録" }).click();
  await expect(status).toHaveText("Claude Codeの設定に登録しました。開いているセッションでは、つなぎ直すと使えます。");
  await expect(alert).toHaveCount(0);
  expect(await callsOf(app, "mcp_edit").then((c) => c.at(-1))).toEqual({ edit: { kind: "connect", id: "r1" } });

  await agentError("mcp.agentFailed", { agent: "Claude Code", error: "timed out after 30s" });
  await row("Claude Code").getByRole("button", { name: "トークンを作り直す" }).click();
  await app.getByRole("alertdialog").getByRole("button", { name: "作り直す", exact: true }).click();
  await expect(alert.locator("p")).toContainText(["Claude Codeの設定を書き換えられませんでした: timed out after 30s", "Latticeの登録は保存しました。"]);
  await expect(status, "the earlier success no longer holds").toHaveText("");

  await app.getByLabel("新しい登録").fill("claude code");
  await expect(app.getByLabel("登録先", { exact: true })).toHaveValue("codex");
  await app.getByRole("button", { name: "登録する" }).click();
  await expect(alert).toHaveText("「claude code」という登録はもうあります");
  await expect(app.getByRole("button", { name: "登録する" }), "a refusal ends the wait").toBeEnabled();

  await row("Claude Code").getByRole("button", { name: "削除", exact: true }).click();
  await app.getByRole("alertdialog").getByRole("button", { name: "削除", exact: true }).click();
  await expect(row("Claude Code"), "the registration goes anyway").toHaveCount(0);
  await expect(alert.locator("p")).toHaveText([
    "Claude Codeの設定を書き換えられませんでした: timed out after 30s",
    "Latticeの登録は削除しました。Claude Codeの設定からは、claude mcp remove lattice -s userで消してください。",
  ]);
});

test("the controls wait while an agent's settings are changed", async ({ shell }) => {
  await shell.addInitScript(() => {
    window.__e2eHold = ["mcp_edit"];
  });
  const app = shell;
  await app.goto("/");
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  await app.getByRole("navigation", { name: "設定カテゴリ" }).getByText("AIエージェント(MCP)", { exact: true }).click();
  const register = app.getByRole("button", { name: "登録する" });
  const status = app.locator(".stg").getByRole("status");
  const release = () => app.evaluate(() => window.__e2e.release("mcp_edit"));
  await register.click();
  await expect(status).toHaveText("Claude Codeの設定を書き換えています…");
  await expect(register).toBeDisabled();
  await expect(app.getByLabel("MCPサーバーを動かす")).toBeDisabled();
  await expect(app.getByText("元のライブラリを開けなかった"), "busy is no fallback").toHaveCount(0);
  await release();
  await expect(status).toHaveText("Claude Codeの設定に登録しました。開いているセッションでは、つなぎ直すと使えます。");
  await expect(app.getByLabel("MCPサーバーを動かす")).toBeEnabled();

  await app.getByLabel("「Claude Code」のロール").selectOption("edit");
  await expect.poll(() => callsOf(app, "mcp_edit").then((c) => c.length)).toBe(2);
  await expect(status, "a role reaches no agent's settings").toHaveText("");
  await expect(register).toBeEnabled();
  const row = app.locator(".set").filter({ has: app.locator(".h").getByText("Claude Code", { exact: true }) });
  await row.getByRole("button", { name: "Claude Codeに登録" }).click();
  await expect.poll(() => callsOf(app, "mcp_edit").then((c) => c.length)).toBe(3);
  await app.evaluate(() => window.__e2e.release("mcp_edit", 1));
  await expect(app.getByLabel("「Claude Code」のロール")).toHaveValue("edit");
  await expect(status, "the role's answer does not end the wait").toHaveText("Claude Codeの設定を書き換えています…");
  await expect(row.getByRole("button", { name: "削除", exact: true })).toBeDisabled();
  await release();
  await expect(status).toHaveText("Claude Codeの設定に登録しました。開いているセッションでは、つなぎ直すと使えます。");
});

test("each registration shows its open sessions and latest calls, and the screen keeps up without reopening", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  await app.getByRole("navigation", { name: "設定カテゴリ" }).getByText("AIエージェント(MCP)", { exact: true }).click();
  const server = app.getByLabel("MCPサーバーを動かす");
  await server.check();
  for (const name of ["Claude Code", "Research"]) {
    await app.getByLabel("新しい登録").fill(name);
    await app.getByRole("button", { name: "登録する" }).click();
    await expect(app.getByLabel("新しい登録")).toHaveValue("");
  }
  const activity = app.getByRole("region", { name: "利用状況" });
  await expect(activity).toContainText("セッションも呼び出しもありません");

  const times = await app.evaluate(() => {
    const now = Date.now();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const started = yesterday.setHours(12, 0, 0, 0);
    window.__e2e.mcpActivity("r1", {
      sessions: [
        { client: "claude-code 2.1.327", started_ms: started, last_ms: now },
        { client: null, started_ms: now, last_ms: now },
      ],
      calls: [
        { at_ms: now, tool: "delete_article", outcome: "refused" },
        { at_ms: now, tool: "tag", outcome: "failed" },
        { at_ms: now, tool: "get", outcome: "succeeded" },
      ],
    });
    void window.__e2e.emit("mcp-activity");
    return { started: new Date(started).toLocaleString("ja-JP"), now: new Date(now).toLocaleTimeString("ja-JP") };
  });
  const used = activity.getByRole("group", { name: "Claude Code" });
  await expect(used.getByRole("list", { name: "セッション" }).getByRole("listitem"), "heard of without reopening; a start a day ago gives the date").toHaveText(
    [
      `claude-code 2.1.327 開始: ${times.started} · 最後のリクエスト: ${times.now}`,
      `名前のないクライアント 開始: ${times.now} · 最後のリクエスト: ${times.now}`,
    ],
  );
  await expect(used.getByRole("list", { name: "最近の呼び出し" }).getByRole("listitem")).toHaveText([
    `${times.now} delete_article 拒否`,
    `${times.now} tag 失敗`,
    `${times.now} get 成功`,
  ]);
  await expect(activity.getByRole("group"), "an unused registration is left out").toHaveCount(1);
  await expect(activity).not.toContainText("セッションも呼び出しもありません");

  await app.evaluate(() => {
    window.__e2e.mcpActivity("r2", { sessions: [], calls: [{ at_ms: Date.now(), tool: "search", outcome: "succeeded" }] });
    void window.__e2e.emit("mcp-activity");
  });
  const research = activity.getByRole("group", { name: "Research" });
  await expect(research.getByRole("list", { name: "セッション" })).toHaveText("セッションはありません");
  await expect(research.getByRole("list", { name: "最近の呼び出し" })).toContainText("search 成功");

  await server.uncheck();
  await expect(activity, "the section goes while the server is off").toHaveCount(0);
});

test("a status read that answers after a new token does not bring back the old command", async ({ shell }) => {
  await shell.addInitScript(() => {
    window.__e2eLate = ["mcp_status"];
  });
  const app = shell;
  await app.goto("/");
  await app.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  await app.getByRole("navigation", { name: "設定カテゴリ" }).getByText("AIエージェント(MCP)", { exact: true }).click();
  const reads = () => callsOf(app, "mcp_status").then((c) => c.length);
  await expect.poll(reads).toBeGreaterThan(0);
  await app.evaluate(() => window.__e2e.release("mcp_status"));
  await app.getByLabel("MCPサーバーを動かす").check();
  await app.getByLabel("新しい登録").fill("Claude Code");
  await app.getByRole("button", { name: "登録する" }).click();
  const row = app.locator(".set").filter({ has: app.locator(".h").getByText("Claude Code", { exact: true }) });
  await expect(row.getByRole("button", { name: "コマンドをコピー" })).toBeVisible();

  const before = await reads();
  await app.evaluate(() => window.__e2e.emit("mcp-activity"));
  await expect.poll(reads, "a read of the first token's status, not yet answered").toBe(before + 1);
  await row.getByRole("button", { name: "トークンを作り直す" }).click();
  await app.getByRole("alertdialog").getByRole("button", { name: "作り直す", exact: true }).click();
  await expect.poll(() => callsOf(app, "mcp_edit").then((c) => c.length)).toBe(3);
  await app.evaluate(() => window.__e2e.release("mcp_status"));
  await app.evaluate(() => new Promise((settled) => setTimeout(settled, 300)));
  await row.getByRole("button", { name: "コマンドをコピー" }).click();
  await expect.poll(() => app.evaluate(() => navigator.clipboard.readText())).toContain("Bearer t2");
});

test("a status read that answers after a newer one does not put older activity back", async ({ shell }) => {
  await shell.addInitScript(() => {
    window.__e2eLate = ["mcp_status"];
  });
  const app = shell;
  await app.goto("/");
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  await app.getByRole("navigation", { name: "設定カテゴリ" }).getByText("AIエージェント(MCP)", { exact: true }).click();
  const reads = () => callsOf(app, "mcp_status").then((c) => c.length);
  await expect.poll(reads).toBeGreaterThan(0);
  await app.evaluate(() => window.__e2e.release("mcp_status"));
  await app.getByLabel("MCPサーバーを動かす").check();
  await app.getByLabel("新しい登録").fill("Claude Code");
  await app.getByRole("button", { name: "登録する" }).click();
  await expect(app.getByLabel("新しい登録")).toHaveValue("");

  for (const tools of [["get"], ["search", "get"]]) {
    const before = await reads();
    await app.evaluate((tools) => {
      window.__e2e.mcpActivity("r1", { sessions: [], calls: tools.map((tool) => ({ at_ms: Date.now(), tool, outcome: "succeeded" as const })) });
      void window.__e2e.emit("mcp-activity");
    }, tools);
    await expect.poll(reads).toBe(before + 1);
  }
  const calls = app.getByRole("region", { name: "利用状況" }).getByRole("list", { name: "最近の呼び出し" }).getByRole("listitem");
  await app.evaluate(() => window.__e2e.release("mcp_status", -1));
  await expect(calls).toHaveCount(2);
  await app.evaluate(() => window.__e2e.release("mcp_status"));
  await app.evaluate(() => new Promise((settled) => setTimeout(settled, 300)));
  await expect(calls, "the older read came back last").toHaveCount(2);
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
