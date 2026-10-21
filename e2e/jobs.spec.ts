// 処理状況: what each job type does, on its ⓘ.
import { test, expect, navItem } from "./harness.ts";

const LABELS = ["取り込みフィルタ", "取得", "描画", "画像", "サイトアイコン", "検索 index", "翻訳", "要約", "クイズ", "単語の意味", "分類", "重要度"];

test("each job type's ⓘ explains it on hover and on keyboard focus, and describes the icon", async ({ app }) => {
  await navItem(app, "処理状況").click();
  for (const label of LABELS) await expect(app.getByRole("img", { name: `${label}について` })).toHaveCount(1);

  const info = app.getByRole("img", { name: "翻訳について" });
  await expect(info).toHaveAccessibleDescription(/LLM で翻訳します/);
  const tip = app.getByRole("tooltip");
  await expect(tip).toHaveCount(0);
  await info.focus();
  await expect(tip).toHaveText(/記事の段落を LLM で翻訳します/);
  await app.keyboard.press("Escape");
  await expect(tip).toHaveCount(0);
  await expect(app.getByRole("heading", { name: "処理状況" }), "Esc closed the tooltip, not the screen").toBeVisible();

  await app.getByRole("img", { name: "取得について" }).hover();
  await expect(tip).toHaveText(/本文を取り出し/);
  await app.mouse.move(0, 0);
  await expect(tip).toHaveCount(0);
});
