// Files given to the import screen and the feed manager by drag and drop or paste. The events are
// synthetic: the real WebView2 drop is what `dragDropEnabled: false` makes possible, checked by hand.
import type { Locator, Page } from "@playwright/test";
import { test, expect, callsOf } from "./harness.ts";
import { FEEDS } from "./fixtures.ts";

interface Fake {
  name: string;
  type?: string;
  text?: string;
}

/** Sends a file over `target` and drops it; true when the app took the drop (the browser would otherwise act on it). */
const drop = (target: Locator, file: Fake) =>
  target.evaluate((el, f) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([f.text ?? "x"], f.name, { type: f.type ?? "" }));
    el.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer }));
    return !el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
  }, file);

/** Pastes on `target` a clipboard holding the file, and the text if any; true when the app took it. */
const paste = (target: Locator, file: Fake, text?: string) =>
  target.evaluate(
    (el, { f, s }) => {
      const clipboardData = new DataTransfer();
      clipboardData.items.add(new File([f.text ?? "x"], f.name, { type: f.type ?? "" }));
      if (s) {
        clipboardData.setData("text/plain", s);
      }
      return !el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
    },
    { f: file, s: text },
  );

async function openImport(app: Page, tab: string) {
  await app.keyboard.press("Control+k");
  await app.keyboard.type(`>${tab}`);
  await app.keyboard.press("Enter");
}

const openFeeds = (app: Page) => app.locator("nav").getByRole("button", { name: "ソースを管理" }).click();

const PDF: Fake = { name: "論文.pdf", type: "application/pdf" };

test("a PDF dropped on the PDF tab is sent as bytes and opens in the Reader", async ({ app }) => {
  await openImport(app, "pdf");
  expect(await drop(app.getByRole("region", { name: "PDF" }), PDF)).toBe(true);
  await expect(app.locator("h1.art-title")).toHaveText("Dropped Paper");
  expect(await callsOf(app, "import_pdf_bytes")).toHaveLength(1);
  expect(await callsOf(app, "import_pdf_file")).toHaveLength(0);
});

test("a PDF pasted with the focus nowhere in particular is imported too", async ({ app }) => {
  await openImport(app, "pdf");
  await expect(app.getByRole("region", { name: "PDF" })).toBeVisible();
  expect(await paste(app.locator("body"), PDF)).toBe(true);
  await expect(app.locator("h1.art-title")).toHaveText("Dropped Paper");
});

test("a file of another kind dropped on the PDF tab is refused with a message", async ({ app }) => {
  await openImport(app, "pdf");
  await drop(app.getByRole("region", { name: "PDF" }), { name: "notes.txt", type: "text/plain" });
  await expect(app.getByRole("alert")).toHaveText("このファイルは使えません");
  expect(await callsOf(app, "import_pdf_bytes")).toHaveLength(0);
});

test("a dropped Markdown file becomes an article with its file name, and a non-UTF-8 one is refused", async ({ app }) => {
  await openImport(app, "markdown");
  const zone = app.getByRole("region", { name: "Markdown" });
  await zone.evaluate((el) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([new Uint8Array([0x82, 0xa0])], "sjis.md"));
    el.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer }));
    el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
  });
  await expect(app.getByRole("alert")).toHaveText("UTF-8のテキストファイルではありません");

  await drop(zone, { name: "memo.md", text: "# Dropped note\n\nbody" });
  await expect(app.locator("h1.art-title")).toHaveText("Dropped note");
  expect(await callsOf(app, "import_markdown")).toEqual([{ text: "# Dropped note\n\nbody", name: "memo", manual: false }]);
});

test("a URL list dropped or pasted fills the text box, and text with a picture stays a text paste", async ({ app }) => {
  await openImport(app, "一括インポート");
  const box = app.getByRole("textbox", { name: "インポートするテキスト" });
  await drop(box, { name: "list.txt", text: "https://example.com/dropped" });
  await expect(box).toHaveValue("https://example.com/dropped");
  await paste(box, { name: "list.csv", text: "https://example.com/pasted" });
  await expect(box).toHaveValue("https://example.com/pasted");
  // Word and Excel put their text and a picture of it on the clipboard.
  expect(await paste(box, { name: "image.txt" }, "some text")).toBe(false);
  await expect(box).toHaveValue("https://example.com/pasted");
});

test("OPML goes to the feed manager; an image goes to the icon of the feed being edited", async ({ app }) => {
  await openFeeds(app);
  const opml = `<opml version="2.0"><body><outline text="Dropped" xmlUrl="https://dropped.dev/feed"/></body></opml>`;
  await drop(app.locator(".manage h1"), { name: "feeds.opml", text: opml });
  await expect(app.getByRole("status")).toHaveText("1件中1件を登録");

  const [feed] = FEEDS;
  await app
    .getByRole("row", { name: new RegExp(feed.title!) })
    .getByRole("button", { name: "編集" })
    .click();
  const editor = app.getByRole("form", { name: /の名前とアイコン/ });
  await drop(editor, { name: "icon.png", type: "image/png" });
  await expect.poll(async () => (await callsOf(app, "set_feed_icon")).length).toBe(1);
  // The name field holds the focus: the paste belongs to the editor.
  await paste(app.getByLabel("表示名"), { name: "pasted.png", type: "image/png" });
  await expect.poll(async () => (await callsOf(app, "set_feed_icon")).length).toBe(2);
  await drop(editor, { name: "feeds.opml", text: opml });
  await expect(editor.getByRole("alert")).toHaveText("このファイルは使えません");
  expect(await callsOf(app, "import_opml")).toHaveLength(1);
});

test("a file dropped where nothing takes it never navigates the app; text dragged into a field stays allowed", async ({ app }) => {
  await openImport(app, "pdf");
  // On the app outside any zone: the guard cancels it, or the webview would open the file.
  expect(await drop(app.locator("nav").first(), PDF)).toBe(true);
  await expect(app.getByRole("region", { name: "PDF" })).toBeVisible();

  await app.keyboard.press("Control+k");
  const field = app.getByRole("dialog", { name: "コマンドパレット" }).locator("input").first();
  expect(await drop(field, PDF), "a file on a field is cancelled too").toBe(true);
  const textDrag = await field.evaluate((el) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/plain", "dragged");
    return !el.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer }));
  });
  expect(textDrag, "text dragged into a field keeps the browser's behavior").toBe(false);
});
