import type { Page } from "@playwright/test";
import { test, expect, callsOf } from "./harness.ts";

const pdf = (name: string, body = "%PDF-1.7") => ({ name, mimeType: "application/pdf", buffer: Buffer.from(body) });
/** The PDF tab's hidden file input, which 「PDFファイルを選択…」 opens. */
const picker = (app: Page) => app.getByRole("region", { name: "PDF" }).locator('input[type="file"]');

async function openPdfTab(app: Page) {
  await app.keyboard.press("Control+p");
  await app.keyboard.type(">pdf");
  await expect(app.getByRole("dialog", { name: "コマンドパレット" }).getByRole("option")).toHaveText(["PDF(論文)を取り込む"]);
  await app.keyboard.press("Enter");
  await expect(app.getByRole("group", { name: "インポートの種類" }).getByRole("button", { name: "PDF" })).toHaveAttribute("aria-pressed", "true");
}

test("a PDF picked on the import screen opens in the Reader, and Page shows the saved original", async ({ app }) => {
  await openPdfTab(app);
  await picker(app).setInputFiles(pdf("paper.pdf"));
  expect(await callsOf(app, "import_pdf_bytes")).toHaveLength(1);
  await expect(app.locator("h1.art-title")).toHaveText("Dropped Paper");

  await app.getByRole("button", { name: /^その他/ }).click();
  await expect(app.getByRole("menuitem", { name: "再抽出(保存済みのPDFから)" })).toBeVisible();
  await expect(app.getByRole("menuitem", { name: /描画して取り込み直す/ })).toHaveCount(0);
  await app.keyboard.press("Escape");

  await app.getByRole("group", { name: "表示" }).getByRole("button", { name: /Page/ }).click();
  await expect
    .poll(async () => ((await callsOf(app, "browser_open")).at(-1) as { url: string } | undefined)?.url)
    .toMatch(/^http:\/\/lattice-pdf\.localhost\/\d+$/);
  const tab = app.getByRole("tab", { name: /Dropped Paper/ });
  await expect(tab).toBeVisible();
  await expect(app.getByRole("button", { name: /保存したPDF/ })).toBeVisible();
  await expect(app.getByRole("group", { name: "このページを翻訳" })).toBeVisible();

  // The bar's label is not an address: Enter without an edit must not search the web for it.
  const opened = (await callsOf(app, "browser_open")).length;
  await app.getByRole("button", { name: /保存したPDF/ }).click();
  await app.locator("input.url-pill").press("Enter");
  await expect(app.getByRole("button", { name: /保存したPDF/ })).toBeVisible();
  expect(await callsOf(app, "browser_open")).toHaveLength(opened);

  await app.getByRole("button", { name: /^その他/ }).click();
  await expect(app.getByRole("menuitem", { name: "再抽出(保存済みのPDFから)" })).toBeVisible();
  await expect(app.getByRole("menuitem", { name: /取り込み直す/ })).toHaveCount(0);
  await app.keyboard.press("Escape");
  await app.getByRole("group", { name: "表示" }).getByRole("button", { name: "Reader" }).click();
  await expect(app.locator("h1.art-title")).toHaveText("Dropped Paper");
});

test("several PDFs go in by file name, the screen stays, and one that fails is listed while the rest go in", async ({ app }) => {
  await openPdfTab(app);
  await picker(app).setInputFiles([pdf("10 Ch10.pdf"), pdf("2 scan.pdf", "%no-text"), pdf("1 Ch1.pdf")]);
  await expect(app.getByRole("status")).toHaveText("2件のPDFを取り込みました");
  await expect(app.getByRole("alert")).toHaveText(
    "2 scan.pdfを取り込めませんでした: PDFから本文を取り出せませんでした(文字のない画像だけのPDFには対応していません)",
  );
  const names = (await callsOf(app, "import_pdf_bytes.headers")).map((h) => decodeURIComponent((h as Record<string, string>)["x-file-name"]));
  expect(names).toEqual(["1 Ch1", "2 scan", "10 Ch10"]);
  await expect(app.getByRole("region", { name: "PDF" })).toBeVisible();
  await expect(app.locator("h1.art-title")).toHaveCount(0);
});

test("the PDF tab's 自動で翻訳しない goes with every file and is still checked at the next import", async ({ app }) => {
  await openPdfTab(app);
  await app.getByRole("checkbox", { name: "自動で翻訳しない" }).check();
  await picker(app).setInputFiles([pdf("1 a.pdf"), pdf("2 b.pdf")]);
  await expect(app.getByRole("status")).toHaveText("2件のPDFを取り込みました");
  const manual = (await callsOf(app, "import_pdf_bytes.headers")).map((h) => (h as Record<string, string>)["x-translate-manual"]);
  expect(manual).toEqual(["true", "true"]);
  expect(await callsOf(app, "set_ui_prefs")).toContainEqual({ prefs: { "lattice.importNoAutoTranslate": "on" } });

  await app.locator("nav").getByRole("button", { name: "ソースを管理" }).click();
  await openPdfTab(app);
  await expect(app.getByRole("checkbox", { name: "自動で翻訳しない" })).toBeChecked();
  await app.getByRole("group", { name: "インポートの種類" }).getByRole("button", { name: "Markdown" }).click();
  await expect(app.getByRole("checkbox", { name: "自動で翻訳しない" }), "the Markdown tab shares it").toBeChecked();
});
