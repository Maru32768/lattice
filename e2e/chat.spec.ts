import { test, expect, callsOf, list } from "./harness.ts";
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

test("Vim keys in the chat input: off by default, modes, motions, edits, undo, Ctrl+Enter sends", async ({ app }) => {
  const chatButton = app.locator(".nav").getByRole("button", { name: "対話" });
  await chatButton.click();
  const plain = app.getByLabel("質問", { exact: true });
  await plain.fill("plain");
  await plain.press("Escape");
  await expect(app.locator(".vim-mode")).toHaveCount(0);

  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  await section(app, "ショートカット").click();
  await app.getByLabel("対話の入力欄とメモでVimキーバインドを使う").check();
  await app.keyboard.press("Escape");

  // What the textarea held goes on in the editor.
  const q = app.getByRole("textbox", { name: "質問", exact: true });
  await expect(q).toHaveText("plain");
  await q.focus();
  const mode = app.locator(".chat-f-row .vim-mode");
  await expect(mode).toHaveText("INSERT");
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
  const scope = app.getByLabel("質問の範囲");
  const opened = scope.locator("optgroup[label='開いている記事'] option");
  await expect(opened).toHaveText([a.title!, b.title!]);
  await expect(scope.locator("option", { hasText: "開いている記事すべて(2件)" })).toBeEnabled();

  // A document window reports its tabs to the main window.
  await app.evaluate((d) => window.__e2e.emit("main-request", { kind: "openDocs", label: "doc-1", docs: [d] }), { id: c.id, title: c.title! });
  await expect(opened).toHaveText([a.title!, b.title!, c.title!]);
  await scope.selectOption({ label: "開いている記事すべて(3件)" });
  const q = app.locator("#chat-q");
  await q.fill("共通点は？");
  await q.press("Control+Enter");
  await expect
    .poll(async () => (await callsOf(app, "chat_ask")).map((x) => (x as { scope: unknown }).scope))
    .toEqual([{ kind: "articles", ids: [a.id, b.id, c.id] }]);

  // One of them, until its tab closes: then the scope widens to what is still open.
  await scope.selectOption({ label: b.title! });
  await app.getByRole("button", { name: `${b.title}を閉じる` }).click();
  await expect(opened).toHaveText([a.title!, c.title!]);
  await expect(scope).toHaveValue("open");
  await app.evaluate(() => window.__e2e.emit("main-request", { kind: "openDocs", label: "doc-1", docs: [] }));
  await expect(opened).toHaveText([a.title!]);
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
