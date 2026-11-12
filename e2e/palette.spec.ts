import { test, expect, list, listCount, callsOf } from "./harness.ts";
import { ARTICLES } from "./fixtures.ts";

const palette = (page: import("@playwright/test").Page) => page.getByRole("dialog", { name: "コマンドパレット" });

test("keyboard actions are commands with their key on the right, and an Ex name finds its action first", async ({ app }) => {
  const panes = app.locator("[data-pane-id]");
  await expect(panes).toHaveCount(1);
  await app.keyboard.press(":");
  await app.keyboard.type("split");
  const first = palette(app).getByRole("option").first();
  await expect(first).toContainText("ペインを下に分割");
  await expect(first.locator(".r")).toHaveText("Ctrl -");
  await app.keyboard.press("Enter");
  await expect(palette(app)).toBeHidden();
  await expect(panes).toHaveCount(2);

  await app.keyboard.press(":");
  await app.keyboard.type("vsplit");
  await expect(palette(app).getByRole("option")).toHaveCount(1);
  await expect(palette(app).getByRole("option")).toContainText("ペインを右に分割");
  await app.keyboard.press("Escape");

  await app.keyboard.press(":");
  await app.keyboard.type("close");
  await expect(palette(app).getByRole("option").first()).toContainText("ペインを閉じる");
  await app.keyboard.press("Enter");
  await expect(panes).toHaveCount(1);

  await app.keyboard.press(":");
  for (const absent of ["下へスクロール", "次の項目へ", "番号のタブへ移動", "コマンドパレット", "プレフィックスを送る(Ctrl+Aなら全選択)"]) {
    await expect(palette(app).getByRole("option", { name: absent })).toHaveCount(0);
  }
  await expect(palette(app).getByRole("option", { name: "キー一覧" })).toHaveCount(1);
});

test("Ctrl+P toggles the palette; > lists commands only", async ({ app }) => {
  await app.keyboard.press("Control+p");
  await expect(palette(app).getByRole("combobox")).toBeFocused();
  await app.keyboard.press("Control+p");
  await expect(palette(app)).toBeHidden();

  await app.keyboard.press("Control+p");
  await app.keyboard.type(">未読");
  await expect(palette(app).getByRole("option")).toHaveText(["未読を表示", "既読 / 未読m"]);
  await app.keyboard.press("Enter");
  await expect(palette(app)).toBeHidden();
  await expect(list(app).getByRole("heading", { level: 1 })).toHaveText("未読");

  await app.keyboard.press("Control+p");
  await app.keyboard.type(">設定");
  await app.keyboard.press("Enter");
  await expect(app.getByRole("main").getByRole("heading", { level: 1 })).toHaveText("AIプロバイダ");
});

test("Tab stacks a tag as a facet and keeps the palette open", async ({ app }) => {
  await app.keyboard.press("Control+p");
  await app.keyboard.type("#kafka");
  await expect(palette(app).getByRole("option").first()).toHaveText(/#kafka/);
  await app.keyboard.press("Tab");
  await expect(palette(app).getByRole("combobox")).toHaveValue("");
  await app.keyboard.press("Escape");
  const kafka = ARTICLES.filter((a) => a.tags.includes("kafka")).length;
  await expect(listCount(app)).toHaveText(`${kafka} / ${ARTICLES.length}`);
});

test("Ctrl+Enter saves a pasted URL to the library", async ({ app }) => {
  const url = "https://example.com/new-post";
  await app.keyboard.press("Control+p");
  await app.keyboard.insertText(url);
  await expect(palette(app).getByRole("option")).toHaveText(["Pageで開くEnter", /ライブラリに保存/, "フィードを検出して登録"]);
  await app.keyboard.press("Control+Enter");
  await expect.poll(() => callsOf(app, "save_url")).toEqual([{ url }]);
  await expect(app.locator(".art-title")).toHaveText(url);
});

test("a pasted URL of a saved article offers its Reader view first", async ({ app }) => {
  const saved = ARTICLES[1];
  await app.keyboard.press("Control+p");
  await app.keyboard.insertText(saved.original_url);
  await expect(palette(app).getByRole("option").first()).toContainText("Readerで開く");
  await app.keyboard.press("Enter");
  await expect(app.locator(".art-title")).toHaveText(saved.title!);
});
