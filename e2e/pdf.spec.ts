import { test, expect, callsOf } from "./harness.ts";

test("a PDF picked on the import screen opens in the Reader, and Page shows the saved original", async ({ app }) => {
  await app.keyboard.press("Control+k");
  await app.keyboard.type(">pdf");
  await expect(app.getByRole("dialog", { name: "コマンドパレット" }).getByRole("option")).toHaveText(["PDF(論文)を取り込む"]);
  await app.keyboard.press("Enter");
  await expect(app.getByRole("group", { name: "インポートの種類" }).getByRole("button", { name: "PDF" })).toHaveAttribute("aria-pressed", "true");

  await app.getByRole("button", { name: "PDFファイルを選択…" }).click();
  expect(await callsOf(app, "import_pdf_file")).toHaveLength(1);
  await expect(app.locator("h1.art-title")).toHaveText("Reading Order in Two Column Papers");

  await app.getByRole("button", { name: /^その他/ }).click();
  await expect(app.getByRole("menuitem", { name: "再抽出(保存済みのPDFから)" })).toBeVisible();
  await expect(app.getByRole("menuitem", { name: /描画して取り込み直す/ })).toHaveCount(0);
  await app.keyboard.press("Escape");

  await app.getByRole("group", { name: "表示" }).getByRole("button", { name: /Page/ }).click();
  await expect
    .poll(async () => ((await callsOf(app, "browser_open")).at(-1) as { url: string } | undefined)?.url)
    .toMatch(/^http:\/\/lattice-pdf\.localhost\/\d+$/);
  const tab = app.getByRole("tab", { name: /Reading Order in Two Column Papers/ });
  await expect(tab).toBeVisible();
  await expect(app.getByRole("button", { name: /保存したPDF/ })).toBeVisible();
  await expect(app.getByRole("group", { name: "このページを翻訳" })).toBeVisible();

  await app.getByRole("button", { name: /^その他/ }).click();
  await expect(app.getByRole("menuitem", { name: "再抽出(保存済みのPDFから)" })).toBeVisible();
  await expect(app.getByRole("menuitem", { name: /取り込み直す/ })).toHaveCount(0);
  await app.keyboard.press("Escape");
  await app.getByRole("group", { name: "表示" }).getByRole("button", { name: "Reader" }).click();
  await expect(app.locator("h1.art-title")).toHaveText("Reading Order in Two Column Papers");
});
