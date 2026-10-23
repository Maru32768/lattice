import { test, expect, list, listCount, callsOf } from "./harness.ts";
import { ARTICLES } from "./fixtures.ts";

const palette = (page: import("@playwright/test").Page) => page.getByRole("dialog", { name: "コマンドパレット" });

test("Ctrl+K toggles the palette; > lists commands only", async ({ app }) => {
  await app.keyboard.press("Control+k");
  await expect(palette(app).getByRole("combobox")).toBeFocused();
  await app.keyboard.press("Control+k");
  await expect(palette(app)).toBeHidden();

  await app.keyboard.press("Control+k");
  await app.keyboard.type(">未読");
  await expect(palette(app).getByRole("option")).toHaveText(["未読を表示"]);
  await app.keyboard.press("Enter");
  await expect(palette(app)).toBeHidden();
  await expect(list(app).getByRole("heading", { level: 1 })).toHaveText("未読");

  await app.keyboard.press("Control+k");
  await app.keyboard.type(">設定");
  await app.keyboard.press("Enter");
  await expect(app.getByRole("main").getByRole("heading", { level: 1 })).toHaveText("AI プロバイダ");
});

test("Tab stacks a tag as a facet and keeps the palette open", async ({ app }) => {
  await app.keyboard.press("Control+k");
  await app.keyboard.type("#kafka");
  await expect(palette(app).getByRole("option").first()).toHaveText(/#kafka/);
  await app.keyboard.press("Tab");
  await expect(palette(app).getByRole("combobox")).toHaveValue("");
  await app.keyboard.press("Escape");
  const kafka = ARTICLES.filter((a) => a.tags.includes("kafka")).length;
  await expect(listCount(app)).toHaveText(`${kafka} / ${ARTICLES.length}`);
});

test("Ctrl+Enter saves a pasted URL to the Index", async ({ app }) => {
  const url = "https://example.com/new-post";
  await app.keyboard.press("Control+k");
  await app.keyboard.insertText(url);
  await expect(palette(app).getByRole("option")).toHaveText(["Page で開くEnter", /Index に追加/, "フィードを検出して登録"]);
  await app.keyboard.press("Control+Enter");
  await expect.poll(() => callsOf(app, "save_url")).toEqual([{ url }]);
  await expect(app.locator(".art-title")).toHaveText(url);
});

test("a pasted URL of a saved article offers its Reader view first", async ({ app }) => {
  const saved = ARTICLES[1];
  await app.keyboard.press("Control+k");
  await app.keyboard.insertText(saved.original_url);
  await expect(palette(app).getByRole("option").first()).toContainText("Reader で開く");
  await app.keyboard.press("Enter");
  await expect(app.locator(".art-title")).toHaveText(saved.title!);
});
