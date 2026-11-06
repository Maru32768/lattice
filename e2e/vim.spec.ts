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

test("the engine stays unloaded while Vim is off, even with the vimrc diagnostics on screen", async ({ app }) => {
  const loaded: string[] = [];
  app.on("request", (r) => {
    if (/codemirror|VimEditor/i.test(r.url())) {
      loaded.push(r.url());
    }
  });
  await nav(app, "対話").click();
  await expect(app.getByLabel("質問", { exact: true })).toHaveJSProperty("tagName", "TEXTAREA");
  await nav(app, "設定").click();
  await app.getByRole("navigation", { name: "設定カテゴリ" }).locator(".ni", { hasText: "ショートカット" }).click();
  const rc = app.getByLabel("vimrc", { exact: true });
  await rc.fill("nnoremap x y\nset number");
  await expect(app.getByText("適用: 1件")).toBeVisible();
  await expect(app.locator(".vimrc-skips li")).toHaveText(/2行目\s*set number\s*使えないオプションがあります/);
  expect(loaded).toEqual([]);

  await app.getByLabel("対話の入力欄とメモでVimキーバインドを使う").check();
  await app.keyboard.press("Escape");
  await expect(chatInput(app)).toHaveAttribute("contenteditable", "true");
  expect(loaded.length, "turning it on loads the editor").toBeGreaterThan(0);
});

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

test("with Esc Esc mapped, a lone Esc in normal mode does not eat the next key", async ({ page }) => {
  await chat(page, "nnoremap <esc><esc> :noh<cr>");
  await page.keyboard.type("abc");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.keyboard.press("x");
  await expect(chatInput(page)).toHaveText("ab");
  await page.keyboard.press("Escape");
  await page.keyboard.press("d");
  await expect(mode(page), "the wait shows only what still counts").toHaveText("NORMAL d");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(mode(page), "two of them run the mapping and end the wait").toHaveText("NORMAL");
  await expect(chatInput(page)).toBeFocused();
});

test("an unmap applies in its place in the vimrc: a later line can map the key again", async ({ page }) => {
  await chat(page, "nnoremap x rZ\nunmap x\nnnoremap s rZ\nunmap s\nnnoremap s rY");
  await page.keyboard.type("abc");
  await page.keyboard.press("Escape");
  await page.keyboard.press("s");
  await expect(chatInput(page)).toHaveText("abY");
  await page.keyboard.press("x");
  await expect(chatInput(page), "x is back to its own command").toHaveText("ab");
});

test("a leader with a command of its own in one mode still leads", async ({ page }) => {
  await chat(page, 'let mapleader = "s"\nnnoremap <leader>x rZ');
  await page.keyboard.type("abc");
  await page.keyboard.press("Escape");
  await page.keyboard.type("sx");
  await expect(chatInput(page)).toHaveText("abZ");
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

test("changing the vimrc applies to the open editor, and an old mapping goes", async ({ page }) => {
  await chat(page, "nnoremap Q x");
  await page.keyboard.type("abc");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Shift+Q");
  await expect(chatInput(page)).toHaveText("ab");

  await nav(page, "設定").click();
  await page.getByRole("navigation", { name: "設定カテゴリ" }).locator(".ni", { hasText: "ショートカット" }).click();
  await page.getByLabel("vimrc", { exact: true }).fill('let mapleader=","\nnnoremap Z x');
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  await chatInput(page).click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("$");
  await page.keyboard.press("Shift+Q");
  await expect(chatInput(page), "Q is the engine's again: it does nothing here").toHaveText("ab");
  await page.keyboard.press("Shift+Z");
  await expect(chatInput(page), "the new mapping works, once re-applied over a removed default").toHaveText("a");
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

test("Settings: the toggle, a monospaced vimrc, reading a file in, and the lines left out", async ({ app }) => {
  await nav(app, "設定").click();
  await app.getByRole("navigation", { name: "設定カテゴリ" }).locator(".ni", { hasText: "要約・対話" }).click();
  await expect(app.getByLabel("対話の入力欄とメモでVimキーバインドを使う"), "the toggle moved out of chat settings").toHaveCount(0);
  await app.getByRole("navigation", { name: "設定カテゴリ" }).locator(".ni", { hasText: "ショートカット" }).click();

  const rc = app.getByLabel("vimrc", { exact: true });
  await expect(rc).toHaveCSS("font-family", /JetBrains Mono/);
  await expect(app.locator(".vimrc-skips")).toHaveCount(0);
  await app.locator("input[type=file]").setInputFiles({
    name: ".vimrc",
    mimeType: "",
    buffer: Buffer.from(["nnoremap j gj", "Plug 'someone/something'", "autocmd BufRead * set pcre", "tnoremap x y", "nnoremap a <c-w>w"].join("\n")),
  });
  await expect(rc).toHaveValue(/^nnoremap j gj\n/);
  await expect(app.getByText("適用: 1件")).toBeVisible();
  await expect(app.locator(".vimrc-skips li")).toHaveText([
    /2行目\s*Plug 'someone\/something'\s*プラグインの設定です/,
    /3行目\s*autocmd BufRead \* set pcre\s*スクリプトは実行しません/,
    /4行目\s*tnoremap x y\s*このモードはありません/,
    /5行目\s*nnoremap a <c-w>w\s*ペインの移動はアプリのキーで行います/,
  ]);

  await app.locator("input[type=file]").setInputFiles({ name: "binary", mimeType: "", buffer: Buffer.from([0xff, 0xfe, 0x00]) });
  await expect(app.getByRole("alert")).toHaveText("UTF-8のテキストファイルではありません");
  await expect(rc, "a file that cannot be read leaves the text").toHaveValue(/^nnoremap j gj\n/);

  await app.reload();
  await expect(list(app).locator(".row").first()).toBeVisible({ timeout: 30_000 });
  await nav(app, "設定").click();
  await app.getByRole("navigation", { name: "設定カテゴリ" }).locator(".ni", { hasText: "ショートカット" }).click();
  await expect(app.getByLabel("vimrc", { exact: true }), "it is kept").toHaveValue(/^nnoremap j gj\n/);
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

test("a page's quote lands in the Vim editor after what was typed, and typing goes on from it", async ({ shell }) => {
  await chat(shell);
  await shell.keyboard.type("draft");
  await shell.evaluate(() => window.__e2e.emit("browser-ask", { tab: "none", quote: "a quoted line" }));
  await expect(chatInput(shell)).toContainText("draft");
  await expect(chatInput(shell)).toContainText("> a quoted line");
  await expect(chatInput(shell)).toBeFocused();
  await expect(mode(shell)).toHaveText("INSERT");
  await shell.keyboard.type("why");
  await expect(chatInput(shell)).toContainText("why");
  expect(await questions(shell)).toEqual([]);
});
