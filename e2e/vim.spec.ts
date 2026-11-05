// Vim in the chat input and notes: the editor, the keys it shares with the app, and the vimrc.
import { test, expect, list, listRow, callsOf } from "./harness.ts";
import { ARTICLES } from "./fixtures.ts";
import type { Page } from "@playwright/test";

const title = ARTICLES[0].title!;
const nav = (page: Page, name: string) => page.locator(".nav").getByRole("button", { name });
const chatInput = (page: Page) => page.getByRole("textbox", { name: "質問", exact: true });
const mode = (page: Page) => page.locator(".chat-f-row .vim-mode");
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

test("the textarea's note still works next to it: Vim off, autosave as before", async ({ app }) => {
  await (await listRow(app, title)).click();
  await app.getByRole("button", { name: "メモ", exact: true }).click();
  const note = app.getByRole("complementary", { name: "メモ" }).getByRole("textbox", { name: "メモ" });
  await expect(note).toHaveJSProperty("tagName", "TEXTAREA");
  await note.fill("plain");
  await expect.poll(async () => (await callsOf(app, "set_article_note")).at(-1)).toMatchObject({ body: "plain" });
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
