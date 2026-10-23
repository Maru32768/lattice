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
  await budget.selectOption({ label: "多め（約 15 万字）" });
  expect(await callsOf(app, "set_chat_budget")).toEqual([{ budget: "large" }]);

  await section(app, "翻訳").click();
  await section(app, "要約・対話").click();
  await expect(app.getByLabel("対話で使う範囲")).toHaveValue("large");
});

test("Vim keys in the chat input: off by default, modes, motions, edits, undo, Ctrl+Enter sends", async ({ app }) => {
  const chatButton = app.locator(".nav").getByRole("button", { name: "対話" });
  await chatButton.click();
  const q = app.getByLabel("質問", { exact: true });
  await q.fill("plain");
  await q.press("Escape");
  await expect(app.locator(".vim-mode")).toHaveCount(0);

  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  await section(app, "要約・対話").click();
  await app.getByLabel("質問の入力欄で Vim キーバインドを使う").check();
  await app.keyboard.press("Escape");

  await q.fill("");
  await q.focus();
  const mode = app.locator(".chat-f-row .vim-mode");
  await expect(mode).toHaveText("INSERT");
  await q.pressSequentially("hello big world");
  await q.press("Escape");
  await expect(mode).toHaveText("NORMAL");
  expect(await q.evaluate((t: HTMLTextAreaElement) => t.selectionEnd - t.selectionStart), "block cursor").toBe(1);
  await q.pressSequentially("zq");
  await expect(q, "normal mode does not type").toHaveValue("hello big world");

  await q.pressSequentially("bb");
  await q.press("d");
  await expect(mode).toHaveText("NORMAL d");
  await q.press("w");
  await expect(q).toHaveValue("hello world");
  await q.press("u");
  await expect(q).toHaveValue("hello big world");
  await q.pressSequentially("0cwhi");
  await expect(mode).toHaveText("INSERT");
  await q.press("Escape");
  await q.pressSequentially("A!");
  await expect(q).toHaveValue("hi big world!");
  await q.press("Escape");

  await q.press("Control+Enter");
  expect((await callsOf(app, "chat_ask")).map((a) => (a as { question: string }).question)).toEqual(["hi big world!"]);
  await expect(mode, "a sent question starts the next one in insert mode").toHaveText("INSERT");
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
  await expect(scope.locator("option", { hasText: "開いている記事すべて（2 件）" })).toBeEnabled();

  // A document window reports its tabs to the main window.
  await app.evaluate((d) => window.__e2e.emit("main-request", { kind: "openDocs", label: "doc-1", docs: [d] }), { id: c.id, title: c.title! });
  await expect(opened).toHaveText([a.title!, b.title!, c.title!]);
  await scope.selectOption({ label: "開いている記事すべて（3 件）" });
  const q = app.locator("#chat-q");
  await q.fill("共通点は？");
  await q.press("Control+Enter");
  await expect
    .poll(async () => (await callsOf(app, "chat_ask")).map((x) => (x as { scope: unknown }).scope))
    .toEqual([{ kind: "articles", ids: [a.id, b.id, c.id] }]);

  // One of them, until its tab closes: then the scope widens to what is still open.
  await scope.selectOption({ label: b.title! });
  await app.getByRole("button", { name: `${b.title} を閉じる` }).click();
  await expect(opened).toHaveText([a.title!, c.title!]);
  await expect(scope).toHaveValue("open");
  await app.evaluate(() => window.__e2e.emit("main-request", { kind: "openDocs", label: "doc-1", docs: [] }));
  await expect(opened).toHaveText([a.title!]);
});
