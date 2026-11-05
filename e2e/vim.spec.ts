// Vim in the chat input and notes: the editor, the keys it shares with the app, and the vimrc.
import { test, expect, list, listRow, callsOf } from "./harness.ts";
import { ARTICLES } from "./fixtures.ts";
import type { Page } from "@playwright/test";

const title = ARTICLES[0].title!;
const nav = (page: Page, name: string) => page.locator(".nav").getByRole("button", { name });
const chatInput = (page: Page) => page.getByRole("textbox", { name: "質問", exact: true });
const mode = (page: Page) => page.locator(".chat-f-row .vim-mode");
/** An empty editor shows its placeholder as text, so "no text" is that showing. */
const isEmpty = (page: Page) => expect(page.locator(".chat-f .cm-placeholder")).toBeVisible();
const questions = async (page: Page) => (await callsOf(page, "chat_ask")).map((a) => (a as { question: string }).question);

/** The main window with Vim on from the start, and the chat open with the keyboard in its input. */
async function chat(page: Page, vimrc = "") {
  await page.addInitScript((text) => {
    localStorage.setItem("lattice.chatVim", "on");
    localStorage.setItem("lattice.vimrc", text);
  }, vimrc);
  await page.goto("/");
  await expect(list(page).locator(".row").first()).toBeVisible({ timeout: 30_000 });
  await nav(page, "対話").click();
  await chatInput(page).click();
  await expect(mode(page)).toHaveText("INSERT");
}

/** An Ex command typed at the engine's prompt, from insert mode. */
async function ex(page: Page, command: string) {
  await page.keyboard.press("Escape");
  await page.keyboard.type(`:${command}`);
  await page.keyboard.press("Enter");
}

test("the editor is the label's and focusPane's #chat-q", async ({ page }) => {
  await chat(page);
  await expect(page.locator("#chat-q")).toHaveClass(/cm-content/);
  await page.keyboard.press("Control+h");
  await expect(page.locator("#chat-q")).not.toBeFocused();
  await page.keyboard.press("Control+l");
  await expect(page.locator("#chat-q"), "moving into the chat lands in its input").toBeFocused();
});

test("Esc stays in the editor: insert to normal, and normal stays normal", async ({ page }) => {
  await chat(page);
  await page.keyboard.type("x");
  await page.keyboard.press("Escape");
  await expect(mode(page)).toHaveText("NORMAL");
  await expect(chatInput(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(chatInput(page)).toBeFocused();
  await expect(mode(page)).toHaveText("NORMAL");
  await page.keyboard.press("d");
  await expect(mode(page)).toHaveText("NORMAL d");
  await page.keyboard.press("Escape");
  await expect(mode(page), "Esc ends what the engine was waiting for").toHaveText("NORMAL");
});

test("visual mode shows on the badge", async ({ page }) => {
  await chat(page);
  await page.keyboard.type("one two");
  await page.keyboard.press("Escape");
  await page.keyboard.press("v");
  await expect(mode(page)).toHaveText("VISUAL");
  await expect(page.locator(".cm-selectionBackground").first()).toBeVisible();
  await page.keyboard.press("d");
  await expect(chatInput(page)).toHaveText("one tw");
  await page.keyboard.press("Shift+V");
  await expect(mode(page)).toHaveText("VISUAL LINE");
});

test(":w sends and :q leaves the chat input", async ({ page }) => {
  await chat(page);
  await page.keyboard.type("question");
  await ex(page, "w");
  await expect.poll(() => questions(page)).toEqual(["question"]);
  await isEmpty(page);
  await expect(chatInput(page)).toBeFocused();
  await expect(mode(page)).toHaveText("INSERT");

  await ex(page, "q");
  await expect(chatInput(page)).not.toBeFocused();
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "キー一覧" }), "the keys are the app's again").toBeVisible();
});

test(":w saves and :q closes the note", async ({ page }) => {
  await chat(page);
  await (await listRow(page, title)).click();
  await expect(page.locator(".art-title")).toHaveText(title);
  const button = page.getByRole("button", { name: "メモ", exact: true });
  await button.click();
  const panel = page.getByRole("complementary", { name: "メモ" });
  const note = panel.getByRole("textbox", { name: "メモ" });
  await expect(note).toBeFocused();
  await expect(panel.locator(".vim-mode")).toHaveText("INSERT");

  await page.keyboard.type("読み返す");
  await ex(page, "w");
  await expect.poll(async () => (await callsOf(page, "set_article_note")).at(-1)).toMatchObject({ body: "読み返す" });
  await expect(panel.getByRole("status")).toHaveText("保存しました");
  await expect(note, ":w stays in the note").toBeFocused();

  await page.keyboard.type(":q");
  await page.keyboard.press("Enter");
  await expect(panel).toHaveCount(0);
  await page.locator(".reader").evaluate((el) => void ((el as HTMLElement).style.minHeight = "6000px"));
  await page.keyboard.press("j");
  await expect.poll(() => page.locator(".doc-scroll").evaluate((el) => el.scrollTop), "the keys go on in the document").toBeGreaterThan(0);
  await button.click();
  await expect(panel.getByRole("textbox", { name: "メモ" })).toHaveText("読み返す");
});

test("the textarea's note still works next to it: Vim off, autosave as before", async ({ app }) => {
  await (await listRow(app, title)).click();
  await app.getByRole("button", { name: "メモ", exact: true }).click();
  const note = app.getByRole("complementary", { name: "メモ" }).getByRole("textbox", { name: "メモ" });
  await expect(note).toHaveJSProperty("tagName", "TEXTAREA");
  await note.fill("plain");
  await expect.poll(async () => (await callsOf(app, "set_article_note")).at(-1)).toMatchObject({ body: "plain" });
});

test("Ex names from the alias table run the app's actions, and :wincmd moves panes", async ({ page }) => {
  await chat(page);
  await (await listRow(page, title)).click();
  await expect(page.locator(".art-title")).toHaveText(title);
  await chatInput(page).click();
  await expect(page.locator(".dpane")).toHaveCount(1);
  await ex(page, "split");
  await expect(page.locator(".dpane")).toHaveCount(2);

  await chatInput(page).click();
  await ex(page, "wincmd h");
  await expect(chatInput(page), "the prompt's refocus does not undo the move").not.toBeFocused();
  await expect(page.locator(".dpane.focused")).toContainText(title);
});

test("the app's keys work from the editor, in both modes; typed keys stay the editor's", async ({ page }) => {
  await chat(page);
  // Ctrl+B is the engine's page up in normal mode: here it must lead the app's chord.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+b");
  await expect(page.locator(".prefix-hint")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".prefix-hint")).toHaveCount(0);
  await expect(mode(page), "Esc ended the chord, not a mode").toHaveText("NORMAL");
  await page.keyboard.press("i");
  await expect(mode(page)).toHaveText("INSERT");

  await page.keyboard.press("Control+p");
  const palette = page.getByRole("dialog", { name: "コマンドパレット" });
  await expect(palette).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);
  await expect(chatInput(page), "the palette gives the keyboard back").toBeFocused();

  // The app's single keys are text here: `g t`, `/`, `?` and `:` do nothing of the app's.
  await page.keyboard.type("gt/?:;j");
  await expect(chatInput(page)).toHaveText("gt/?:;j");
  await expect(palette).toHaveCount(0);

  await page.keyboard.press("Control+h");
  await expect(chatInput(page)).not.toBeFocused();
});

test("a vimrc applies, with the leader's key given up and a <nop> on it", async ({ page }) => {
  await chat(
    page,
    [
      'let mapleader = "\\<space>"',
      "noremap ; :",
      "nnoremap H ^",
      "nnoremap L $",
      "nnoremap <leader>x :wincmd h<cr>",
      "nnoremap <space> <nop>",
      "nnoremap Q <nop>",
      "nnoremap <leader>d dd",
      "set nosuchoption",
    ].join("\n"),
  );
  await page.keyboard.type("  one two");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Shift+H");
  await page.keyboard.press("x");
  await expect(chatInput(page), "H is ^").toHaveText("  ne two");
  await page.keyboard.press("Shift+L");
  await page.keyboard.press("x");
  await expect(chatInput(page), "L is $").toHaveText("  ne tw");
  await page.keyboard.press("Shift+Q");
  await expect(chatInput(page), "<nop> does nothing").toHaveText("  ne tw");
  await expect(mode(page)).toHaveText("NORMAL");

  // Space alone waits, as the key that leads the mappings.
  await page.keyboard.press("Space");
  await page.keyboard.press("d");
  // <leader>d is dd, and dd emptied the only line.
  await isEmpty(page);

  await page.keyboard.type(";");
  await expect(page.locator(".cm-vim-panel input"), "`;` opens the prompt").toBeFocused();
  await page.keyboard.press("Escape");
  await expect(chatInput(page)).toBeFocused();
  await expect(mode(page)).toHaveText("NORMAL");
});

test("gj moves by screen line, as a vimrc's j asks", async ({ page }) => {
  await chat(page, "nnoremap j gj");
  const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
  await page.keyboard.type(long);
  await page.keyboard.press("Escape");
  await page.keyboard.type("gg0");
  const left = await page.locator(".cm-fat-cursor").evaluate((c) => c.getBoundingClientRect().top);
  await page.keyboard.press("j");
  await expect
    .poll(() => page.locator(".cm-fat-cursor").evaluate((c) => c.getBoundingClientRect().top), "the long line wraps, and j goes to its next row")
    .toBeGreaterThan(left);
  await expect(page.locator(".cm-line"), "one line, wrapped").toHaveCount(1);
});

test("a key the vimrc maps goes to the engine only in that mode", async ({ page }) => {
  await chat(page, "inoremap <c-h> <left>");
  await page.keyboard.type("ab");
  await page.keyboard.press("Control+h");
  await page.keyboard.type("X");
  await expect(chatInput(page), "in insert mode Ctrl+H is the vimrc's").toHaveText("aXb");
  await expect(chatInput(page)).toBeFocused();

  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+h");
  await expect(chatInput(page), "in normal mode it moves panes").not.toBeFocused();
});

test("a mapped key still ends a chord the app is reading", async ({ page }) => {
  await chat(page, "inoremap <c-h> <left>\nnnoremap x :wincmd h<cr>");
  await page.keyboard.press("Control+b");
  await expect(page.locator(".prefix-hint")).toBeVisible();
  await page.keyboard.press("Control+h");
  await expect(page.locator(".prefix-hint")).toHaveCount(0);
  await expect(chatInput(page), "and it did nothing else").toBeFocused();
  await isEmpty(page);
});

test("set clipboard+=unnamed: a plain yank also reaches the system clipboard", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await chat(page, "set clipboard+=unnamed");
  await page.keyboard.type("copied");
  await page.keyboard.press("Escape");
  await page.keyboard.type("0yw");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("copied");
});

test("without clipboard in the vimrc a yank stays in the editor", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await chat(page);
  await page.evaluate(() => navigator.clipboard.writeText("before"));
  await page.keyboard.type("copied");
  await page.keyboard.press("Escape");
  await page.keyboard.type("0yw$p");
  await expect(chatInput(page)).toHaveText("copiedcopied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("before");
});

test.describe("IME", () => {
  test("composition in insert mode types the confirmed text", async ({ page }) => {
    await chat(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.imeSetComposition", { text: "にほんご", selectionStart: 4, selectionEnd: 4 });
    await expect(chatInput(page)).toContainText("にほんご");
    await cdp.send("Input.imeSetComposition", { text: "日本語", selectionStart: 3, selectionEnd: 3 });
    await cdp.send("Input.insertText", { text: "日本語" });
    await expect(chatInput(page)).toHaveText("日本語");
    await page.keyboard.press("Control+Enter");
    await expect.poll(() => questions(page)).toEqual(["日本語"]);
  });

  test("keys with the IME on in normal mode leave the text alone", async ({ page }) => {
    await chat(page);
    await page.keyboard.type("text");
    await page.keyboard.press("Escape");
    await expect(mode(page)).toHaveText("NORMAL");
    const cdp = await page.context().newCDPSession(page);
    await chatInput(page).evaluate((el) => {
      const w = window as unknown as { compositions: number };
      w.compositions = 0;
      el.addEventListener("compositionstart", () => w.compositions++);
    });
    for (const text of ["ｊ", "あ"]) {
      await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Process", code: "KeyJ", windowsVirtualKeyCode: 229 });
      await cdp.send("Input.imeSetComposition", { text, selectionStart: 1, selectionEnd: 1 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Process", code: "KeyJ", windowsVirtualKeyCode: 229 });
      await expect(chatInput(page), "the engine ended the composition").toHaveText("text");
      await expect(mode(page)).toHaveText("NORMAL");
    }
    expect(await page.evaluate(() => (window as unknown as { compositions: number }).compositions), "the IME did start composing").toBe(2);

    // And the editor goes on working.
    await page.keyboard.press("x");
    await expect(chatInput(page)).toHaveText("tex");
    await page.keyboard.press("i");
    await page.keyboard.type("!");
    await expect(chatInput(page)).toHaveText("te!x");
  });
});
