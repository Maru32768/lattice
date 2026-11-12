import type { Page } from "@playwright/test";
import { test, expect, callsOf, navItem } from "./harness.ts";
import { GROUPS } from "./fixtures.ts";

const pdf = (name: string, body = "%PDF-1.7") => ({ name, mimeType: "application/pdf", buffer: Buffer.from(body) });
/** The PDF tab's hidden file input, which 「PDFファイルを選択…」 opens. */
const picker = (app: Page) => app.getByRole("region", { name: "PDF" }).locator('input[type="file"]');

/** Holds every PDF import until `releaseImports`, so a spec can look at the screen while a run is surely still on. */
const holdImports = (app: Page) =>
  app.evaluate(() => {
    type Invoke = (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__;
    const invoke = internals.invoke;
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    (window as unknown as { releaseImports: () => void }).releaseImports = () => release();
    internals.invoke = async (cmd, args, options) => {
      if (cmd === "import_pdf_bytes") {
        await held;
      }
      return invoke(cmd, args, options);
    };
  });
const releaseImports = (app: Page) => app.evaluate(() => (window as unknown as { releaseImports: () => void }).releaseImports());

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
  await expect(app.locator("h1.art-title")).toHaveText("Dropped Paper");
  expect(await callsOf(app, "import_pdf_bytes")).toHaveLength(1);

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
  await picker(app).setInputFiles([pdf("10 Ch10.pdf"), pdf("2 scan.pdf", "%no-text"), pdf("1 Ch1.pdf"), pdf("3 第三章.pdf")]);
  await expect(app.getByRole("status")).toHaveText("3件のPDFを取り込みました");
  await expect(app.getByRole("alert")).toHaveText(
    "2 scan.pdfを取り込めませんでした: PDFから本文を取り出せませんでした(文字のない画像だけのPDFには対応していません)",
  );
  const names = (await callsOf(app, "import_pdf_bytes.headers")).map((h) => decodeURIComponent((h as Record<string, string>)["x-file-name"]));
  expect(names).toEqual(["1 Ch1", "2 scan", "3 第三章", "10 Ch10"]);
  const manual = (await callsOf(app, "import_pdf_bytes.headers")).map((h) => (h as Record<string, string>)["x-translate-manual"]);
  expect(manual, "自動で翻訳しない is off by default, and every file says so").toEqual(["false", "false", "false", "false"]);
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

test("leaving the PDF tab mid-import and coming back shows the import still running, then its result", async ({ app }) => {
  await holdImports(app);
  await openPdfTab(app);
  await picker(app).setInputFiles([pdf("1 a.pdf"), pdf("2 b.pdf")]);
  const kinds = app.getByRole("group", { name: "インポートの種類" });
  await kinds.getByRole("button", { name: "Markdown" }).click();
  await expect(app.getByRole("checkbox", { name: "自動で翻訳しない" }), "the Markdown tab shares the box the run started with").toBeDisabled();
  await kinds.getByRole("button", { name: "PDF" }).click();
  await expect(app.getByRole("button", { name: /^取り込み中…/ }), "the run is still on, so no second one can start beside it").toBeDisabled();
  await expect(app.getByRole("checkbox", { name: "自動で翻訳しない" }), "the run keeps the value it started with").toBeDisabled();
  await expect(app.locator(".import-groups").getByRole("button")).toBeDisabled();
  await releaseImports(app);
  await expect(app.getByRole("status")).toHaveText("2件のPDFを取り込みました");
  expect(await callsOf(app, "import_pdf_bytes")).toHaveLength(2);
  await expect(app.getByRole("checkbox", { name: "自動で翻訳しない" })).toBeEnabled();
});

test("one PDF whose group could not be added to stays on the import screen with the error", async ({ app }) => {
  const [group] = GROUPS;
  await navItem(app, group.name).click();
  await app.evaluate(() => {
    type Invoke = (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__;
    const invoke = internals.invoke;
    internals.invoke = (cmd, args, options) =>
      cmd === "group_add" ? Promise.reject(new Error('{"code":"groups.notFound","params":{}}')) : invoke(cmd, args, options);
  });
  await openPdfTab(app);
  await picker(app).setInputFiles(pdf("paper.pdf"));
  await expect(app.getByRole("alert")).toHaveText("グループがありません(削除された可能性があります)");
  await expect(app.locator("h1.art-title")).toHaveCount(0);
});

test("a file of another kind picked with the PDFs is left out, and one alone is refused over the last result", async ({ app }) => {
  await openPdfTab(app);
  await picker(app).setInputFiles([pdf("1 a.pdf"), { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("x") }, pdf("2 b.pdf")]);
  await expect(app.getByRole("status")).toHaveText("2件のPDFを取り込みました");
  expect(await callsOf(app, "import_pdf_bytes")).toHaveLength(2);
  await picker(app).setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
  await expect(app.getByRole("alert")).toHaveText("このファイルは使えません");
  await expect(app.getByRole("status"), "the last batch's count goes with the new error").toHaveCount(0);
});

test("several PDFs all go into the group chosen on the import screen", async ({ app }) => {
  const [group] = GROUPS;
  await navItem(app, group.name).click();
  await openPdfTab(app);
  await expect(app.locator(".import-groups").getByRole("button")).toHaveText(group.name);
  await picker(app).setInputFiles([pdf("1 a.pdf"), pdf("2 scan.pdf", "%no-text"), pdf("3 c.pdf")]);
  await expect(app.getByRole("status")).toHaveText("2件のPDFを取り込みました");
  const calls = (await callsOf(app, "group_add")) as { id: number; articles: number[] }[];
  expect(calls).toHaveLength(1);
  expect(calls[0]?.id).toBe(group.id);
  expect(calls[0]?.articles, "the two that went in, not the one that failed").toHaveLength(2);
});

test("one PDF that cannot be imported shows why and opens nothing", async ({ app }) => {
  await openPdfTab(app);
  await picker(app).setInputFiles(pdf("scan.pdf", "%no-text"));
  await expect(app.getByRole("alert")).toHaveText("PDFから本文を取り出せませんでした(文字のない画像だけのPDFには対応していません)");
  await expect(app.getByRole("status")).toHaveCount(0);
  await expect(app.locator("h1.art-title")).toHaveCount(0);
});

test("a group picker left open when PDFs start going in closes, so the run's groups cannot change", async ({ app }) => {
  await holdImports(app);
  await openPdfTab(app);
  await app.locator(".import-groups").getByRole("button").click();
  await expect(app.getByRole("dialog", { name: "グループ" })).toBeVisible();
  await app.getByRole("region", { name: "PDF" }).evaluate((el) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(["%PDF-1.7"], "1 a.pdf", { type: "application/pdf" }));
    el.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer }));
    el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
  });
  await expect(app.getByRole("dialog", { name: "グループ" })).toHaveCount(0);
  await releaseImports(app);
  await expect(app.locator("h1.art-title")).toHaveText("Dropped Paper");
});
