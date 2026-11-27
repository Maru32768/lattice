import { test, expect, list, callsOf, holdEvents, invoke } from "./harness.ts";
import { ARTICLES, SNAPSHOT_ID } from "./fixtures.ts";
import type { Locator, Page } from "@playwright/test";
import type { ArticleView } from "../src/api.ts";

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
  expect((await callsOf(app, "set_article_note")).at(-1)).toEqual({ id: SNAPSHOT_ID, body: "2PLと比べる", revision: 0 });

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
  expect((await callsOf(app, "set_article_note")).at(-1)).toEqual({ id: SNAPSHOT_ID, body: "the disk is full", revision: 0 });
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

test("メモ: a retry that lands after a remount clears the alert of the panel that is open", async ({ app }) => {
  await open(app, SNAPSHOT_ID);
  const button = app.getByRole("button", { name: "メモ", exact: true });
  await button.click();
  const panel = app.getByRole("complementary", { name: "メモ" });
  const note = panel.getByRole("textbox", { name: "メモ" });
  await note.fill("the disk is full");
  await expect(panel.getByRole("alert")).toBeVisible();
  await app.evaluate(() => void ((window as unknown as { __diskFreed: boolean }).__diskFreed = true));
  await holdNotes(app);
  // The old panel's retry is still on its way as the new one comes up over the failure.
  await button.click();
  await button.click();
  await expect(panel.getByRole("alert")).toBeVisible();
  await app.evaluate(() => (window as unknown as { __letNotesGo: () => void }).__letNotesGo());
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await expect(panel.getByRole("status")).toHaveText("保存しました");
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

test("メモ: text typed again while an earlier save of it is on its way is still saved last", async ({ app }) => {
  await open(app, SNAPSHOT_ID);
  await app.getByRole("button", { name: "メモ", exact: true }).click();
  const note = app.getByRole("complementary", { name: "メモ" }).getByRole("textbox", { name: "メモ" });
  await holdNotes(app);
  await note.fill("first");
  await note.blur();
  await note.fill("first and more");
  await note.blur();
  await note.fill("first");
  await app.evaluate(() => (window as unknown as { __letNotesGo: () => void }).__letNotesGo());
  await expect.poll(async () => (await callsOf(app, "set_article_note")).map((s) => (s as { body: string }).body).at(-1)).toBe("first");
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

/** One article's note open in two panes, with the keyboard in neither's text yet. */
const twoPanels = async (page: Page) => {
  const [left, right] = twoReaders.root.children;
  const sameArticle = { ...twoReaders, root: { ...twoReaders.root, children: [left, { ...right, tabs: [{ ...right.tabs[0], articleId: SNAPSHOT_ID }] }] } };
  await page.addInitScript((layout) => localStorage.setItem("lattice.layout", layout), JSON.stringify(sameArticle));
  await page.goto("/");
  await expect(list(page).locator(".row").first()).toBeVisible({ timeout: 30_000 });
  const toggles = [0, 1].map((i) => page.locator(".dpane").nth(i).getByRole("button", { name: "メモ", exact: true }));
  await toggles[0].click();
  await toggles[1].click();
  const panels = [0, 1].map((i) => page.locator(".dpane").nth(i).getByRole("complementary", { name: "メモ" }));
  return { toggles, panels, notes: panels.map((panel) => panel.getByRole("textbox", { name: "メモ" })) };
};
const savedBodies = async (page: Page) => (await callsOf(page, "set_article_note")).map((s) => (s as { body: string }).body);

test("メモ: the text another panel holds to retry never overwrites newer text saved since", async ({ shell }) => {
  const { toggles, panels, notes } = await twoPanels(shell);
  await notes[0].fill("the disk is full");
  await notes[0].blur();
  await expect(panels[1].getByRole("alert")).toBeVisible();
  await notes[0].fill("written after it");
  await notes[0].blur();
  await expect(panels[1].getByRole("alert")).toHaveCount(0);
  await notes[1].focus();
  await notes[1].blur();
  await toggles[1].click();
  await expect(panels[1]).toHaveCount(0);
  expect(await savedBodies(shell)).toEqual(["the disk is full", "written after it"]);
});

test("メモ: a panel holding an older retry takes on the newest text when that fails too", async ({ shell }) => {
  const { toggles, panels, notes } = await twoPanels(shell);
  await notes[0].fill("the disk is full");
  await notes[0].blur();
  await expect(panels[1].getByRole("alert")).toBeVisible();
  await notes[0].fill("the disk is full still");
  await toggles[0].click();
  await expect(panels[0]).toHaveCount(0);
  await expect.poll(async () => (await savedBodies(shell)).at(-1)).toBe("the disk is full still");
  await expect(panels[1].getByRole("alert")).toBeVisible();
  await shell.evaluate(() => void ((window as unknown as { __diskFreed: boolean }).__diskFreed = true));
  await notes[1].focus();
  await notes[1].blur();
  await expect(panels[1].getByRole("status")).toHaveText("保存しました");
  expect((await savedBodies(shell)).at(-1)).toBe("the disk is full still");
});

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
    await shell.keyboard.press("Control+a");
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
    await shell.keyboard.press("Control+a");
    await shell.keyboard.press("x");
    await expect(shell.locator(".dpane")).toHaveCount(1);
    await hasText(note, "kept and new");
    await expect.poll(() => lastSaved(shell)).toBe("kept and new");
  });
}

const stored = async (page: Page) => (await invoke(page, "get_article", { id: SNAPSHOT_ID })) as ArticleView;
const memoPanel = (page: Page) => {
  const panel = page.getByRole("complementary", { name: "メモ" });
  return { panel, note: panel.getByRole("textbox", { name: "メモ" }) };
};

test("メモ: what another window saves or adds comes in where nothing here is unsent, with the keyboard kept, and the toolbar marks it", async ({ app }) => {
  await open(app, SNAPSHOT_ID);
  const button = app.getByRole("button", { name: "メモ", exact: true });
  await expect(button).not.toHaveClass(/\bon\b/);
  await invoke(app, "set_article_note", { id: SNAPSHOT_ID, body: "X", revision: 0 });
  await expect(button, "with the panel closed").toHaveClass(/\bon\b/);
  await button.click();
  const { panel, note } = memoPanel(app);
  await expect(note).toHaveValue("X");
  await expect(note).toBeFocused();
  await invoke(app, "append_article_note", { id: SNAPSHOT_ID, text: "Y" });
  await expect(note).toHaveValue("X\n\nY");
  await expect(note).toBeFocused();
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await note.press("Control+End");
  await note.pressSequentially("!");
  await expect.poll(async () => (await stored(app)).note, "saved from the memo it took, not refused").toBe("X\n\nY!");
});

test("Vim: the memo's own saves keep its editor and the cursor, and another window's save comes in with the keyboard kept", async ({ shell }) => {
  await shell.addInitScript(() => localStorage.setItem("lattice.chatVim", "on"));
  await shell.goto("/");
  await expect(list(shell).locator(".row").first()).toBeVisible({ timeout: 30_000 });
  await open(shell, SNAPSHOT_ID);
  await shell.getByRole("button", { name: "メモ", exact: true }).click();
  const { panel, note } = memoPanel(shell);
  await expect(note).toBeFocused();
  // An editor made again is a new element, without this.
  await note.evaluate((el) => void ((el as { first?: boolean }).first = true));
  // Their events come after both saves, the first of them older than what the editor has then.
  const letEventsGo = await holdEvents(shell, "note-changed");
  await shell.keyboard.type("abc");
  await expect(panel.getByRole("status")).toHaveText("保存しました");
  await shell.keyboard.type("def");
  await expect.poll(async () => (await stored(shell)).note).toBe("abcdef");
  await letEventsGo();
  await shell.evaluate(() => new Promise((drawn) => requestAnimationFrame(() => requestAnimationFrame(drawn))));
  await expect(note).toHaveText("abcdef");
  expect(await note.evaluate((el) => (el as { first?: boolean }).first), "the same editor").toBe(true);

  const { note_revision } = await stored(shell);
  await invoke(shell, "set_article_note", { id: SNAPSHOT_ID, body: "from the other window", revision: note_revision });
  await expect(note).toHaveText("from the other window");
  await expect(note).toBeFocused();
  await expect(panel.getByRole("alert")).toHaveCount(0);
});

/** Types `text` at the end of the memo and, before that can be saved, another window saves `body` from `revision`. */
const typedAsAnotherSaves = (page: Page, text: string, body: string, revision: number) =>
  page.evaluate(
    ([text, body, revision, id]) => {
      const field = document.querySelector<HTMLTextAreaElement>("textarea.note-text")!;
      // Past React's record of the value, as typing is.
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, field.value + text);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      type Invoke = (cmd: string, args: object) => Promise<unknown>;
      return (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__.invoke("set_article_note", { id, body, revision });
    },
    [text, body, revision, SNAPSHOT_ID] as const,
  );

test("メモ: typing not yet saved when another window's save comes stays under a warning and saves over nothing, and each button does what it says", async ({
  app,
}) => {
  await open(app, SNAPSHOT_ID);
  await app.getByRole("button", { name: "メモ", exact: true }).click();
  const { panel, note } = memoPanel(app);
  await expect(note).toBeFocused();
  await typedAsAnotherSaves(app, "mine", "theirs", 0);
  const warning = panel.getByRole("alert");
  await expect(warning).toContainText("ほかのウィンドウで保存されました");
  await expect(note).toHaveValue("mine");
  await note.blur();
  expect(await savedBodies(app), "none from this window").toEqual(["theirs"]);
  expect((await stored(app)).note).toBe("theirs");

  await warning.getByRole("button", { name: "ここでの入力で上書き" }).click();
  await expect(warning).toHaveCount(0);
  await expect(note, "the keyboard goes back to the memo").toBeFocused();
  await expect(panel.getByRole("status")).toHaveText("保存しました");
  expect((await callsOf(app, "set_article_note")).at(-1)).toEqual({ id: SNAPSHOT_ID, body: "mine", revision: 1 });
  expect((await stored(app)).note).toBe("mine");

  await typedAsAnotherSaves(app, " again", "theirs again", 2);
  await expect(note).toHaveValue("mine again");
  await warning.getByRole("button", { name: "保存されたメモを読み込む" }).click();
  await expect(note).toHaveValue("theirs again");
  await expect(warning).toHaveCount(0);
  await expect(note).toBeFocused();
  await note.press("Control+End");
  await note.pressSequentially("!");
  await expect.poll(async () => (await stored(app)).note).toBe("theirs again!");
  expect(await savedBodies(app), "this window's typing went where it said").toEqual(["theirs", "mine", "theirs again", "theirs again!"]);
});

test("Vim: a save refused for another window's that landed first comes back under the warning, and keeping it keeps the editor and its undo", async ({
  shell,
}) => {
  await shell.addInitScript(() => {
    localStorage.setItem("lattice.chatVim", "on");
    window.__e2eHold = ["set_article_note"];
  });
  await shell.goto("/");
  await expect(list(shell).locator(".row").first()).toBeVisible({ timeout: 30_000 });
  await open(shell, SNAPSHOT_ID);
  await shell.getByRole("button", { name: "メモ", exact: true }).click();
  const { panel, note } = memoPanel(shell);
  await expect(note).toBeFocused();
  await note.evaluate((el) => void ((el as { first?: boolean }).first = true));
  const sent = async () => (await callsOf(shell, "set_article_note")).length;
  await shell.keyboard.type("mine");
  await expect.poll(sent).toBe(1);
  void invoke(shell, "set_article_note", { id: SNAPSHOT_ID, body: "theirs", revision: 0 });
  await expect.poll(sent).toBe(2);
  // The other window's save lands first.
  await shell.evaluate(() => window.__e2e.release("set_article_note", -1));
  await shell.evaluate(() => window.__e2e.release("set_article_note"));
  const warning = panel.getByRole("alert");
  await expect(warning).toContainText("ほかのウィンドウで保存されました");
  await expect(note).toHaveText("mine");
  expect((await stored(shell)).note).toBe("theirs");

  await warning.getByRole("button", { name: "ここでの入力で上書き" }).click();
  await expect(warning).toHaveCount(0);
  await expect(note).toBeFocused();
  await shell.evaluate(() => window.__e2e.release("set_article_note"));
  await expect.poll(async () => (await stored(shell)).note).toBe("mine");
  expect(await note.evaluate((el) => (el as { first?: boolean }).first), "the same editor").toBe(true);
  await shell.keyboard.press("Escape");
  await shell.keyboard.press("u");
  await expect(note, "with its undo").not.toContainText("mine");
});

test("メモ: a memo cleared to spaces counts as saved, so another window's save then comes in without a warning", async ({ app }) => {
  await open(app, SNAPSHOT_ID);
  await app.getByRole("button", { name: "メモ", exact: true }).click();
  const { panel, note } = memoPanel(app);
  await note.fill("first");
  await expect(panel.getByRole("status")).toHaveText("保存しました");
  await note.fill(" ");
  await expect.poll(async () => (await stored(app)).note_revision).toBe(2);
  await invoke(app, "set_article_note", { id: SNAPSHOT_ID, body: "theirs", revision: 2 });
  await expect(note).toHaveValue("theirs");
  await expect(panel.getByRole("alert")).toHaveCount(0);
});
