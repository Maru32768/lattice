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

test("メモ: a save that failed still says so when the panel comes back, and is sent again", async ({ app }) => {
  await open(app, SNAPSHOT_ID);
  const button = app.getByRole("button", { name: "メモ", exact: true });
  await button.click();
  const panel = app.getByRole("complementary", { name: "メモ" });
  const note = panel.getByRole("textbox", { name: "メモ" });
  await note.fill("the disk is full");
  await expect(panel.getByRole("alert")).toBeVisible();
  await button.click();
  await expect(panel).toHaveCount(0);

  await button.click();
  await expect(panel.getByRole("alert"), "the text was never saved").toBeVisible();
  await expect(note).toHaveValue("the disk is full");
  await note.fill("written after all");
  await expect(panel.getByRole("status")).toHaveText("保存しました");
  await button.click();
  await button.click();
  await expect(panel.getByRole("alert")).toHaveCount(0);
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
