import { test, expect, callsOf } from "./harness.ts";
import type { Page } from "@playwright/test";

const section = (app: Page, title: string) =>
  app.getByRole("navigation", { name: "設定カテゴリ" }).locator(".ni").filter({ has: app.locator(".label").getByText(title, { exact: true }) });

test("the chat budget is a setting under 要約・対話 and persists", async ({ app }) => {
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
