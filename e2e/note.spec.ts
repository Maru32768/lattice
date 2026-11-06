import { test, expect, list, callsOf } from "./harness.ts";
import { ARTICLES, SNAPSHOT_ID } from "./fixtures.ts";
import type { Locator, Page } from "@playwright/test";

async function open(page: Page, id: number) {
  const title = ARTICLES.find((a) => a.id === id)!.title!;
  await list(page).locator(".row", { hasText: title }).click();
  await expect(page.locator(".art-title")).toHaveText(title);
}

test("メモ: written beside the Reader, saved as you type, back when the article opens again", async ({ app }) => {
  await open(app, SNAPSHOT_ID);
  const button = app.getByRole("button", { name: "メモ", exact: true });
  await button.click();
  const panel = app.getByRole("complementary", { name: "メモ" });
  await panel.getByRole("textbox", { name: "メモ" }).fill("2PLと比べる");
  await expect(panel.getByRole("status")).toHaveText("保存しました");
  expect((await callsOf(app, "set_article_note")).at(-1)).toEqual({ id: SNAPSHOT_ID, body: "2PLと比べる" });

  // One panel at a time: the quiz takes the memo's place.
  await app.getByRole("button", { name: "理解度チェック", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(app.getByRole("complementary", { name: "理解度チェック" })).toBeVisible();
  await expect(button, "the toolbar marks an article with a memo").toHaveClass(/\bon\b/);

  await open(app, 2);
  await expect(app.getByRole("button", { name: "メモ", exact: true })).not.toHaveClass(/\bon\b/);
  await open(app, SNAPSHOT_ID);
  await button.click();
  await expect(panel.getByRole("textbox", { name: "メモ" })).toHaveValue("2PLと比べる");
});

test("メモ: a save that failed is sent again on the way out, says so when the panel comes back, and the alert goes once it lands", async ({ app }) => {
  const saves = async () => (await callsOf(app, "set_article_note")).length;
  await open(app, SNAPSHOT_ID);
  const button = app.getByRole("button", { name: "メモ", exact: true });
  await button.click();
  const panel = app.getByRole("complementary", { name: "メモ" });
  const note = panel.getByRole("textbox", { name: "メモ" });
  await note.fill("the disk is full");
  await expect(panel.getByRole("alert")).toBeVisible();
  expect(await saves()).toBe(1);
  await button.click();
  await expect(panel).toHaveCount(0);
  await expect.poll(saves, "closing the panel tried again").toBeGreaterThan(1);

  await button.click();
  await expect(panel.getByRole("alert"), "the text was never saved").toBeVisible();
  await expect(note).toHaveValue("the disk is full");
  await app.evaluate(() => void ((window as unknown as { __diskFreed: boolean }).__diskFreed = true));
  await note.blur();
  await expect(panel.getByRole("status"), "with nothing new typed").toHaveText("保存しました");
  await expect(panel.getByRole("alert")).toHaveCount(0);
  expect((await callsOf(app, "set_article_note")).at(-1)).toEqual({ id: SNAPSHOT_ID, body: "the disk is full" });
  await button.click();
  await button.click();
  await expect(panel.getByRole("alert")).toHaveCount(0);
});

/** A slow store: a save stays on its way until `__letNotesGo` is called. */
const holdNotes = (app: Page) =>
  app.evaluate(() => {
    type Invoke = (cmd: string, ...rest: unknown[]) => Promise<unknown>;
    const w = window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke }; __letNotesGo: () => void };
    const held = new Promise<void>((go) => (w.__letNotesGo = go));
    const invoke = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (cmd, ...rest) => (cmd === "set_article_note" ? held.then(() => invoke(cmd, ...rest)) : invoke(cmd, ...rest));
  });

test("メモ: a failure that comes in after the panel was remounted reaches the panel that is open, and it can try again", async ({ app }) => {
  await open(app, SNAPSHOT_ID);
  const button = app.getByRole("button", { name: "メモ", exact: true });
  await button.click();
  const panel = app.getByRole("complementary", { name: "メモ" });
  const note = panel.getByRole("textbox", { name: "メモ" });
  await holdNotes(app);
  await note.fill("the disk is full");
  await note.blur();
  await button.click();
  await button.click();
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await app.evaluate(() => (window as unknown as { __letNotesGo: () => void }).__letNotesGo());
  await expect(panel.getByRole("alert")).toBeVisible();
  await app.evaluate(() => void ((window as unknown as { __diskFreed: boolean }).__diskFreed = true));
  await note.focus();
  await note.blur();
  await expect(panel.getByRole("status")).toHaveText("保存しました");
  await expect(panel.getByRole("alert")).toHaveCount(0);
});

test("メモ: a failed save never comes back over newer text queued behind it", async ({ app }) => {
  await open(app, SNAPSHOT_ID);
  const button = app.getByRole("button", { name: "メモ", exact: true });
  await button.click();
  const panel = app.getByRole("complementary", { name: "メモ" });
  const note = panel.getByRole("textbox", { name: "メモ" });
  await holdNotes(app);
  await note.fill("the disk is full");
  await note.blur();
  await note.fill("written after it");
  await note.blur();
  await app.evaluate(() => (window as unknown as { __letNotesGo: () => void }).__letNotesGo());
  await expect(panel.getByRole("status")).toHaveText("保存しました");
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await button.click();
  await expect(panel).toHaveCount(0);
  const saves = await callsOf(app, "set_article_note");
  expect(saves.map((s) => (s as { body: string }).body)).toEqual(["the disk is full", "written after it"]);
});

test("ジャンル: a genre added ahead of any article is listed for classification", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "ジャンルを管理" }).click();
  const name = app.getByRole("textbox", { name: "追加するジャンルの名前" });
  await name.fill("Compilers");
  await app.getByRole("button", { name: "追加", exact: true }).click();
  await expect(app.getByRole("status")).toHaveText("「Compilers」を追加しました");
  await expect(app.getByRole("combobox", { name: "Compilersの新しい名前" })).toHaveValue("Compilers");
  await name.fill("compilers");
  await expect(app.getByText("「Compilers」はすでにあります")).toBeVisible();
  await expect(app.getByRole("button", { name: "追加", exact: true })).toBeDisabled();
});

const twoReaders = {
  root: {
    kind: "split",
    id: 90,
    dir: "row",
    sizes: [0.5, 0.5],
    children: [
      { kind: "pane", id: 1, tabs: [{ kind: "reader", id: 2, articleId: SNAPSHOT_ID }], active: 2 },
      { kind: "pane", id: 3, tabs: [{ kind: "reader", id: 4, articleId: 2 }], active: 4 },
    ],
  },
  focused: 1,
};

for (const vim of [false, true]) {
  const editor = vim ? "Vim" : "textarea";
  /** Two Readers side by side, with the left one's note open and the keyboard in it. */
  const openNote = async (page: Page) => {
    await page.addInitScript(
      ([layout, on]) => {
        localStorage.setItem("lattice.layout", layout);
        if (on) {
          localStorage.setItem("lattice.chatVim", "on");
        }
      },
      [JSON.stringify(twoReaders), vim] as const,
    );
    await page.goto("/");
    await expect(list(page).locator(".row").first()).toBeVisible({ timeout: 30_000 });
    await page.locator(".dpane").first().getByRole("button", { name: "メモ", exact: true }).click();
    const note = page.getByRole("complementary", { name: "メモ" }).getByRole("textbox", { name: "メモ" });
    await expect(note).toBeFocused();
    return note;
  };
  const hasText = (note: Locator, text: string) => (vim ? expect(note).toHaveText(text) : expect(note).toHaveValue(text));
  const lastSaved = async (page: Page) => ((await callsOf(page, "set_article_note")).at(-1) as { body: string } | undefined)?.body;

  test(`${editor}: what was just typed survives a pane swap that remounts the note, and the next key does not save over it`, async ({ shell }) => {
    const note = await openNote(shell);
    await shell.keyboard.type("kept");
    await expect.poll(() => lastSaved(shell), "saved once").toBe("kept");
    await shell.keyboard.type(" and new");
    await shell.keyboard.press("Control+b");
    await shell.keyboard.press("}");
    await expect(shell.locator(".dpane").nth(1).locator(".note-panel"), "the Reader went to the other pane").toBeVisible();
    await hasText(note, "kept and new");
    await expect.poll(() => lastSaved(shell)).toBe("kept and new");

    await note.click();
    await shell.keyboard.press("Control+End");
    await shell.keyboard.type("!");
    await expect.poll(() => lastSaved(shell), "the next save has it all").toBe("kept and new!");
  });

  test(`${editor}: what was just typed survives the split around it closing`, async ({ shell }) => {
    const note = await openNote(shell);
    await shell.keyboard.type("kept and new");
    // Into the other pane, whose close merges the split and remounts this Reader.
    await shell.keyboard.press("Control+l");
    await shell.keyboard.press("Control+b");
    await shell.keyboard.press("x");
    await expect(shell.locator(".dpane")).toHaveCount(1);
    await hasText(note, "kept and new");
    await expect.poll(() => lastSaved(shell)).toBe("kept and new");
  });
}
