import { test, expect, callsOf, list } from "./harness.ts";
import { ARTICLES } from "./fixtures.ts";
import type { Page } from "@playwright/test";

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
  await section(app, "要約・対話").click();
  await app.getByLabel("質問の入力欄でVimキーバインドを使う").check();
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
