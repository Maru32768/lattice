import { test, expect, callsOf, chatScope, list, navItem, pickScope, scopeDialog } from "./harness.ts";
import { ARTICLES } from "./fixtures.ts";
import type { Locator, Page } from "@playwright/test";

const section = (app: Page, title: string) =>
  app
    .getByRole("navigation", { name: "設定カテゴリ" })
    .locator(".ni")
    .filter({ has: app.locator(".label").getByText(title, { exact: true }) });

test("the chat budget sends the setting and keeps it when the section is reopened", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  await section(app, "要約・対話").click();
  const budget = app.getByLabel("対話で使う範囲");
  await expect(budget).toHaveValue("standard");
  await budget.selectOption({ label: "多め(約15万字)" });
  expect(await callsOf(app, "set_chat_budget")).toEqual([{ budget: "large" }]);

  await section(app, "翻訳").click();
  await section(app, "要約・対話").click();
  await expect(app.getByLabel("対話で使う範囲")).toHaveValue("large");
});

test("with 1行ならEnter, Enter sends a one-line question; once it has two lines Enter is a newline and Ctrl+Enter sends", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  await section(app, "要約・対話").click();
  const sendKey = app.getByLabel("送信キー");
  await expect(sendKey).toHaveValue("ctrlEnter");
  await sendKey.selectOption({ label: "1行ならEnter、2行以上ならCtrl+Enterで送信" });
  await app.keyboard.press("Escape");

  await app.locator(".nav").getByRole("button", { name: "対話" }).click();
  const q = app.getByLabel("質問", { exact: true });
  const hint = app.locator(".chat-f-row .kbd");
  const asked = async () => (await callsOf(app, "chat_ask")).map((a) => (a as { question: string }).question);
  await q.fill("one line");
  await expect(hint).toHaveText(["Enter"]);
  await q.press("Enter");
  await expect.poll(asked).toEqual(["one line"]);
  await expect(q).toHaveValue("");

  await q.pressSequentially("first");
  await q.press("Shift+Enter");
  await q.pressSequentially("second");
  await expect(hint).toHaveText(["Ctrl", "Enter"]);
  await q.press("Enter");
  await expect(q).toHaveValue("first\nsecond\n");
  expect(await asked()).toEqual(["one line"]);
  await q.press("Control+Enter");
  await expect.poll(asked).toEqual(["one line", "first\nsecond"]);
});

test("Vim with Enter as the send key: insert-mode Enter is a new line, normal-mode Enter sends, a count keeps it Vim's", async ({ shell }) => {
  await shell.addInitScript(() => {
    localStorage.setItem("lattice.chatVim", "on");
    localStorage.setItem("lattice.chatSendKey", "enter");
  });
  await shell.goto("/");
  await expect(list(shell).locator(".row").first()).toBeVisible({ timeout: 30_000 });
  await shell.locator(".nav").getByRole("button", { name: "対話" }).click();
  const q = shell.getByRole("textbox", { name: "質問", exact: true });
  await q.click();
  const asked = async () => (await callsOf(shell, "chat_ask")).map((a) => (a as { question: string }).question);
  const hint = shell.locator(".chat-f-row .kbd");
  await shell.keyboard.type("first");
  await expect(hint, "insert mode sends on Ctrl+Enter only").toHaveText(["Ctrl", "Enter"]);
  await shell.keyboard.press("Enter");
  await shell.keyboard.type("second");
  await expect(q).toHaveText("firstsecond");
  expect(await asked()).toEqual([]);
  await shell.keyboard.press("Escape");
  await expect(hint).toHaveText(["Enter"]);
  await shell.keyboard.press("2");
  await shell.keyboard.press("Enter");
  expect(await asked(), "a count makes Enter Vim's <CR>").toEqual([]);
  await shell.keyboard.press("Enter");
  await expect.poll(asked).toEqual(["first\nsecond"]);
});

test("Vim keys in the chat input: off by default, modes, motions, edits, undo, Ctrl+Enter sends", async ({ app }) => {
  const chatButton = app.locator(".nav").getByRole("button", { name: "対話" });
  await chatButton.click();
  const plain = app.getByLabel("質問", { exact: true });
  await plain.fill("plain");
  await plain.press("Escape");
  await expect(app.locator(".vim-mode")).toHaveCount(0);

  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  await section(app, "Vim").click();
  await app.getByLabel("対話の入力欄とメモでVimキーバインドを使う").check();
  await app.keyboard.press("Escape");

  // What the textarea held goes on in the editor.
  const q = app.getByRole("textbox", { name: "質問", exact: true });
  await expect(q).toHaveText("plain");
  await q.focus();
  const mode = app.locator(".chat-f-row .vim-mode");
  await expect(mode).toHaveText("INSERT");
  await app.keyboard.press("Control+a");
  await app.keyboard.press("Control+a");
  await app.keyboard.press("Backspace");
  await app.keyboard.type("hello big world");
  await expect(q).toHaveText("hello big world");
  await app.keyboard.press("Escape");
  await expect(mode).toHaveText("NORMAL");
  await expect(app.locator(".cm-fat-cursor"), "block cursor").toHaveCount(1);
  await app.keyboard.type("zq");
  await expect(q, "normal mode does not type").toHaveText("hello big world");
  await expect(mode).toHaveText("NORMAL");

  await app.keyboard.type("bb");
  await app.keyboard.press("d");
  await expect(mode).toHaveText("NORMAL d");
  await app.keyboard.press("w");
  await expect(q).toHaveText("hello world");
  await app.keyboard.press("u");
  await expect(q).toHaveText("hello big world");
  await app.keyboard.type("0cwhi");
  await expect(mode).toHaveText("INSERT");
  await app.keyboard.press("Escape");
  await app.keyboard.type("A!");
  await expect(q).toHaveText("hi big world!");
  await app.keyboard.press("Escape");

  await app.keyboard.press("Control+Enter");
  await expect.poll(async () => (await callsOf(app, "chat_ask")).map((a) => (a as { question: string }).question)).toEqual(["hi big world!"]);
  await expect(app.locator(".chat-f .cm-placeholder"), "the sent question is gone").toBeVisible();
  await expect(mode, "a sent question starts the next one in insert mode").toHaveText("INSERT");
  await expect(q, "the next question can be typed right away").toBeFocused();
});

test("the chat scope offers each open article and all of them, and follows the tabs", async ({ app }) => {
  const [a, b, c] = ARTICLES;
  await list(app).locator(".row", { hasText: a.title! }).click();
  await list(app)
    .locator(".row", { hasText: b.title! })
    .click({ modifiers: ["Control"] });
  await app.locator(".nav").getByRole("button", { name: "対話" }).click();
  const scope = chatScope(app);
  const picker = scopeDialog(app);
  const options = picker.getByRole("option");
  const named = (title: string) => picker.getByRole("option", { name: title, exact: true });
  await scope.click();
  await expect(options).toContainText(["この記事(", "開いている記事すべて(2件)", "全記事", a.title!, b.title!]);
  await expect(named("開いている記事すべて(2件)")).toBeEnabled();

  // A document window reports its tabs to the main window.
  await app.evaluate((d) => window.__e2e.emit("main-request", { kind: "openDocs", label: "doc-1", docs: [d] }), { id: c.id, title: c.title! });
  await expect(options).toContainText(["開いている記事すべて(3件)", "全記事", a.title!, b.title!, c.title!]);
  await picker.getByRole("combobox", { name: "範囲を検索" }).fill("すべて(3");
  await app.keyboard.press("Enter");
  await expect(picker).toBeHidden();
  await expect(scope).toHaveText("開いている記事すべて(3件)");
  await expect(scope, "the keyboard is back on the chip").toBeFocused();
  const q = app.locator("#chat-q");
  await q.fill("共通点は？");
  await q.press("Control+Enter");
  await expect
    .poll(async () => (await callsOf(app, "chat_ask")).map((x) => (x as { scope: unknown }).scope))
    .toEqual([{ kind: "articles", ids: [a.id, b.id, c.id] }]);

  // One of them, until its tab closes: then the scope widens to what is still open.
  await pickScope(app, b.title!);
  await expect(scope).toHaveText(b.title!);
  await app.getByRole("button", { name: `${b.title}を閉じる` }).click();
  await expect(scope).toHaveText("開いている記事すべて(2件)");
  await scope.click();
  await expect(options).toContainText(["全記事", a.title!, c.title!]);
  await expect(named(b.title!)).toHaveCount(0);
  await app.evaluate(() => window.__e2e.emit("main-request", { kind: "openDocs", label: "doc-1", docs: [] }));
  await expect(named(c.title!)).toHaveCount(0);
  await expect(named(a.title!)).toHaveCount(1);
});

test("in the chat scope the arrows pass over headings and disabled options, a search narrows and marks, and Esc closes", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "対話" }).click();
  const scope = chatScope(app);
  const picker = scopeDialog(app);
  const search = picker.getByRole("combobox", { name: "範囲を検索" });
  const options = picker.getByRole("option");
  const active = picker.locator("[role=option].act");
  await scope.focus();
  await app.keyboard.press("ArrowDown");
  await expect(search, "the search takes the keyboard").toBeFocused();
  await expect(picker.getByRole("option", { name: "この記事(記事を開いていません)" }), "listed, as the select did").toBeDisabled();
  await expect(picker.getByRole("option", { name: "開いている記事すべて(0件)" })).toBeDisabled();
  await expect(active, "it opens on the scope in use").toHaveAccessibleName("全記事");
  await expect(search).toHaveAttribute("aria-activedescendant", (await active.getAttribute("id"))!);

  await app.keyboard.press("ArrowUp");
  await expect(active, "nothing above it can be picked").toHaveAccessibleName("全記事");
  await app.keyboard.press("ArrowDown");
  await expect(active, "past the グループ heading").toHaveAccessibleName(/^MVCC調査\(/);
  await app.keyboard.press("ArrowUp");
  await expect(active).toHaveAccessibleName("全記事");
  await picker.getByRole("option", { name: "この記事(記事を開いていません)" }).click({ force: true });
  await search.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await expect(picker, "neither a disabled option nor the Enter that ends a conversion picks").toBeVisible();

  // The mouse moves the highlight but never the list.
  const listbox = picker.getByRole("listbox", { name: "質問の範囲" });
  const top = await listbox.evaluate((e) => e.scrollTop);
  const low = options.nth(8);
  await low.hover();
  await expect(active).toHaveAccessibleName((await low.textContent())!.replace("✓", ""));
  expect(await listbox.evaluate((e) => e.scrollTop)).toBe(top);

  await search.fill("KAF");
  await expect(options).toHaveText([`#kafka(${ARTICLES.filter((x) => x.tags.includes("kafka")).length}件)`]);
  await expect(picker.locator("mark")).toHaveText("kaf");
  await expect(picker.getByText("タグ", { exact: true })).toBeVisible();
  await expect(picker.getByText("グループ", { exact: true }), "a section with no match goes").toHaveCount(0);
  await search.fill("no such scope");
  await expect(options).toHaveCount(0);
  await expect(picker.getByText("該当なし")).toBeVisible();

  await app.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await expect(scope).toBeFocused();
  await expect(scope).toHaveText("全記事");
  await app.keyboard.press("Enter");
  await expect(search, "each opening starts a new search").toHaveValue("");
});

test("a scope chosen from outside shows on the chip, and one the list no longer offers keeps its name", async ({ app }) => {
  await app.keyboard.press("Control+p");
  await app.keyboard.type("kafka");
  await app.getByRole("dialog", { name: "コマンドパレット" }).getByRole("option", { name: "タグkafkaを範囲に対話を始める" }).click();
  const scope = chatScope(app);
  await expect(scope).toHaveText(`#kafka(${ARTICLES.filter((x) => x.tags.includes("kafka")).length}件)`);

  await navItem(app, "未読").click();
  await pickScope(app, "現在の一覧: 未読");
  await navItem(app, "すべての記事").click();
  await expect(scope).toHaveText("現在の一覧: 未読");
  await scope.click();
  await expect(scopeDialog(app).getByRole("option", { name: "現在の一覧: 未読" }), "no longer offered").toHaveCount(0);
  await app.keyboard.press("Escape");
  const q = app.locator("#chat-q");
  await q.fill("未読の要点は？");
  await q.press("Control+Enter");
  await expect
    .poll(async () => (await callsOf(app, "chat_ask")).map((x) => (x as { scope: unknown }).scope))
    .toEqual([{ kind: "filter", filter: { kind: "unread" } }]);
});

test("the chat scope lists thousands of tags while drawing only the ones in view, and reaches the last by search", async ({ app }) => {
  const id = ARTICLES.at(-1)!.id;
  const last = await app.evaluate(async (id) => {
    const { invoke } = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
    await Promise.all(Array.from({ length: 2000 }, (_, i) => invoke("add_tag", { id, name: `zz-${String(i).padStart(4, "0")}` })));
    await window.__e2e.emit("article-changed", id);
    return ((await invoke("list_tags")) as { name: string }[]).at(-1)!.name;
  }, id);
  await app.locator(".nav").getByRole("button", { name: "対話" }).click();
  const scope = chatScope(app);
  const picker = scopeDialog(app);
  const options = picker.getByRole("option");
  const active = picker.locator("[role=option].act");
  await scope.click();
  await expect.poll(async () => Number(await options.first().getAttribute("aria-setsize")), "every tag is an option").toBeGreaterThan(2000);
  expect(await options.count()).toBeLessThan(60);

  for (let i = 0; i < 15; i++) {
    await app.keyboard.press("ArrowDown");
  }
  await expect(active).toBeInViewport();
  for (let i = 0; i < 20; i++) {
    await app.keyboard.press("PageDown");
  }
  await expect(active).toBeInViewport();
  expect(Number(await active.getAttribute("aria-posinset"))).toBeGreaterThan(200);
  expect(await options.count()).toBeLessThan(60);

  await picker.getByRole("combobox", { name: "範囲を検索" }).fill(last);
  await app.keyboard.press("Enter");
  await expect(scope).toHaveText(`#${last}(1件)`);
  await scope.click();
  await expect(active, "it opens on the scope in use, far down the list").toHaveAccessibleName(`#${last}(1件)`);
  await expect(active).toBeInViewport();
  await app.keyboard.press("Escape");
  const q = app.locator("#chat-q");
  await q.fill("これは？");
  await q.press("Control+Enter");
  await expect
    .poll(async () => (await callsOf(app, "chat_ask")).map((x) => (x as { scope: unknown }).scope))
    .toEqual([{ kind: "filter", filter: { kind: "tag", name: last } }]);
});

test("each conversation asks the AI chosen for it, and opening it again brings the choice back", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "対話" }).click();
  const provider = app.getByLabel("回答するAI", { exact: true });
  const model = app.getByLabel("回答するモデル", { exact: true });
  const modelId = app.getByLabel("回答するモデルのID");
  const effort = app.getByLabel("回答するAIのeffort");
  const asked = async () => (await callsOf(app, "chat_ask")).map((x) => (x as { llm: unknown }).llm);
  const q = app.locator("#chat-q");
  const pickThread = async (title: string) => {
    await app.getByRole("button", { name: "会話を選ぶ" }).click();
    await app.getByRole("menuitemradio", { name: title }).click();
  };
  await expect(provider).toHaveValue("");
  await expect(model).toHaveCount(0);

  await provider.selectOption({ label: "Claude CLI" });
  await model.selectOption({ label: "その他(モデルIDを入力)" });
  await modelId.fill(" claude-opus-5-5 ");
  await effort.selectOption("max");
  await q.fill("WALとは？");
  await q.press("Control+Enter");
  const opus = { kind: "claude_cli", model: "claude-opus-5-5", effort: "max" };
  await expect.poll(asked).toEqual([opus]);
  await expect(app.locator(".chat .answer-meta")).toContainText("claude-opus-5-5");

  // A new conversation starts on the default; a saved one brings back what it chose.
  await app.getByRole("button", { name: "新しい会話" }).click();
  await expect(provider).toHaveValue("");
  await pickThread("Kafkaのexactly-once");
  await expect(provider).toHaveValue("anthropic");
  await expect(model).toHaveValue("claude-haiku-5-5");
  await expect(effort).toHaveValue("low");
  await pickThread("WALとは？");
  await expect(modelId).toHaveValue("claude-opus-5-5");
  await expect(effort).toHaveValue("max");

  // Another provider starts on its own defaults and offers only the efforts it takes.
  await provider.selectOption({ label: "Gemini API" });
  await expect(model).toHaveValue("");
  await expect(effort).toHaveValue("");
  await expect(effort.locator("option")).toHaveCount(4);
  // A conversation saved on the default opens on it; a change that was never sent is gone.
  await pickThread("MVCCとVACUUMの関係");
  await expect(provider).toHaveValue("");
  await pickThread("WALとは？");
  await expect(provider).toHaveValue("claude_cli");

  await provider.selectOption({ label: "既定(設定のAIプロバイダ)" });
  await expect(model).toHaveCount(0);
  await q.fill("続き");
  await q.press("Control+Enter");
  await expect.poll(asked).toEqual([opus, null]);

  // A provider left on its defaults is asked with them, and a follow-up asks it again without touching the row.
  await app.getByRole("button", { name: "新しい会話" }).click();
  await provider.selectOption({ label: "Gemini API" });
  await q.fill("MVCCとは？");
  await q.press("Control+Enter");
  const gemini = { kind: "gemini", model: null, effort: null };
  await expect.poll(asked).toEqual([opus, null, gemini]);
  await expect(provider).toHaveValue("gemini");
  await q.fill("VACUUMは？");
  await q.press("Control+Enter");
  await expect.poll(asked).toEqual([opus, null, gemini, gemini]);
  // Picking a model keeps the effort picked before it, and a follow-up asks that pair again, not the defaults.
  await effort.selectOption("high");
  await model.selectOption({ label: "gemini-pro-latest" });
  await q.fill("続き");
  await q.press("Control+Enter");
  const pro = { kind: "gemini", model: "gemini-pro-latest", effort: "high" };
  await expect.poll(asked).toEqual([opus, null, gemini, gemini, pro]);
  await q.fill("もう一度");
  await q.press("Control+Enter");
  await expect.poll(asked).toEqual([opus, null, gemini, gemini, pro, pro]);
});

/** `chat_ask` waits for `failSend()`, so what the user does while a send is under way can be tried. */
const holdSends = (page: Page) =>
  page.evaluate(() => {
    type Invoke = (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
    const w = window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke }; failSend: () => void };
    const invoke = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (cmd, args, options) =>
      cmd === "chat_ask" ? new Promise((_, reject) => (w.failSend = () => reject(new Error("no provider")))) : invoke(cmd, args, options);
  });
const failSend = (page: Page) => page.evaluate(() => (window as unknown as { failSend: () => void }).failSend());

for (const vim of [false, true]) {
  const editor = vim ? "Vim" : "textarea";
  const openChat = async (page: Page) => {
    await page.addInitScript((on) => {
      if (on) {
        localStorage.setItem("lattice.chatVim", "on");
      }
    }, vim);
    await page.goto("/");
    await expect(list(page).locator(".row").first()).toBeVisible({ timeout: 30_000 });
    await page.locator(".nav").getByRole("button", { name: "対話" }).click();
    const input = page.getByRole("textbox", { name: "質問", exact: true });
    await input.click();
    await holdSends(page);
    return input;
  };
  const hasText = (input: Locator, text: string) => (vim ? expect(input).toHaveText(text) : expect(input).toHaveValue(text));
  const send = (page: Page) => page.keyboard.press("Control+Enter");

  test(`${editor}: a failed send puts its question back in an empty input, with the keyboard where it is`, async ({ shell }) => {
    const input = await openChat(shell);
    await shell.keyboard.type("will fail");
    await send(shell);
    await expect(shell.locator(".pending")).toBeVisible();
    await shell.keyboard.press("Control+h");
    await expect(input).not.toBeFocused();
    const elsewhere = () => shell.evaluate(() => document.activeElement?.closest("[data-pane]")?.getAttribute("data-pane"));
    const before = await elsewhere();

    await failSend(shell);
    await expect(shell.getByRole("alert")).toBeVisible();
    await hasText(input, "will fail");
    await expect(input, "a late failure takes no keyboard").not.toBeFocused();
    expect(await elsewhere()).toBe(before);
  });

  test(`${editor}: a failed send with the keyboard in the input keeps it there`, async ({ shell }) => {
    const input = await openChat(shell);
    await shell.keyboard.type("will fail");
    await send(shell);
    await expect(shell.locator(".pending")).toBeVisible();
    await failSend(shell);
    await expect(shell.getByRole("alert")).toBeVisible();
    await hasText(input, "will fail");
    await expect(input).toBeFocused();
    await shell.keyboard.type(" again");
    await hasText(input, "will fail again");
  });

  test(`${editor}: a failed send leaves a draft typed since, and its question stays readable in the log`, async ({ shell }) => {
    const input = await openChat(shell);
    await shell.keyboard.type("will fail");
    await send(shell);
    await expect(shell.locator(".pending")).toBeVisible();
    await shell.keyboard.type("next thought");
    await hasText(input, "next thought");

    await failSend(shell);
    await expect(shell.getByRole("alert")).toBeVisible();
    await hasText(input, "next thought");
    await expect(shell.locator(".chat-log .question")).toHaveText("will fail");
    await expect(input).toBeFocused();
    await shell.keyboard.type("!");
    await hasText(input, "next thought!");

    await holdSends(shell);
    await send(shell);
    await expect(shell.locator(".chat-log .question"), "the next send clears it").toHaveText("next thought!");
    await failSend(shell);
  });

  test(`${editor}: a failed send leaves a quote received since`, async ({ shell }) => {
    const input = await openChat(shell);
    await shell.keyboard.type("will fail");
    await send(shell);
    await expect(shell.locator(".pending")).toBeVisible();
    await shell.evaluate(() => window.__e2e.emit("main-request", { kind: "chat", scopeKey: "all", quote: "quoted" }));
    await hasText(input, vim ? "> quoted" : "> quoted\n");
    await failSend(shell);
    await expect(shell.getByRole("alert")).toBeVisible();
    await hasText(input, vim ? "> quoted" : "> quoted\n");
  });
}
