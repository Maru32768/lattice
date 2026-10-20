import { test, expect, callsOf } from "./harness.ts";

test("a PDF picked on the import screen opens in the Reader, without Page or rendering", async ({ app }) => {
  await app.keyboard.press("Control+k");
  await app.keyboard.type(">pdf");
  await expect(app.getByRole("dialog", { name: "コマンドパレット" }).getByRole("option")).toHaveText(["PDF（論文）を取り込む"]);
  await app.keyboard.press("Enter");
  await expect(app.getByRole("group", { name: "インポートの種類" }).getByRole("button", { name: "PDF" })).toHaveAttribute("aria-pressed", "true");

  await app.getByRole("button", { name: "PDF ファイルを選択…" }).click();
  expect(await callsOf(app, "import_pdf_file")).toHaveLength(1);
  await expect(app.locator("h1.art-title")).toHaveText("Reading Order in Two Column Papers");
  const page = app.getByRole("group", { name: "表示" }).getByRole("button", { name: /Page/ });
  await expect(page).toBeDisabled();
  await expect(page).toHaveAttribute("title", "取り込んだファイルにはページがありません");

  await app.getByRole("button", { name: /^その他/ }).click();
  await expect(app.getByRole("menuitem", { name: "再抽出（保存済みの PDF から）" })).toBeVisible();
  await expect(app.getByRole("menuitem", { name: /描画して取り込み直す/ })).toHaveCount(0);
});
