// Stickies: asking about a passage in the Reader, and the answer that stays beside it.
import { test, expect, callsOf, list, listRow, navItem, selectWord } from "./harness.ts";
import { ARTICLES, SNAPSHOT_ID } from "./fixtures.ts";
import type { Locator, Page } from "@playwright/test";

// With scrollbars that take width, as in the app: the pane of its default window is too narrow for a column only with one.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

const titleOf = (id: number) => ARTICLES.find((a) => a.id === id)!.title!;
const LONG_ID = ARTICLES[1].id;
const para = (i: number) => `Paragraph ${i} of the long article.`;

async function open(page: Page, id: number) {
  await (await listRow(page, titleOf(id))).click();
  await expect(page.locator(".art-title")).toHaveText(titleOf(id));
  // A font that comes late scrolls the view by a pixel or two.
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

/** The article with blocks of every kind, in the original language. */
async function openSnapshot(page: Page) {
  await open(page, SNAPSHOT_ID);
  await page.locator(".docbar").getByRole("button", { name: "原文", exact: true }).click();
}

/** One article long enough to scroll. `translated` by the sentence. */
async function makeLong(shell: Page, sentences = 1, tail = "", translated = false) {
  await shell.route(/\/fixtures\.ts(\?|$)/, async (route) => {
    const res = await route.fetch();
    const more = `genericBlocks = ((plain) => (a) => (a.id === ${LONG_ID} ? [...plain(a), ...Array.from({ length: 80 }, (_, i) => ['paragraph', Array(${sentences}).fill(\`Paragraph \${i} of the long article.\`).join(' '), ${translated ? "'訳文'" : "null"}]), ${tail}] : plain(a)))(genericBlocks);
      ${translated ? `blocksOf = ((plain) => (a) => plain(a).map((b) => (b.text.startsWith('Paragraph ') ? { ...b, units: Array(${sentences}).fill({ source: /^.*?\\./.exec(b.text)[0], translation: '長い記事の段落の一文。' }) } : b)))(blocksOf);` : ""}`;
    await route.fulfill({ response: res, body: `${await res.text()}\n${more}\n` });
  });
}

/** The app with it open beside the sidebar and the list. */
async function startLong(shell: Page, ...long: [sentences?: number, tail?: string, translated?: boolean]) {
  await makeLong(shell, ...long);
  await shell.goto("/");
  await expect(list(shell).locator(".row").first()).toBeVisible({ timeout: 30_000 });
  await open(shell, LONG_ID);
}

const longPane = (id: number) => ({ kind: "pane", id, tabs: [{ kind: "reader", id: id + 1, articleId: LONG_ID }], active: id + 1 });

const release = (shell: Page, cmd: string) => () => shell.evaluate((cmd) => window.__e2e.release(cmd), cmd);

/** The block of `para(i)`. */
const paraId = (i: number) => LONG_ID * 100 + 5 + i;
const paraBlock = (i: number) => `#b-${paraId(i)}`;
const doc = (page: Page) => page.locator(".doc-scroll");
const scrollTop = (page: Page) => doc(page).evaluate((el) => el.scrollTop);
const scrollTo = (page: Page, block: string, where: ScrollLogicalPosition) => page.locator(block).evaluate((el, block) => el.scrollIntoView({ block }), where);

/** At the size the app's window opens in, which leaves the article a pane too narrow for a column of stickies. */
async function startNarrow(shell: Page, sentences = 1) {
  await shell.setViewportSize({ width: 1200, height: 800 });
  await startLong(shell, sentences);
  await expect(shell.locator(".nav")).toBeVisible();
  await expect(list(shell)).toBeVisible();
  expect(await doc(shell).evaluate((el) => el.clientWidth)).toBeLessThan(720);
}

const bar = (page: Page) => page.locator(".vw-cap");
const cards = (page: Page) => page.locator(".stickies > .sticky");
type Kind = "質問" | "詳しく" | "用語";
const card = (page: Page, kind: Kind | `${Kind}(回答から)`) => page.locator(".stickies").getByRole("region", { name: kind, exact: true });
const field = (page: Page) => page.getByRole("textbox", { name: "選んだ箇所への質問" });
/** One on an answer. */
const child = (page: Page, kind: Kind) => card(page, `${kind}(回答から)`);
const followUp = (page: Page | Locator) => page.getByRole("button", { name: "続けて質問", exact: true });
const followUpField = (page: Page | Locator) => page.getByRole("textbox", { name: "付箋への続きの質問" });
const asked = async (page: Page) =>
  (await callsOf(page, "sticky_ask")) as { blockId: number | null; parent: number | null; kind: string; quote: string; question: string }[];

const ANSWERED = /選んだ箇所の説明です/;

const unfold = (sticky: Locator) => sticky.getByRole("button", { name: "付箋を広げる" }).click();

const boxOf = async (l: Locator) => (await l.boundingBox())!;

const selected = (page: Page) => page.evaluate(() => getSelection()!.toString().trim().replace(/\s+/g, " "));

/** Presses at the first point and drags through the others. */
async function dragTo(page: Page, ...points: [number, number][]) {
  // A press on selected text would drag it.
  await page.evaluate(() => getSelection()!.removeAllRanges());
  await page.mouse.move(...points[0]);
  await page.mouse.down();
  for (const p of points.slice(1)) {
    await page.mouse.move(...p, { steps: 5 });
  }
  await page.mouse.up();
}

/** Drags from the start of `from`'s text to the end of `to`'s, and lets go `beyond` pixels past that. */
async function drag(page: Page, from: string, to: string, beyond = 0) {
  const [start, end] = await page.evaluate(
    (ids) =>
      ids.map((id, i) => {
        const r = document.createRange();
        r.selectNodeContents(document.querySelector(`${id} p, ${id} h1, ${id} h2, ${id} pre, ${id} .li span:last-child`)!);
        const rects = r.getClientRects();
        const box = i ? rects[rects.length - 1] : rects[0];
        return { x: i ? box.right : box.left, y: box.top + box.height / 2 };
      }),
    [from, to],
  );
  await dragTo(page, [start.x + 1, start.y], [end.x - 1, end.y], [end.x - 1 + beyond, end.y]);
}

/** Drags over the text of an answer, and lets go `beyond` pixels below its end. */
async function dragAnswer(page: Page, answer: Locator, beyond = 0) {
  const [start, end] = await answer.evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    const rects = [...r.getClientRects()];
    return [rects[0], rects[rects.length - 1]].map((b, i) => ({ x: i ? b.right - 1 : b.left + 1, y: b.top + b.height / 2 }));
  });
  await dragTo(page, [start.x, start.y], [end.x, end.y], [end.x, end.y + beyond]);
}

/** Asks from the bar over an answer, the whole of it. */
async function askOn(page: Page, kind: Kind, sticky: Locator, nth = 0) {
  await dragAnswer(page, sticky.locator(".answer p").nth(nth));
  await bar(page).getByRole("button", { name: kind, exact: true }).click();
}

/** Selects `same` again, by a Shift+click where it ends. */
async function selectAgain(page: Page, same: string) {
  const end = await page.evaluate(() => {
    const rects = getSelection()!.getRangeAt(0).getClientRects();
    const r = rects[rects.length - 1];
    return { x: r.right - 1, y: r.top + r.height / 2 };
  });
  await page.keyboard.down("Shift");
  await page.mouse.click(end.x, end.y);
  expect(await selected(page)).toBe(same);
  await expect(bar(page)).toBeVisible();
  await page.keyboard.up("Shift");
}

/** Selects from the start of `from` to the end of `to` and lets the mouse go there, without moving it. */
const selectFrom = (page: Page, from: string, to: string) =>
  page.evaluate(
    (ids) => {
      const [start, end] = ids.map((id) => document.querySelector(id)!);
      const r = document.createRange();
      r.setStart(start, 0);
      r.setEnd(end, end.childNodes.length);
      start.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(r);
      end.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    },
    [from, to],
  );

/** Asks from the bar over `block`, a whole paragraph. */
async function askAbout(page: Page, kind: Kind, block: string) {
  await drag(page, block, block);
  await bar(page).getByRole("button", { name: kind, exact: true }).click();
}

/** As another window would: nothing in this one asked. */
const invoke = (page: Page, cmd: string, args: object) =>
  page.evaluate(
    ([cmd, args]) =>
      (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: object) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke(cmd, args),
    [cmd, args] as const,
  );
const askElsewhere = (page: Page, articleId: number, blockId: number | null, quote = "elsewhere", parent: number | null = null) =>
  invoke(page, "sticky_ask", { articleId, blockId, parent, kind: "term", quote, question: "" });

/** `n` more stickies on a block, there as it returns. */
async function askMany(page: Page, articleId: number, blockId: number, n: number) {
  const before = await cards(page).count();
  for (let i = 0; i < n; i++) {
    await askElsewhere(page, articleId, blockId, `card ${i}`);
  }
  await expect(cards(page)).toHaveCount(before + n);
}

/** What an observer, and a scroll, do in the next frame is there too. The harness's clock makes a timer of requestAnimationFrame. */
const frames = (page: Page) =>
  page.evaluate(async () => {
    for (let i = 0; i < 2; i++) {
      await new Promise<void>((done) => {
        const drawn = new IntersectionObserver(() => {
          drawn.disconnect();
          requestAnimationFrame(() => done());
        });
        drawn.observe(document.body);
      });
    }
  });

const hold = (shell: Page, ...cmds: string[]) => shell.addInitScript((cmds) => void (window.__e2eHold = cmds), cmds);
const modelUp = (page: Page) => page.evaluate(() => void ((window as unknown as { __modelUp: boolean }).__modelUp = true));

test("詳しく: a passage over two paragraphs gets an answer beside the first, and no chat hears of it", async ({ shell }) => {
  await hold(shell, "sticky_ask");
  await shell.goto("/");
  await openSnapshot(shell);
  const text = await boxOf(shell.locator("#b-102"));
  await expect(cards(shell)).toHaveCount(0);
  await expect(shell.locator(".stickies")).toBeHidden();

  // Let go in the margin, as a drag over a passage often ends.
  await drag(shell, "#b-102", "#b-103", 60);
  await expect(bar(shell).getByRole("button")).toHaveText(["質問", "詳しく", "用語"]);
  const at = await boxOf(bar(shell));
  expect(at.y).toBeGreaterThan(text.y);
  await bar(shell).getByRole("button", { name: "詳しく" }).click();
  await expect(bar(shell)).toHaveCount(0);

  const detail = card(shell, "詳しく");
  await expect(detail.getByRole("status")).toHaveText("回答を生成しています…");
  await expect(detail.locator(".sticky-quote")).toContainText("Every transaction reads");
  await expect(detail.getByRole("button"), "nothing to delete or cancel while it waits").toHaveCount(0);
  await shell.evaluate(() => window.__e2e.release("sticky_ask"));
  await expect(detail.locator(".answer")).toHaveText(ANSWERED);
  await expect(detail.getByRole("status")).toHaveCount(0);
  await expect(cards(shell)).toHaveCount(1);

  const [call] = await asked(shell);
  expect(call).toMatchObject({ articleId: SNAPSHOT_ID, blockId: 102, kind: "detail", question: "" });
  expect(call.quote.split(/\n+/)).toEqual([
    "Every transaction reads from a consistent snapshot taken when it starts.",
    "PostgreSQL implements it with multi-version concurrency control.",
  ]);
  expect((await callsOf(shell, "chat_ask")).length).toBe(0);
  await expect(shell.locator("[data-pane='chat']")).toHaveCount(0);

  const [beside, block, reader] = [await boxOf(detail), await boxOf(shell.locator("#b-102")), await boxOf(shell.locator(".reader"))];
  expect(Math.abs(beside.y - block.y), "at its block's height").toBeLessThan(1);
  expect(beside.x, "right of the text").toBeGreaterThanOrEqual(reader.x + reader.width);
});

test("用語 asks at once; a word also offers 単語を登録, and code and tables can be asked about", async ({ app }) => {
  await openSnapshot(app);
  await app
    .locator("#b-106")
    .getByText("snapshot", { exact: false })
    .first()
    .dblclick({ position: { x: 10, y: 10 } });
  await expect(bar(app).getByRole("button", { name: /単語を登録/ })).toBeVisible();
  await expect(bar(app).getByRole("button")).toHaveCount(4);
  await bar(app).getByRole("button", { name: "用語" }).click();
  await expect(card(app, "用語").locator(".answer")).toHaveText(ANSWERED);

  await drag(app, "#b-105", "#b-105");
  await bar(app).getByRole("button", { name: "詳しく" }).click();
  await expect(card(app, "詳しく").locator(".answer")).toHaveText(ANSWERED);
  expect((await asked(app)).map((c) => [c.kind, c.blockId])).toEqual([
    ["term", 106],
    ["detail", 105],
  ]);
  expect((await asked(app))[1].quote).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ;");
});

test("質問: the card takes the keyboard, sends with the send key and not while composing, and Esc closes it", async ({ app }) => {
  await openSnapshot(app);
  await askAbout(app, "質問", "#b-102");
  await expect(field(app)).toBeFocused();
  await expect(card(app, "質問").locator(".sticky-quote")).toHaveText("Every transaction reads from a consistent snapshot taken when it starts.");
  // The article's own keys stay out of the field.
  await app.keyboard.type("jk");
  await expect(field(app)).toHaveValue("jk");
  await field(app).dispatchEvent("keydown", { key: "Escape", isComposing: true });
  await expect(field(app)).toBeVisible();
  await app.keyboard.press("Escape");
  await expect(cards(app)).toHaveCount(0);
  await expect(app.locator(".doc-scroll"), "the keyboard is back in the article").toBeFocused();

  await askAbout(app, "質問", "#b-102");
  await card(app, "質問").getByRole("button", { name: "キャンセル" }).click();
  await expect(cards(app)).toHaveCount(0);

  await askAbout(app, "質問", "#b-102");
  await expect(field(app)).toHaveValue("");
  await expect(card(app, "質問").getByRole("button", { name: "送信" })).toBeDisabled();
  await app.keyboard.press("Control+Enter");
  expect(await asked(app), "nothing to send").toEqual([]);
  await field(app).fill("なぜ開始時点なのか？");
  await app.keyboard.press("Enter");
  await expect(field(app), "Enter is a new line by default").toHaveValue("なぜ開始時点なのか？\n");
  await app.keyboard.press("Backspace");
  await field(app).dispatchEvent("keydown", { key: "Enter", ctrlKey: true, isComposing: true });
  expect(await asked(app)).toEqual([]);
  await app.keyboard.press("Control+Enter");
  await expect(card(app, "質問").locator(".answer")).toHaveText(ANSWERED);
  await expect(card(app, "質問").locator(".sticky-q")).toHaveText("なぜ開始時点なのか？");
  await expect(app.locator(".doc-scroll")).toBeFocused();
  expect(await asked(app)).toMatchObject([{ kind: "question", blockId: 102, question: "なぜ開始時点なのか？" }]);
});

test("the question goes on Enter when the send key is Enter", async ({ shell }) => {
  await shell.addInitScript(() => localStorage.setItem("lattice.chatSendKey", "enter"));
  await shell.goto("/");
  await openSnapshot(shell);
  await askAbout(shell, "質問", "#b-102");
  await shell.keyboard.type("a");
  await field(shell).dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await shell.keyboard.press("Shift+Enter");
  await shell.keyboard.type("b");
  expect(await asked(shell)).toEqual([]);
  await shell.keyboard.press("Enter");
  await expect(card(shell, "質問").locator(".answer")).toHaveText(ANSWERED);
  expect((await asked(shell))[0].question).toBe("a\nb");
});

test("a failed question keeps its text through leaving the article, and can be sent again", async ({ app }) => {
  await openSnapshot(app);
  await askAbout(app, "質問", "#b-103");
  await field(app).fill("the model is down?");
  await app.keyboard.press("Control+Enter");
  await expect(card(app, "質問").getByRole("alert")).toHaveText("モデルが空の回答を返しました");
  await expect(field(app)).toHaveValue("the model is down?");

  await open(app, LONG_ID);
  await expect(cards(app)).toHaveCount(0);
  await open(app, SNAPSHOT_ID);
  await expect(card(app, "質問").getByRole("alert")).toBeVisible();
  await expect(field(app)).toHaveValue("the model is down?");
  await expect(field(app), "coming back takes no keyboard").not.toBeFocused();
  await modelUp(app);
  await card(app, "質問").getByRole("button", { name: "再試行" }).click();
  await expect(card(app, "質問").locator(".answer")).toHaveText(ANSWERED);
  await expect(cards(app)).toHaveCount(1);
  await expect(app.getByRole("alert")).toHaveCount(0);
});

test("a question not sent yet keeps its text through another window's sticky and leaving the article", async ({ app }) => {
  await openSnapshot(app);
  await askAbout(app, "質問", "#b-102");
  await field(app).fill("half a question");
  await askElsewhere(app, SNAPSHOT_ID, 103);
  await expect(card(app, "用語")).toBeVisible();
  await expect(field(app)).toHaveValue("half a question");
  await open(app, LONG_ID);
  await expect(cards(app)).toHaveCount(0);
  await open(app, SNAPSHOT_ID);
  await expect(card(app, "用語")).toBeVisible();
  await expect(field(app)).toHaveValue("half a question");
});

test("a card that waits survives leaving the article, and an answer that comes meanwhile is there on return", async ({ shell }) => {
  await hold(shell, "sticky_ask");
  await shell.goto("/");
  await openSnapshot(shell);
  await askAbout(shell, "詳しく", "#b-102");
  await askAbout(shell, "用語", "#b-106");
  await open(shell, LONG_ID);
  await shell.evaluate(() => window.__e2e.release("sticky_ask", 1));
  await open(shell, SNAPSHOT_ID);
  // Folded for the one asked after it.
  await unfold(card(shell, "詳しく"));
  await expect(card(shell, "詳しく").locator(".answer")).toHaveText(ANSWERED);
  await expect(card(shell, "用語").getByRole("status")).toBeVisible();
  await shell.evaluate(() => window.__e2e.release("sticky_ask"));
  await expect(card(shell, "用語").locator(".answer")).toHaveText(ANSWERED);
  await expect(cards(shell)).toHaveCount(2);
});

test("a failed 詳しく says so and is asked again", async ({ shell }) => {
  await shell.addInitScript(() => void (window.__e2eFail = ["sticky_ask"]));
  await shell.goto("/");
  await openSnapshot(shell);
  await askAbout(shell, "詳しく", "#b-102");
  await expect(card(shell, "詳しく").getByRole("alert")).toHaveText(/sticky_ask failed/);
  await shell.evaluate(() => void (window.__e2eFail = []));
  await card(shell, "詳しく").getByRole("button", { name: "再試行" }).click();
  await expect(card(shell, "詳しく").locator(".answer")).toHaveText(ANSWERED);
  await expect(cards(shell)).toHaveCount(1);
});

test("a citation goes to its block; a number without a block of the article that says the same is text", async ({ app }) => {
  await openSnapshot(app);
  await askAbout(app, "詳しく", "#b-103");
  const answer = card(app, "詳しく").locator(".answer");
  await expect(answer).toHaveText(/\[7\].*\[2\].*\[3\]/);
  await expect(answer.getByRole("button")).toHaveText(["1"]);
  await expect(app.locator(".is-cite")).toHaveCount(0);
  await answer.getByRole("button").click();
  await expect(app.locator("#b-103")).toHaveClass(/is-cite/);
  await expect(app.locator("#b-103 .blk-label")).toHaveText("付箋の出典");
  await expect(answer).toBeVisible();
});

test("a sticky is deleted after a confirmation, and the column goes with the last", async ({ app }) => {
  await openSnapshot(app);
  const before = await boxOf(app.locator("#b-102"));
  await askAbout(app, "詳しく", "#b-102");
  await expect(card(app, "詳しく").locator(".answer")).toBeVisible();
  const remove = card(app, "詳しく").getByRole("button", { name: "付箋を削除" });
  const dialog = app.getByRole("alertdialog", { name: "付箋を削除しますか？" });
  for (const cancel of [() => dialog.getByRole("button", { name: "キャンセル" }).click(), () => app.keyboard.press("Escape")]) {
    await remove.click();
    await expect(dialog).toBeVisible();
    await cancel();
    await expect(dialog).toBeHidden();
    await expect(remove).toBeFocused();
  }
  await expect(cards(app)).toHaveCount(1);
  expect(await callsOf(app, "delete_sticky")).toEqual([]);
  await app.keyboard.press("Enter");
  await dialog.getByRole("button", { name: "削除" }).click();
  await expect(app.locator(".stickies")).toBeHidden();
  await expect(app.locator(".doc-scroll")).toBeFocused();
  expect(await callsOf(app, "delete_sticky")).toEqual([{ id: 1 }]);
  expect(await boxOf(app.locator("#b-102"))).toEqual(before);
  await open(app, LONG_ID);
  await open(app, SNAPSHOT_ID);
  await expect(app.locator(".stickies")).toBeHidden();
});

test("a sticky that cannot be deleted stays and says why", async ({ app }) => {
  await openSnapshot(app);
  await askAbout(app, "詳しく", "#b-102");
  await expect(card(app, "詳しく").locator(".answer")).toBeVisible();
  await app.evaluate(() => void (window.__e2eFail = ["delete_sticky"]));
  await card(app, "詳しく").getByRole("button", { name: "付箋を削除" }).click();
  await app.getByRole("alertdialog").getByRole("button", { name: "削除" }).click();
  await expect(card(app, "詳しく").getByRole("alert")).toHaveText(/delete_sticky failed/);
  await expect(card(app, "詳しく").locator(".answer")).toBeVisible();
});

test("a sticky asked or deleted in another window shows here", async ({ app }) => {
  await openSnapshot(app);
  const reads = async () => (await callsOf(app, "list_stickies")).length;
  const before = await reads();
  await askElsewhere(app, LONG_ID, null);
  await askElsewhere(app, SNAPSHOT_ID, 103);
  await expect(card(app, "用語").locator(".sticky-quote")).toHaveText("elsewhere");
  expect(await reads(), "another article's is none of this one's").toBe(before + 1);
  await invoke(app, "delete_sticky", { id: 2 });
  await expect(app.locator(".stickies")).toBeHidden();
});

test("an answer that the list has before it comes is one card", async ({ shell }) => {
  await shell.addInitScript(() => void (window.__e2eLate = ["sticky_ask"]));
  await shell.goto("/");
  await openSnapshot(shell);
  await askAbout(shell, "用語", "#b-102");
  await expect(card(shell, "用語").locator(".answer")).toHaveCount(1);
  await shell.evaluate(() => window.__e2e.release("sticky_ask"));
  await expect(card(shell, "用語").getByRole("status")).toHaveCount(0);
  await expect(cards(shell)).toHaveCount(1);
});

test("a follow-up's answer that comes after a list with another window's later one leaves that one there", async ({ shell }) => {
  await shell.addInitScript(() => void (window.__e2eLate = ["sticky_follow_up"]));
  await shell.goto("/");
  await openSnapshot(shell);
  await askElsewhere(shell, SNAPSHOT_ID, 102);
  await followUp(shell).click();
  await followUpField(shell).fill("here");
  await shell.keyboard.press("Control+Enter");
  void invoke(shell, "sticky_follow_up", { id: 1, question: "elsewhere" });
  await expect(cards(shell).locator(".answer")).toHaveCount(3);
  await shell.evaluate(() => window.__e2e.release("sticky_follow_up", 1));
  await expect(cards(shell).getByRole("status")).toHaveCount(0);
  await frames(shell);
  await expect(cards(shell).locator(".answer")).toHaveCount(3);
  await expect(cards(shell).locator(".sticky-q")).toHaveText(["here", "elsewhere"]);
  await shell.evaluate(() => window.__e2e.release("sticky_follow_up"));
});

test("a follow-up's answer that comes late goes to its own sticky, not to another with more answers", async ({ shell }) => {
  await shell.addInitScript(() => void (window.__e2eLate = ["sticky_follow_up"]));
  await shell.goto("/");
  await openSnapshot(shell);
  await askElsewhere(shell, SNAPSHOT_ID, 102, "first");
  await askElsewhere(shell, SNAPSHOT_ID, 103, "second");
  void invoke(shell, "sticky_follow_up", { id: 1, question: "one" });
  void invoke(shell, "sticky_follow_up", { id: 1, question: "two" });
  await expect(cards(shell).first().locator(".answer")).toHaveCount(3);
  await followUp(cards(shell).nth(1)).click();
  await followUpField(shell).fill("here");
  await shell.keyboard.press("Control+Enter");
  await expect(cards(shell).nth(1).getByRole("status")).toHaveCount(1);
  await shell.evaluate(() => window.__e2e.release("sticky_follow_up", -1));
  await expect(cards(shell).getByRole("status")).toHaveCount(0);
  await frames(shell);
  await expect(cards(shell).locator(".sticky-quote")).toHaveText(["first", "second"]);
  await expect(cards(shell).nth(1).locator(".sticky-q")).toHaveText(["here"]);
  await shell.evaluate(() => window.__e2e.release("sticky_follow_up"));
});

test("a sticky saved under the id of one deleted elsewhere shows as itself before the list after the deletion comes", async ({ shell }) => {
  await shell.addInitScript(() => {
    window.__e2eHold = ["sticky_ask"];
    window.__e2eLate = ["list_stickies"];
  });
  const go = (cmd: string) => shell.evaluate((cmd) => window.__e2e.release(cmd), cmd);
  const reads = async () => (await callsOf(shell, "list_stickies")).length;
  await shell.goto("/");
  await openSnapshot(shell);
  await expect.poll(reads).toBeGreaterThan(0);
  await go("list_stickies");
  // Another window's sticky, with a follow-up: one more answer than a new sticky has.
  const made = askElsewhere(shell, SNAPSHOT_ID, 102);
  await expect.poll(async () => (await callsOf(shell, "sticky_ask")).length).toBe(1);
  await go("sticky_ask");
  await made;
  await invoke(shell, "sticky_follow_up", { id: 1, question: "elsewhere" });
  await expect.poll(reads).toBeGreaterThan(2);
  await go("list_stickies");
  await expect(cards(shell).locator(".answer")).toHaveCount(2);
  await askAbout(shell, "詳しく", "#b-103");
  await expect(cards(shell)).toHaveCount(2);
  // Deleted there as this one waits, which then gets its id.
  await invoke(shell, "delete_sticky", { id: 1 });
  await go("sticky_ask");
  await expect(shell.locator(".stickies").getByRole("status")).toHaveCount(0);
  await expect(cards(shell)).toHaveCount(1);
  await expect(card(shell, "詳しく").locator(".answer")).toHaveCount(1);
  await go("list_stickies");
  await frames(shell);
  await expect(cards(shell)).toHaveCount(1);
  await expect(card(shell, "詳しく").locator(".answer")).toHaveCount(1);
});

test("a list read before a sticky was asked does not take it away by coming last", async ({ shell }) => {
  await shell.addInitScript(() => void (window.__e2eLate = ["list_stickies"]));
  await shell.goto("/");
  await openSnapshot(shell);
  const reads = async () => (await callsOf(shell, "list_stickies")).length;
  const before = await reads();
  expect(before).toBeGreaterThan(0);
  await askElsewhere(shell, SNAPSHOT_ID, 103);
  await expect.poll(reads).toBe(before + 1);
  await shell.evaluate(() => window.__e2e.release("list_stickies", -1));
  await expect(cards(shell)).toHaveCount(1);
  await shell.evaluate(() => window.__e2e.release("list_stickies"));
  await frames(shell);
  await expect(cards(shell)).toHaveCount(1);
});

test("stickies that cannot be read say so", async ({ shell }) => {
  await shell.addInitScript(() => void (window.__e2eFail = ["list_stickies"]));
  await shell.goto("/");
  await openSnapshot(shell);
  await expect(shell.locator(".stickies").getByRole("alert")).toHaveText(/付箋を読み込めませんでした.*list_stickies failed/);
  await shell.evaluate(() => void (window.__e2eFail = []));
  await askElsewhere(shell, SNAPSHOT_ID, 103);
  await expect(card(shell, "用語")).toBeVisible();
  await expect(shell.locator(".stickies").getByRole("alert")).toHaveCount(0);
});

test("stickies that cannot be read again stay", async ({ app }) => {
  await openSnapshot(app);
  await askElsewhere(app, SNAPSHOT_ID, 103);
  await expect(card(app, "用語")).toBeVisible();
  await app.evaluate(() => void (window.__e2eFail = ["list_stickies"]));
  await askElsewhere(app, SNAPSHOT_ID, 103);
  await expect(app.locator(".stickies").getByRole("alert")).toBeVisible();
  await expect(card(app, "用語")).toBeVisible();
});

test("cards on one block do not cover each other, those without a block come first, and all follow the text as it grows", async ({ app }) => {
  await openSnapshot(app);
  await askElsewhere(app, SNAPSHOT_ID, 103, "second");
  await askElsewhere(app, SNAPSHOT_ID, 103, "third");
  await askElsewhere(app, SNAPSHOT_ID, 107, "last");
  await askElsewhere(app, SNAPSHOT_ID, null, "first");
  await expect(app.locator(".sticky-quote")).toHaveText(["first", "second", "third", "last"]);
  const boxes = async () => Promise.all([0, 1, 2, 3].map((i) => boxOf(cards(app).nth(i))));
  const apart = async () => {
    const b = await boxes();
    return b.slice(1).every((x, i) => x.y >= b[i].y + b[i].height);
  };
  expect(await apart()).toBe(true);
  // Its block is far enough down that nothing pushes it.
  const followed = async (nth: number, block: string) => Math.abs((await boxOf(cards(app).nth(nth))).y - (await boxOf(app.locator(block))).y) < 1;
  await app.locator("#b-102").evaluate((el) => ((el as HTMLElement).style.marginBottom = "400px"));
  await expect.poll(() => followed(1, "#b-103")).toBe(true);
  await app.locator("#b-106").evaluate((el) => ((el as HTMLElement).style.paddingBottom = "900px"));
  await expect.poll(() => followed(3, "#b-107")).toBe(true);
  expect(await apart()).toBe(true);
  // A card that grows pushes the ones below.
  await cards(app)
    .nth(1)
    .evaluate((el) => ((el as HTMLElement).style.height = "700px"));
  await expect.poll(apart).toBe(true);
});

test("the card just asked is at its block's height, and stays there with its answer, until another is", async ({ shell }) => {
  await hold(shell, "sticky_ask");
  await shell.setViewportSize({ width: 1500, height: 900 });
  await startLong(shell);
  // Six cards on one block: down the column past the blocks that follow.
  for (let i = 0; i < 6; i++) {
    void askElsewhere(shell, LONG_ID, paraId(30), `card ${i}`);
  }
  await expect.poll(async () => (await asked(shell)).length).toBe(6);
  await shell.evaluate(() => window.__e2e.release("sticky_ask", 6));
  await expect(cards(shell)).toHaveCount(6);
  const off = async (nth: number, block: string) => (await boxOf(cards(shell).nth(nth))).y - (await boxOf(shell.locator(block))).y;
  const apart = async () => {
    const all = await Promise.all((await cards(shell).all()).map(boxOf));
    const column = await boxOf(shell.locator(".art-meta"));
    return all[0].y >= column.y - 1 && all.slice(1).every((x, i) => x.y >= all[i].y + all[i].height);
  };

  await scrollTo(shell, paraBlock(32), "center");
  const top = await scrollTop(shell);
  await askAbout(shell, "詳しく", paraBlock(32));
  expect(Math.abs(await off(6, paraBlock(32)))).toBeLessThan(1);
  expect(await scrollTop(shell), "the passage stays where it was").toBe(top);
  expect(await apart()).toBe(true);
  await shell.evaluate(() => window.__e2e.release("sticky_ask"));
  await expect(card(shell, "詳しく").locator(".answer")).toHaveText(ANSWERED);
  expect(Math.abs(await off(6, paraBlock(32)))).toBeLessThan(1);
  expect(await scrollTop(shell)).toBe(top);

  // The next one takes the place.
  await askAbout(shell, "質問", paraBlock(33));
  expect(Math.abs(await off(7, paraBlock(33)))).toBeLessThan(1);
  await expect(cards(shell).nth(6)).toHaveAttribute("data-folded");
  expect(await apart()).toBe(true);
  expect(await scrollTop(shell)).toBe(top);
  await shell.keyboard.press("Escape");
  await expect(cards(shell)).toHaveCount(7);
  expect(await off(6, paraBlock(32)), "below the six again").toBeGreaterThan(100);
  // A Reader that did not ask has them in order.
  await open(shell, SNAPSHOT_ID);
  await open(shell, LONG_ID);
  await expect(cards(shell)).toHaveCount(7);
  expect(await off(0, paraBlock(30))).toBeCloseTo(0, 0);
});

test("the column goes on below a short article, and scrolls with it", async ({ app }) => {
  await app.setViewportSize({ width: 1440, height: 1100 });
  await openSnapshot(app);
  await askMany(app, SNAPSHOT_ID, 107, 1);
  const width = () => doc(app).evaluate((el) => el.clientWidth);
  const scrolls = () => doc(app).evaluate((el) => el.scrollHeight > el.clientHeight);
  const [before, fits] = [await width(), !(await scrolls())];
  await askMany(app, SNAPSHOT_ID, 107, 7);
  expect([fits, await scrolls()]).toEqual([true, true]);
  expect(await width(), "the scrollbar that comes takes none").toBe(before);
  await doc(app).evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect(cards(app).last()).toBeInViewport({ ratio: 1 });
  const [last, view] = [await boxOf(cards(app).last()), await boxOf(doc(app))];
  expect(view.y + view.height - (last.y + last.height), "room under the last").toBeGreaterThan(35);
});

test("in a narrow pane a card is right under its passage, and neither asking nor the answer moves the text above it", async ({ shell }) => {
  await hold(shell, "sticky_ask");
  await startNarrow(shell);
  const [block, next] = [shell.locator(paraBlock(40)), shell.locator(paraBlock(41))];
  await scrollTo(shell, paraBlock(40), "center");
  const [top, at, below] = [await scrollTop(shell), await boxOf(block), await boxOf(next)];
  const between = below.y - (at.y + at.height);

  await askAbout(shell, "質問", paraBlock(40));
  await expect(field(shell)).toBeFocused();
  const under = async () => {
    const [c, b, n] = [await boxOf(cards(shell).first()), await boxOf(block), await boxOf(next)];
    expect(b, "the passage stays where it was").toEqual(at);
    expect(c.y - (b.y + b.height)).toBeCloseTo(10, 0);
    expect(n.y - (c.y + c.height), "the text below gives way").toBeCloseTo(between, 0);
    return c.height;
  };
  await under();
  await shell.keyboard.press("Escape");
  await expect(cards(shell)).toHaveCount(0);
  expect(await boxOf(next)).toEqual(below);
  expect(await scrollTop(shell)).toBe(top);

  await askAbout(shell, "詳しく", paraBlock(40));
  const waiting = await under();
  await shell.evaluate(() => window.__e2e.release("sticky_ask"));
  await expect(card(shell, "詳しく").locator(".answer")).toHaveText(ANSWERED);
  expect(await under()).toBeGreaterThan(waiting);
  expect(await scrollTop(shell)).toBe(top);
  await open(shell, SNAPSHOT_ID);
  await open(shell, LONG_ID);
  await expect.poll(() => scrollTop(shell)).toBe(top);
  await under();
});

test("in a narrow pane a card that comes under the paragraph at the top of the view moves no text, whichever its line there", async ({ shell }) => {
  test.slow();
  await startNarrow(shell, 12);
  await askElsewhere(shell, LONG_ID, paraId(50));
  await expect(cards(shell)).toHaveCount(1);
  await scrollTo(shell, paraBlock(40), "start");
  const moved = await doc(shell).evaluate(
    async (el, [article, block]) => {
      type Invoke = (cmd: string, args: object) => Promise<{ id: number }>;
      const { invoke } = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__;
      const column = el.querySelector(".stickies")!;
      const come = async (n: number) => {
        while (column.children.length !== n) {
          await new Promise((done) => setTimeout(done));
        }
      };
      const p = el.querySelector(`#b-${block}`)!;
      const start = el.scrollTop;
      const moved: [number, number][] = [];
      for (let px = 1; px <= 150; px++) {
        el.scrollTop = start + px;
        await new Promise((done) => requestAnimationFrame(done));
        const y = p.getBoundingClientRect().top;
        const { id } = await invoke("sticky_ask", { articleId: article, blockId: block, parent: null, kind: "term", quote: "q", question: "" });
        await come(2);
        const by = p.getBoundingClientRect().top - y;
        if (Math.abs(by) >= 1) {
          moved.push([px, by]);
        }
        await invoke("delete_sticky", { id });
        await come(1);
      }
      return moved;
    },
    [LONG_ID, paraId(40)],
  );
  expect(moved).toEqual([]);
});

test("in a narrow pane a card that opens at the bottom of the view moves the text no further than shows the card", async ({ shell }) => {
  await startNarrow(shell);
  await scrollTo(shell, paraBlock(40), "end");
  // A drag at the view's edge scrolls it by itself.
  await drag(shell, paraBlock(40), paraBlock(40));
  const ask = bar(shell).getByRole("button", { name: "質問", exact: true });
  await expect(ask).toBeVisible();
  const top = await scrollTop(shell);
  await ask.click();
  await expect(field(shell)).toBeInViewport({ ratio: 1 });
  const [c, view] = [await boxOf(cards(shell).first()), await boxOf(doc(shell))];
  expect(c.y + c.height).toBeCloseTo(view.y + view.height, 0);
  expect((await scrollTop(shell)) - top).toBeLessThan(c.height + 20);
  await expect(shell.locator(paraBlock(40))).toBeInViewport();
  // Closed, it gives the view back where it was, unless the reader has gone on.
  await shell.keyboard.press("Escape");
  await expect(cards(shell)).toHaveCount(0);
  expect(await scrollTop(shell)).toBe(top);
  await askAbout(shell, "質問", paraBlock(40));
  await expect(field(shell)).toBeInViewport({ ratio: 1 });
  const opened = await scrollTop(shell);
  await doc(shell).evaluate((el) => (el.scrollTop += 30));
  // The scroll event comes with the next frame, as it does before a reader's next key.
  await frames(shell);
  await field(shell).press("Escape");
  await expect(cards(shell)).toHaveCount(0);
  expect(await scrollTop(shell)).toBe(opened + 30);
});

test("a scroll of a few pixels is kept as a card changes", async ({ shell }) => {
  await startNarrow(shell);
  await scrollTo(shell, paraBlock(40), "center");
  await askAbout(shell, "質問", paraBlock(40));
  await expect(field(shell)).toBeFocused();
  for (const px of [1, 3, 7, 20]) {
    await doc(shell).evaluate((el, px) => (el.scrollTop += px), px);
    await frames(shell);
    const top = await scrollTop(shell);
    await shell.keyboard.type("x");
    await frames(shell);
    expect(await scrollTop(shell), `${px}`).toBe(top);
  }
});

test("a scroll of a few pixels up from the article's end is kept as a card changes", async ({ shell }) => {
  await startNarrow(shell);
  await scrollTo(shell, paraBlock(78), "center");
  await askAbout(shell, "質問", paraBlock(78));
  await expect(field(shell)).toBeFocused();
  for (const px of [3, 15, 40]) {
    await doc(shell).evaluate((el) => (el.scrollTop = el.scrollHeight));
    await frames(shell);
    await shell.keyboard.type("x");
    await frames(shell);
    await doc(shell).evaluate((el, px) => (el.scrollTop -= px), px);
    await frames(shell);
    const top = await scrollTop(shell);
    await shell.keyboard.type("x");
    await frames(shell);
    expect(await scrollTop(shell), `${px}`).toBe(top);
  }
});

test("a slow scroll on a screen of 150% is kept as a card comes", async ({ playwright }) => {
  // The screen's own scale, not an emulated one: there a scroll goes on by parts of a pixel.
  const browser = await playwright.chromium.launch({ args: ["--force-device-scale-factor=1.5", "--window-size=1440,900"] });
  const page = await browser.newPage({ viewport: null, deviceScaleFactor: undefined, isMobile: undefined, hasTouch: undefined });
  await startLong(page, 8);
  await askElsewhere(page, LONG_ID, paraId(2));
  await expect(cards(page)).toHaveCount(1);
  await scrollTo(page, paraBlock(40), "start");
  await frames(page);
  const from = await scrollTop(page);
  for (let i = 0; i < 60; i++) {
    await doc(page).evaluate((el) => (el.scrollTop += 1 / devicePixelRatio));
    await frames(page);
  }
  const top = await scrollTop(page);
  expect(Math.abs(top - from - 40)).toBeLessThan(2);
  await askElsewhere(page, LONG_ID, paraId(45));
  await expect(cards(page)).toHaveCount(2);
  await frames(page);
  expect(Math.abs((await scrollTop(page)) - top)).toBeLessThan(2);
  await browser.close();
});

test("a paragraph at the top of the view that grows below there moves no text", async ({ shell }) => {
  await startNarrow(shell, 40);
  await askElsewhere(shell, LONG_ID, paraId(40));
  await expect(cards(shell)).toHaveCount(1);
  await scrollTo(shell, paraBlock(40), "start");
  await doc(shell).evaluate((el) => (el.scrollTop += 350));
  await frames(shell);
  const top = await scrollTop(shell);
  // By a part of a line, a line and some.
  for (const px of [20, 51, 151]) {
    await shell.locator(paraBlock(40)).evaluate((el, px) => (el.style.paddingBottom = `${px}px`), px);
    await frames(shell);
    expect(await scrollTop(shell), `${px}`).toBe(top);
  }
});

test("closing a card that is not the one opened last moves no text", async ({ shell }) => {
  await startNarrow(shell);
  await scrollTo(shell, paraBlock(40), "center");
  await askAbout(shell, "質問", paraBlock(40));
  await expect(field(shell)).toHaveCount(1);
  await scrollTo(shell, paraBlock(44), "end");
  const top = await scrollTop(shell);
  await askAbout(shell, "質問", paraBlock(44));
  await expect(field(shell)).toHaveCount(2);
  expect(await scrollTop(shell)).toBeGreaterThan(top + 50);
  await expect(cards(shell).first()).toBeInViewport();
  const y = async () => (await boxOf(shell.locator(paraBlock(39)))).y;
  const before = await y();
  await cards(shell)
    .first()
    .getByRole("button", { name: "キャンセル" })
    .evaluate((el: HTMLElement) => el.click());
  await expect(cards(shell)).toHaveCount(1);
  expect(Math.abs((await y()) - before)).toBeLessThan(2);
});

test("the line being read stays at the top of the view through a narrow pane and a wide one, however often", async ({ shell }) => {
  await shell.setViewportSize({ width: 1200, height: 800 });
  await startLong(shell, 12);
  for (const block of [null, paraId(10), paraId(40), paraId(50)]) {
    await askElsewhere(shell, LONG_ID, block);
  }
  await expect(cards(shell)).toHaveCount(4);
  const column = shell.locator(".stickies[data-beside]");
  await expect(column).toHaveCount(0);
  const passed = async (block: string) => {
    const [b, view] = [await boxOf(shell.locator(block)), await boxOf(doc(shell))];
    return (view.y - b.y) / b.height;
  };
  // From one place, and then from where the reader goes on.
  for (const block of [paraBlock(40), paraBlock(30)]) {
    await scrollTo(shell, block, "start");
    await doc(shell).evaluate((el) => {
      el.scrollTop += 100;
      return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    });
    const before = await passed(block);
    expect(before).toBeGreaterThan(0.3);
    for (let i = 0; i < 3; i++) {
      await shell.setViewportSize({ width: 1900, height: 800 });
      await expect(column).toHaveCount(1);
      await expect.poll(async () => Math.abs((await passed(block)) - before)).toBeLessThan(0.02);
      await shell.setViewportSize({ width: 1200, height: 800 });
      await expect(column).toHaveCount(0);
      await expect.poll(async () => Math.abs((await passed(block)) - before)).toBeLessThan(0.01);
    }
  }
  // A jump as the pane changes is where the reader asked to go.
  await shell.locator(paraBlock(60)).evaluate((el) => {
    document.querySelector<HTMLElement>(".list")!.style.display = "none";
    el.scrollIntoView({ block: "start" });
  });
  await expect(column).toHaveCount(1);
  await expect.poll(() => passed(paraBlock(60))).toBeCloseTo(0, 1);
});

test("the line being read stays at the top of the view as a border is dragged there and back, a little at a time", async ({ shell }) => {
  await shell.setViewportSize({ width: 1200, height: 800 });
  await startLong(shell, 4);
  for (const block of [null, paraId(10), paraId(12), paraId(40), paraId(41), paraId(50)]) {
    await askElsewhere(shell, LONG_ID, block);
  }
  await expect(cards(shell)).toHaveCount(6);
  await scrollTo(shell, paraBlock(45), "start");
  await doc(shell).evaluate((el) => (el.scrollTop += 33));
  await frames(shell);
  const passed = async () => (await boxOf(doc(shell))).y - (await boxOf(shell.locator(paraBlock(45)))).y;
  const before = await passed();
  const border = await boxOf(shell.locator(".splitter.at-list"));
  const [x, y] = [border.x + border.width / 2, border.y + 300];
  await shell.mouse.move(x, y);
  await shell.mouse.down();
  for (let i = 1; i <= 80; i++) {
    const step = i % 40;
    await shell.mouse.move(x - 5 * Math.min(step, 40 - step), y);
    await frames(shell);
  }
  await shell.mouse.up();
  expect(Math.abs((await passed()) - before)).toBeLessThan(1);
});

test("the line being read stays at the top of the view as a pane changes by parts of a pixel, as beside another", async ({ shell }) => {
  await shell.setViewportSize({ width: 1240, height: 800 });
  // A line more every few pixels.
  await startLong(shell, 1, "...Array.from({ length: 5 }, () => ['paragraph', Array.from({ length: 600 }, (_, j) => 'w' + j).join(' '), null])");
  for (const block of [paraId(5), paraId(50)]) {
    await askElsewhere(shell, LONG_ID, block);
  }
  await expect(cards(shell)).toHaveCount(2);
  await scrollTo(shell, paraBlock(81), "start");
  await doc(shell).evaluate((el) => (el.scrollTop += 900));
  await frames(shell);
  const passed = async () => (await boxOf(doc(shell))).y - (await boxOf(shell.locator(paraBlock(81)))).y;
  const before = await passed();
  const listAt = (px: number) => shell.evaluate((px) => document.querySelector<HTMLElement>(".app")!.style.setProperty("--list-w", `${px}px`), px);
  const { width } = await boxOf(list(shell));
  for (let i = 0; i <= 160; i++) {
    await listAt(width + 0.3 * i);
    await frames(shell);
  }
  for (let i = 4; i >= 0; i--) {
    await listAt(width + 12 * i);
    await frames(shell);
  }
  expect(Math.abs((await passed()) - before)).toBeLessThan(1);
});

for (const article of ["with stickies", "without"] as const) {
  test(`a scroll that goes on as the pane's width changes goes on from the line being read (an article ${article})`, async ({ shell }) => {
    await startNarrow(shell, 40);
    if (article === "with stickies") {
      for (const block of [paraId(10), paraId(50)]) {
        await askElsewhere(shell, LONG_ID, block);
      }
      await expect(cards(shell)).toHaveCount(2);
    }
    const listAt = (px: number) => shell.evaluate((px) => document.querySelector<HTMLElement>(".app")!.style.setProperty("--list-w", `${px}px`), px);
    const { width } = await boxOf(list(shell));
    // Within the narrow layout, into the wide one and back.
    for (const to of [width - 40, width + 30, width - 220]) {
      for (const by of [2, 14, 100, -100]) {
        await listAt(width);
        await scrollTo(shell, paraBlock(40), "start");
        await doc(shell).evaluate((el) => (el.scrollTop += 300));
        await frames(shell);
        for (const [first, px] of [
          ["scroll", to],
          ["width", width],
        ] as const) {
          const over = async () => {
            const [b, view] = [await boxOf(shell.locator(paraBlock(40))), await boxOf(doc(shell))];
            return { above: view.y - b.y, height: b.height };
          };
          const was = await over();
          await doc(shell).evaluate(
            (el, [first, by, px]) => {
              const steps = [() => (el.scrollTop += by), () => document.querySelector<HTMLElement>(".app")!.style.setProperty("--list-w", `${px}px`)];
              for (const step of first === "scroll" ? steps : steps.toReversed()) {
                step();
              }
            },
            [first, by, px] as const,
          );
          await frames(shell);
          const is = await over();
          // The browser keeps the paragraph's top, and this the share of it that is above the view.
          const expected = article === "without" ? was.above : (was.above / was.height) * is.height;
          expect(Math.abs(is.above - expected - by), `${first} first, by ${by}, to ${px}`).toBeLessThan(1);
        }
      }
    }
  });
}

test("a scroll of up to a view as the pane's width changes goes on from the line being read, and a longer one is a jump to a place of the new width", async ({
  shell,
}) => {
  test.setTimeout(90_000);
  await startNarrow(shell, 40);
  for (const block of [paraId(10), paraId(50)]) {
    await askElsewhere(shell, LONG_ID, block);
  }
  await expect(cards(shell)).toHaveCount(2);
  const view = await doc(shell).evaluate((el) => el.clientHeight);
  const { width } = await boxOf(list(shell));
  /** Scrolls in the frame of the change. The paragraph at the top of the view there, before and after the scroll, and where they are after the frame. */
  const run = async (from: number, to: number, by: number) => {
    await shell.evaluate((px) => document.querySelector<HTMLElement>(".app")!.style.setProperty("--list-w", `${px}px`), from);
    await frames(shell);
    await scrollTo(shell, paraBlock(40), "start");
    await doc(shell).evaluate((el) => (el.scrollTop += 300));
    await frames(shell);
    const lines = await doc(shell).evaluate(
      (el, [px, by]) => {
        const line = () => {
          const top = el.getBoundingClientRect().top;
          const b = [...el.querySelectorAll(".blk")].find((b) => b.getBoundingClientRect().bottom > top)!;
          const r = b.getBoundingClientRect();
          return { block: `#${b.id}`, share: (top - r.top) / r.height };
        };
        const before = line();
        document.querySelector<HTMLElement>(".app")!.style.setProperty("--list-w", `${px}px`);
        el.scrollTop += by;
        return [before, line()];
      },
      [to, by] as const,
    );
    await frames(shell);
    const [goneOn, jumped] = await Promise.all(
      lines.map(async ({ block, share }) => {
        const [b, v] = [await boxOf(shell.locator(block)), await boxOf(doc(shell))];
        return v.y - b.y - share * b.height;
      }),
    );
    return { goneOn, jumped };
  };
  for (const [from, to] of [
    [width, width - 40],
    [width, width - 220],
    [width - 220, width],
  ]) {
    for (const by of [500, -500, view - 20, 20 - view]) {
      expect(Math.abs((await run(from, to, by)).goneOn - by), `${by} px from ${from} to ${to}`).toBeLessThan(2);
    }
    for (const by of [view + 20, -view - 20, -3 * view]) {
      expect(Math.abs((await run(from, to, by)).jumped), `${by} px from ${from} to ${to}`).toBeLessThan(2);
    }
  }
});

test("the line being read stays at the top of the view of an article translated by the sentence, at any width", async ({ shell }) => {
  await shell.setViewportSize({ width: 1200, height: 800 });
  await startLong(shell, 12, "", true);
  await expect(shell.locator(`${paraBlock(40)} .sent`)).toHaveCount(12);
  for (const block of [paraId(10), paraId(50)]) {
    await askElsewhere(shell, LONG_ID, block);
  }
  await expect(cards(shell)).toHaveCount(2);
  await scrollTo(shell, paraBlock(40), "start");
  await doc(shell).evaluate((el) => (el.scrollTop += 70));
  await frames(shell);
  const top = await scrollTop(shell);
  for (const width of [1260, 1330, 1900, 1400, 1200]) {
    await shell.setViewportSize({ width, height: 800 });
    await frames(shell);
    const [b, view] = [await boxOf(shell.locator(paraBlock(40))), await boxOf(doc(shell))];
    expect(b.y, `${width}`).toBeLessThan(view.y);
    expect(b.y + b.height, `${width}`).toBeGreaterThan(view.y);
  }
  expect(Math.abs((await scrollTop(shell)) - top)).toBeLessThan(1);
});

for (const translated of [false, true]) {
  test(`the line being read stays at the top of the view as a panel comes beside the article and goes (${translated ? "translated by the sentence" : "original"})`, async ({
    shell,
  }) => {
    await shell.setViewportSize({ width: 1600, height: 800 });
    await startLong(shell, 12, "", translated);
    for (const block of [paraId(10), paraId(50)]) {
      await askElsewhere(shell, LONG_ID, block);
    }
    await expect(cards(shell)).toHaveCount(2);
    await scrollTo(shell, paraBlock(40), "start");
    await doc(shell).evaluate((el) => (el.scrollTop += 70));
    await frames(shell);
    const [top, width] = [await scrollTop(shell), (await boxOf(doc(shell))).width];
    const share = async () => {
      const [b, view] = [await boxOf(shell.locator(paraBlock(40))), await boxOf(doc(shell))];
      return (view.y - b.y) / b.height;
    };
    const before = await share();
    const note = shell.locator(".docbar").getByRole("button", { name: "メモ", exact: true });
    for (let i = 0; i < 2; i++) {
      await note.click();
      await expect.poll(async () => (await boxOf(doc(shell))).width).toBeLessThan(width);
      await frames(shell);
      expect(Math.abs((await share()) - before)).toBeLessThan(0.01);
      await note.click();
      await expect.poll(async () => (await boxOf(doc(shell))).width).toBe(width);
      await frames(shell);
      expect(Math.abs((await scrollTop(shell)) - top)).toBeLessThan(1);
    }
  });
}

test("the line being read in a last paragraph taller than the view stays at its top", async ({ shell }) => {
  await shell.setViewportSize({ width: 1200, height: 800 });
  await startLong(shell, 1, "['paragraph', Array.from({ length: 1500 }, (_, i) => `w${i}`).join(' '), null]");
  await askElsewhere(shell, LONG_ID, paraId(50));
  await expect(cards(shell)).toHaveCount(1);
  await scrollTo(shell, paraBlock(80), "start");
  await doc(shell).evaluate((el) => (el.scrollTop += 700));
  await frames(shell);
  const passed = async () => {
    const [b, view] = [await boxOf(shell.locator(paraBlock(80))), await boxOf(doc(shell))];
    return (view.y - b.y) / b.height;
  };
  const before = await passed();
  await shell.setViewportSize({ width: 1330, height: 800 });
  await frames(shell);
  expect(Math.abs((await passed()) - before)).toBeLessThan(0.005);
});

test("a view in the header stays there through a narrow pane and a wide one", async ({ shell }) => {
  await shell.setViewportSize({ width: 1500, height: 800 });
  await startLong(shell);
  // One that a narrow pane breaks into more lines.
  await shell.locator(".art-title").evaluate((el) => (el.textContent += " — " + "a longer title ".repeat(6)));
  await askElsewhere(shell, LONG_ID, paraId(3));
  await expect(cards(shell)).toHaveCount(1);
  const passed = async () => {
    const [title, view] = [await boxOf(shell.locator(".art-title")), await boxOf(doc(shell))];
    return (view.y - title.y) / title.height;
  };
  for (const top of [0, 30, 60, 120]) {
    await doc(shell).evaluate((el, top) => (el.scrollTop = top), top);
    await frames(shell);
    const before = await passed();
    for (let i = 0; i < 2; i++) {
      await shell.setViewportSize({ width: 1200, height: 800 });
      await frames(shell);
      if (top === 0) {
        expect(await scrollTop(shell), "the title, however tall it gets").toBe(0);
      }
      if (before > 0 && before < 1) {
        expect(Math.abs((await passed()) - before), `the title's line at ${top}`).toBeLessThan(0.02);
      }
      await shell.setViewportSize({ width: 1500, height: 800 });
      await frames(shell);
      expect(await scrollTop(shell)).toBe(top);
    }
  }
});

test("the line being read stays at the top of the view as the text above it grows by what the text below it loses, and the pane's width changes", async ({
  shell,
}) => {
  await startNarrow(shell, 40);
  await askElsewhere(shell, LONG_ID, paraId(50));
  await expect(cards(shell)).toHaveCount(1);
  const pad = (above: number) =>
    shell.evaluate(
      ([a, b, above]) => {
        document.querySelector<HTMLElement>(a)!.style.paddingBottom = `${above}px`;
        document.querySelector<HTMLElement>(b)!.style.paddingBottom = `${300 - above}px`;
      },
      [paraBlock(10), paraBlock(70), above] as const,
    );
  await pad(0);
  await scrollTo(shell, paraBlock(40), "start");
  await doc(shell).evaluate((el) => (el.scrollTop += 200));
  await frames(shell);
  const above = async () => (await boxOf(doc(shell))).y - (await boxOf(shell.locator(paraBlock(40)))).y;
  const before = await above();
  await pad(300);
  await frames(shell);
  for (const width of [1900, 1200]) {
    await shell.setViewportSize({ width, height: 800 });
    await frames(shell);
  }
  expect(Math.abs((await above()) - before)).toBeLessThan(1);
});

test("in a narrow pane a view of cards alone stays there as the text above it, and the pane's width, change", async ({ shell }) => {
  await startNarrow(shell, 4);
  await askMany(shell, LONG_ID, paraId(40), 8);
  const y = async () => (await boxOf(cards(shell).nth(3))).y - (await boxOf(doc(shell))).y;
  await cards(shell)
    .nth(3)
    .evaluate((el) => (el.closest(".doc-scroll")!.scrollTop += el.getBoundingClientRect().top - el.closest(".doc-scroll")!.getBoundingClientRect().top + 40));
  await frames(shell);
  for (const i of [40, 41]) {
    await expect(shell.locator(paraBlock(i))).not.toBeInViewport();
  }
  expect(await y()).toBeCloseTo(-40, 0);
  for (const px of [333, 335]) {
    await shell.locator(paraBlock(10)).evaluate((el, px) => (el.style.paddingBottom = `${px}px`), px);
    await frames(shell);
    expect(await y()).toBeCloseTo(-40, 0);
  }
  for (const width of [1230, 1260, 1900, 1200]) {
    await shell.setViewportSize({ width, height: 800 });
    await frames(shell);
  }
  expect(await y()).toBeCloseTo(-40, 0);
});

test("a view that starts in a card, or at the article's end, is there again after a pane of another width", async ({ shell }) => {
  await startNarrow(shell, 8);
  for (const block of [paraId(40), paraId(50)]) {
    await askElsewhere(shell, LONG_ID, block);
  }
  await expect(cards(shell)).toHaveCount(2);
  const resize = async (width: number) => {
    await shell.setViewportSize({ width, height: 800 });
    await expect(shell.locator(".stickies[data-beside]")).toHaveCount(width > 1200 ? 1 : 0);
    await frames(shell);
  };
  for (const at of ["card", "end"] as const) {
    await doc(shell).evaluate((el, at) => {
      const card = el.querySelector(".sticky")!.getBoundingClientRect().top - el.getBoundingClientRect().top;
      el.scrollTop += at === "card" ? card + 60 : el.scrollHeight;
    }, at);
    await frames(shell);
    const top = await scrollTop(shell);
    for (let i = 0; i < 2; i++) {
      await resize(1900);
      await resize(1200);
      expect(Math.abs((await scrollTop(shell)) - top), at).toBeLessThan(2);
    }
  }
  // The end it has come to is where it stays as there is more to scroll to.
  await resize(1900);
  const top = await scrollTop(shell);
  await askMany(shell, LONG_ID, paraId(79), 6);
  await expect.poll(() => doc(shell).evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeGreaterThan(300);
  expect(await scrollTop(shell)).toBe(top);
});

test("the line being read is there again as a pane comes back from under the zoom, with a sticky that came meanwhile", async ({ shell }) => {
  await makeLong(shell);
  await shell.setViewportSize({ width: 1900, height: 900 });
  const root = { kind: "split", id: 90, dir: "row", children: [longPane(1), longPane(3)], sizes: [0.5, 0.5] };
  await shell.addInitScript((l) => localStorage.setItem("lattice.layout", l), JSON.stringify({ root, focused: 3 }));
  await shell.goto("/");
  const left = doc(shell).first();
  await expect(left.locator(paraBlock(40))).toBeAttached({ timeout: 30_000 });
  await askElsewhere(shell, LONG_ID, paraId(10));
  await expect(cards(shell)).toHaveCount(2);
  await left.locator(paraBlock(40)).evaluate((el) => el.scrollIntoView({ block: "start" }));
  await left.evaluate((el) => (el.scrollTop += 9));
  await frames(shell);
  const at = async () => (await boxOf(left.locator(paraBlock(40)))).y - (await boxOf(left)).y;
  const before = await at();
  const zoom = async () => {
    await shell.keyboard.press("Control+a");
    await shell.keyboard.press("z");
  };
  await zoom();
  await expect(left).toBeHidden();
  await askElsewhere(shell, LONG_ID, paraId(12));
  await expect(cards(shell)).toHaveCount(4);
  await frames(shell);
  await zoom();
  await expect(left).toBeVisible();
  await expect.poll(async () => Math.abs((await at()) - before)).toBeLessThan(1);
});

/** Numbers from 0 to 1, the same for a seed. */
const random = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;

for (const seed of [1, 2]) {
  test(`the line being read is at the top of the view again after widths, stickies and text that come and go (${seed})`, async ({ shell }) => {
    test.setTimeout(120_000);
    const r = random(seed * 7919);
    const int = (n: number) => Math.floor(r() * n);
    await shell.setViewportSize({ width: 1500, height: 800 });
    // Between them, blocks that a narrow pane makes taller by much, by little and not at all.
    await startLong(shell, 24, "['code', Array(30).fill('let x = 1;').join('\\n'), null]", true);
    for (const block of seed % 2 ? [paraId(10), paraId(30), paraId(50), null] : [paraId(3), paraId(40), paraId(70)]) {
      await askElsewhere(shell, LONG_ID, block);
    }
    await frames(shell);
    const listAt = async (px: number) => {
      await shell.evaluate((px) => document.querySelector<HTMLElement>(".app")!.style.setProperty("--list-w", `${px}px`), px);
      await frames(shell);
    };
    /** The block at the view's top, and the px of it above there. */
    const line = (id?: string) =>
      doc(shell).evaluate((el, id) => {
        const top = el.getBoundingClientRect().top;
        const blocks = [...el.querySelectorAll(".blocks > *")];
        const b = id ? el.querySelector(`#${id}`)! : blocks.find((x) => x.getBoundingClientRect().bottom > top)!;
        return { id: b.id, above: top - b.getBoundingClientRect().top, height: b.getBoundingClientRect().height };
      }, id);
    for (let trial = 0; trial < 8; trial++) {
      const width = 150 + int(480);
      await listAt(width);
      await doc(shell).evaluate((el, share) => (el.scrollTop = (el.scrollHeight - el.clientHeight) * share), r());
      await frames(shell);
      const before = await line();
      const steps: string[] = [];
      for (let i = 0; i < 10; i++) {
        const kind = int(8);
        if (kind < 2) {
          const px = 150 + int(480);
          steps.push(`width ${px}`);
          await listAt(px);
        } else if (kind === 2) {
          const by = (int(2) ? 1 : -1) * (0.4 + r());
          steps.push(`by ${by}`);
          for (let n = 1, from = 150 + int(480); n <= 6; n++) {
            await listAt(from + n * by);
          }
        } else if (kind === 3) {
          const other = paraBlock(int(80));
          if (other !== `#${before.id}`) {
            const px = int(200);
            steps.push(`${other} ${px}`);
            await shell.locator(other).evaluate((el, px) => (el.style.paddingBottom = `${px}px`), px);
            await frames(shell);
          }
        } else if (kind === 4) {
          const n = int(80);
          steps.push(`ask ${n}`);
          await askElsewhere(shell, LONG_ID, paraId(n));
          await frames(shell);
        } else {
          const all = (await invoke(shell, "list_stickies", { articleId: LONG_ID })) as { id: number; messages: { id: number }[] }[];
          const { id, messages } = all[int(all.length)];
          if (kind === 5 && all.length > 2) {
            steps.push(`delete ${id}`);
            await invoke(shell, "delete_sticky", { id });
          } else if (kind === 6) {
            steps.push(`ask on in ${id}`);
            await invoke(shell, "sticky_follow_up", { id, question: "q" });
          } else if (kind === 7) {
            const parent = messages[int(messages.length)].id;
            steps.push(`ask on ${parent}`);
            await askElsewhere(shell, LONG_ID, null, "q", parent);
          }
          await frames(shell);
        }
      }
      await listAt(width);
      const after = await line(before.id);
      expect(after.height, "as tall as it was").toBeCloseTo(before.height, 0);
      expect(Math.abs(after.above - before.above), `trial ${trial} at ${width}, ${JSON.stringify(before)}: ${steps.join(", ")}`).toBeLessThan(1.5);
    }
  });
}

test("a question opened at the end of an article moves no text as the cards before it give way", async ({ shell }) => {
  await shell.setViewportSize({ width: 1500, height: 900 });
  await startLong(shell);
  await askMany(shell, LONG_ID, paraId(77), 12);
  await scrollTo(shell, paraBlock(77), "start");
  await doc(shell).evaluate((el) => (el.scrollTop -= 40));
  await frames(shell);
  const at = async () => [await scrollTop(shell), (await boxOf(shell.locator(paraBlock(79)))).y];
  const before = await at();
  await askAbout(shell, "質問", paraBlock(79));
  await expect(field(shell)).toBeFocused();
  expect(await at()).toEqual(before);
  await shell.keyboard.press("Escape");
  await expect(cards(shell)).toHaveCount(12);
  expect(await at()).toEqual(before);
});

for (const [from, to] of [
  [1200, 1900],
  [1900, 1200],
]) {
  test(`closing a question gives the view back in a pane of another width, unless the reader has gone on (${from} to ${to})`, async ({ shell }) => {
    await shell.setViewportSize({ width: from, height: 800 });
    await startLong(shell, 12);
    // The paragraph at the top of the view, and how much of it is above.
    const place = () =>
      doc(shell).evaluate((el) => {
        const y = el.getBoundingClientRect().top;
        const blocks = [...el.querySelectorAll(".blk")].map((b) => b.getBoundingClientRect());
        const i = blocks.findIndex((b) => b.bottom > y);
        return i + Math.max(0, (y - blocks[i].top) / blocks[i].height);
      });
    for (const px of [0, 40]) {
      await shell.setViewportSize({ width: from, height: 800 });
      await scrollTo(shell, paraBlock(30), from < 1500 ? "end" : "start");
      await doc(shell).evaluate((el, px) => (el.scrollTop += px), from < 1500 ? 20 : 100);
      await frames(shell);
      const before = await place();
      const p = await boxOf(shell.locator(`${paraBlock(30)} p`));
      await dragTo(shell, [p.x + 4, p.y + p.height - 12], [p.x + 80, p.y + p.height - 12]);
      await bar(shell).getByRole("button", { name: "質問" }).click();
      await expect(field(shell)).toBeFocused();
      await frames(shell);
      expect(Math.abs((await place()) - before)).toBeGreaterThan(0.3);
      await shell.setViewportSize({ width: to, height: 800 });
      await frames(shell);
      await doc(shell).evaluate((el, px) => (el.scrollTop += px), px);
      await frames(shell);
      const now = await place();
      await field(shell).press("Escape");
      await expect(cards(shell)).toHaveCount(0);
      await frames(shell);
      expect(await place(), `${px}`).toBeCloseTo(px ? now : before, 1);
    }
  });
}

test("closing a question on a paragraph that starts above the view, at the end of a long column, gives the view back", async ({ shell }) => {
  await shell.setViewportSize({ width: 1500, height: 900 });
  await startLong(shell, 12);
  await askMany(shell, LONG_ID, paraId(79), 8);
  for (const px of [10, 60, 120]) {
    await scrollTo(shell, paraBlock(79), "start");
    await doc(shell).evaluate((el, px) => (el.scrollTop += px), px);
    await frames(shell);
    const top = await scrollTop(shell);
    const p = await boxOf(shell.locator(`${paraBlock(79)} p`));
    await dragTo(shell, [p.x + 4, p.y + p.height - 12], [p.x + 80, p.y + p.height - 12]);
    await bar(shell).getByRole("button", { name: "質問" }).click();
    await expect(field(shell)).toBeFocused();
    await frames(shell);
    await shell.keyboard.press("Escape");
    await expect(cards(shell)).toHaveCount(8);
    await frames(shell);
    expect(await scrollTop(shell), `${px}`).toBe(top);
  }
});

test("closing a question on the last paragraph, in a narrow pane, gives the view at the article's end back", async ({ shell }) => {
  await startNarrow(shell, 4);
  await askElsewhere(shell, LONG_ID, paraId(50));
  await expect(cards(shell)).toHaveCount(1);
  await doc(shell).evaluate((el) => (el.scrollTop = el.scrollHeight));
  await frames(shell);
  const top = await scrollTop(shell);
  const text = async () => (await boxOf(shell.locator(paraBlock(79)))).y;
  const before = await text();
  await askAbout(shell, "質問", paraBlock(79));
  await expect(field(shell)).toBeFocused();
  await frames(shell);
  expect(await text(), "the field comes into view").toBeLessThan(before - 50);
  await shell.keyboard.press("Escape");
  await expect(cards(shell)).toHaveCount(1);
  await frames(shell);
  expect(Math.abs((await scrollTop(shell)) - top)).toBeLessThan(2);
});

test("the line being read by the column's end stays there through other widths, as the opened card has others give way", async ({ shell }) => {
  await shell.setViewportSize({ width: 1500, height: 900 });
  await startLong(shell, 6);
  await askMany(shell, LONG_ID, paraId(79), 12);
  await scrollTo(shell, paraBlock(79), "center");
  await askAbout(shell, "質問", paraBlock(79));
  await expect(field(shell)).toBeFocused();
  await scrollTo(shell, paraBlock(79), "start");
  await doc(shell).evaluate((el) => (el.scrollTop += 250));
  await frames(shell);
  const above = async () => (await boxOf(doc(shell))).y - (await boxOf(shell.locator(paraBlock(79)))).y;
  const before = await above();
  const listAt = (px: number) => shell.evaluate((px) => document.querySelector<HTMLElement>(".app")!.style.setProperty("--list-w", `${px}px`), px);
  const { width } = await boxOf(list(shell));
  for (const px of [104, 0, 224, 0]) {
    await listAt(width + px);
    await frames(shell);
    if (px === 0) {
      expect(Math.abs((await above()) - before)).toBeLessThan(1);
    }
  }
});

test("cards that give way to the opened one leave no more below them than the view had", async ({ shell }) => {
  await shell.setViewportSize({ width: 1500, height: 900 });
  await startLong(shell);
  await askMany(shell, LONG_ID, paraId(79), 6);
  await scrollTo(shell, paraBlock(79), "center");
  await askAbout(shell, "詳しく", paraBlock(79));
  await expect(cards(shell)).toHaveCount(7);
  const [was, end] = await doc(shell).evaluate((el) => [el.scrollTop + el.clientHeight, el.scrollHeight]);
  expect(end).toBeLessThanOrEqual(was + 2);
  await doc(shell).evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(shell.locator(paraBlock(79))).toBeInViewport();
  await expect(cards(shell).last()).toBeInViewport();
});

test("a column that gets shorter as its cards go takes a view at its end up with it", async ({ shell }) => {
  await shell.setViewportSize({ width: 1500, height: 900 });
  await startLong(shell);
  await askMany(shell, LONG_ID, paraId(79), 12);
  await doc(shell).evaluate((el) => (el.scrollTop = el.scrollHeight));
  await frames(shell);
  for (let id = 12; id > 4; id--) {
    await invoke(shell, "delete_sticky", { id });
  }
  await expect(cards(shell)).toHaveCount(4);
  await expect(cards(shell).last()).toBeInViewport();
});

test("in a narrow pane the text being read stays still as an answer above it comes and goes", async ({ shell }) => {
  await hold(shell, "sticky_ask");
  await startNarrow(shell);
  await scrollTo(shell, paraBlock(40), "center");
  await askAbout(shell, "詳しく", paraBlock(40));
  await scrollTo(shell, paraBlock(60), "center");
  await expect(cards(shell).first()).not.toBeInViewport();
  const y = async () => (await boxOf(shell.locator(paraBlock(60)))).y;
  const [before, top] = [await y(), await scrollTop(shell)];
  const moved = async () => Math.abs((await y()) - before);
  await shell.evaluate(() => window.__e2e.release("sticky_ask"));
  await expect(card(shell, "詳しく").locator(".answer")).toHaveText(ANSWERED);
  // The browser moves the view with the text in a frame of its own.
  await expect.poll(moved).toBeLessThan(1);
  expect(await scrollTop(shell), "it had to").toBeGreaterThan(top + 10);
  await card(shell, "詳しく")
    .getByRole("button", { name: "付箋を削除" })
    .evaluate((el) => (el as HTMLElement).click());
  await shell.getByRole("alertdialog").getByRole("button", { name: "削除" }).click();
  await expect(cards(shell)).toHaveCount(0);
  await expect.poll(moved).toBeLessThan(1);
});

test("in a narrow pane the text in view stays there as cards at the top of the view change", async ({ shell }) => {
  await startNarrow(shell);
  const below = (i: number) => async () => (await boxOf(shell.locator(paraBlock(i)))).y - (await boxOf(doc(shell))).y;
  /** The view starts `px` below the top of the card. */
  const into = (n: number, px: number) =>
    cards(shell)
      .nth(n)
      .evaluate((el, px) => {
        el.closest(".doc-scroll")!.scrollTop += el.getBoundingClientRect().top - el.closest(".doc-scroll")!.getBoundingClientRect().top + px;
        return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      }, px);

  // A card that is cancelled.
  await scrollTo(shell, paraBlock(40), "center");
  await askAbout(shell, "質問", paraBlock(40));
  await into(0, 60);
  const next = below(41);
  const before = await next();
  await card(shell, "質問").getByRole("button", { name: "キャンセル" }).click();
  await expect(cards(shell)).toHaveCount(0);
  expect(await next()).toBeGreaterThanOrEqual(0);
  expect(await next()).toBeLessThanOrEqual(before);

  // The second of two that goes, and then the first, whose top is above the view.
  for (const quote of ["one", "two"]) {
    await askElsewhere(shell, LONG_ID, paraId(40), quote);
  }
  await expect(cards(shell)).toHaveCount(2);
  const top = async () => (await boxOf(cards(shell).first())).y - (await boxOf(doc(shell))).y;
  await into(0, 60);
  const at = await top();
  await invoke(shell, "delete_sticky", { id: 2 });
  await expect(cards(shell)).toHaveCount(1);
  expect(Math.abs((await top()) - at), "the card in view stays").toBeLessThan(2);
  await invoke(shell, "delete_sticky", { id: 1 });
  await expect(cards(shell)).toHaveCount(0);
  expect(await next()).toBeGreaterThanOrEqual(0);

  // An answer that comes in the card just above the view.
  await askElsewhere(shell, LONG_ID, paraId(50), "three");
  await expect(cards(shell)).toHaveCount(1);
  const card50 = await boxOf(cards(shell).first());
  await into(0, card50.height + 3);
  const text = below(51);
  const y = await text();
  expect(y).toBeGreaterThan(0);
  await askElsewhere(shell, LONG_ID, paraId(50), "four");
  await expect(cards(shell)).toHaveCount(2);
  await expect.poll(async () => Math.abs((await text()) - y)).toBeLessThan(2);
});

test("the text in view stays there as a pane with cards above the first block gets the column", async ({ shell }) => {
  await shell.setViewportSize({ width: 1200, height: 800 });
  await startLong(shell);
  for (const quote of ["one", "two", "three", "four"]) {
    await askElsewhere(shell, LONG_ID, null, quote);
  }
  await expect(cards(shell)).toHaveCount(4);
  await cards(shell)
    .last()
    .evaluate((el) => {
      el.closest(".doc-scroll")!.scrollTop += el.getBoundingClientRect().top - el.closest(".doc-scroll")!.getBoundingClientRect().top + 60;
      return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    });
  const first = shell.locator(`#b-${LONG_ID * 100 + 1}`);
  await expect(first).toBeInViewport();
  for (let i = 0; i < 2; i++) {
    await shell.setViewportSize({ width: 1900, height: 800 });
    await expect(shell.locator(".stickies[data-beside]")).toHaveCount(1);
    await expect(first).toBeInViewport();
    await shell.setViewportSize({ width: 1200, height: 800 });
    await expect(shell.locator(".stickies[data-beside]")).toHaveCount(0);
    await expect(first).toBeInViewport();
  }
});

test("in a narrow pane stickies that come all at once leave the text at the top of the view there", async ({ shell }) => {
  await hold(shell, "list_stickies");
  await startNarrow(shell);
  // One is on the block at the top, whose own styles change with it, and one has no block.
  for (const block of [null, LONG_ID * 100 + 2, paraId(10), paraId(40)]) {
    await askElsewhere(shell, LONG_ID, block);
  }
  await doc(shell).evaluate((el) => (el.scrollTop += 5));
  await scrollTo(shell, paraBlock(40), "start");
  await doc(shell).evaluate((el) => (el.scrollTop += 5));
  const y = async () => (await boxOf(shell.locator(paraBlock(40)))).y;
  const before = await y();
  await shell.evaluate(() => window.__e2e.release("list_stickies"));
  await expect(cards(shell)).toHaveCount(4);
  await expect.poll(async () => Math.abs((await y()) - before)).toBeLessThan(1);

  await doc(shell).evaluate((el) => el.scrollTo(0, 0));
  const [first, second, heading, chips] = [
    await boxOf(cards(shell).first()),
    await boxOf(cards(shell).nth(1)),
    await boxOf(shell.locator(`#b-${LONG_ID * 100 + 1}`)),
    await boxOf(shell.locator(".art-chips")),
  ];
  expect(first.y, "the one without a block is above the article's first").toBeGreaterThanOrEqual(chips.y + chips.height);
  expect(heading.y).toBeGreaterThanOrEqual(first.y + first.height);
  expect(second.y).toBeGreaterThan(heading.y + heading.height);
});

test("the cards are under their block in a narrow pane, and beside it in a wider one", async ({ shell }) => {
  await shell.setViewportSize({ width: 1500, height: 900 });
  await startLong(shell);
  const plain = await boxOf(shell.locator(paraBlock(10)));
  await askElsewhere(shell, LONG_ID, paraId(0), "one");
  await askElsewhere(shell, LONG_ID, paraId(0), "two");
  const [one, two] = [cards(shell).first(), cards(shell).nth(1)];
  const beside = async () => {
    const [c, r] = [await boxOf(one), await boxOf(shell.locator(".reader"))];
    return c.x >= r.x + r.width - 1;
  };
  const under = async () => {
    const [a, b, block, next] = [await boxOf(one), await boxOf(two), await boxOf(shell.locator(paraBlock(0))), await boxOf(shell.locator(paraBlock(1)))];
    return a.x === block.x + 14 && a.y >= block.y + block.height && b.y >= a.y + a.height && next.y >= b.y + b.height;
  };
  const roomless = async () => Math.abs((await boxOf(shell.locator(paraBlock(10)))).y - plain.y) < 1;
  await expect.poll(beside).toBe(true);
  expect(await roomless()).toBe(true);
  // The pane keeps what the sidebar and the list leave.
  const pane = await doc(shell).evaluate((el) => el.clientWidth);
  await shell.setViewportSize({ width: 1500 - pane + 720, height: 900 });
  expect(await doc(shell).evaluate((el) => el.clientWidth)).toBe(720);
  await expect.poll(beside).toBe(true);
  const text = await boxOf(shell.locator(".reader .blocks"));
  expect(text.width, "the text gives up width").toBeGreaterThan(240);
  await shell.setViewportSize({ width: 1500 - pane + 719, height: 900 });
  await expect.poll(under).toBe(true);

  // Asked here it is under those before too.
  await askAbout(shell, "用語", paraBlock(0));
  await expect(cards(shell)).toHaveCount(3);
  await expect.poll(async () => (await boxOf(cards(shell).nth(2))).y >= (await boxOf(two)).y + (await boxOf(two)).height).toBe(true);
  expect(await under()).toBe(true);

  // A card that the reader makes taller pushes the text below it.
  await scrollTo(shell, paraBlock(3), "center");
  await askAbout(shell, "質問", paraBlock(3));
  const grip = await boxOf(field(shell));
  const next = async () => (await boxOf(shell.locator(paraBlock(4)))).y;
  const before = await next();
  await shell.mouse.move(grip.x + grip.width - 4, grip.y + grip.height - 4);
  await shell.mouse.down();
  await shell.mouse.move(grip.x + grip.width - 4, grip.y + grip.height + 116, { steps: 6 });
  await shell.mouse.up();
  await expect.poll(async () => (await next()) - before).toBeGreaterThan(100);
  expect(await callsOf(shell, "log_ui_error"), "in the app's log").toEqual([]);
  await shell.keyboard.press("Escape");
  await shell.setViewportSize({ width: 1500, height: 900 });
  await expect.poll(beside).toBe(true);
  await doc(shell).evaluate((el) => el.scrollTo(0, 0));
  await expect.poll(roomless).toBe(true);
});

test("a column that narrows the text leaves the line at the top of the view there, as it comes and as it goes", async ({ shell }) => {
  await shell.setViewportSize({ width: 1500, height: 900 });
  await startLong(shell, 12);
  const pane = await doc(shell).evaluate((el) => el.clientWidth);
  await shell.setViewportSize({ width: 1500 - pane + 800, height: 900 });
  await scrollTo(shell, paraBlock(40), "start");
  await doc(shell).evaluate((el) => (el.scrollTop += 150));
  const [top, wide] = [await scrollTop(shell), await boxOf(shell.locator(paraBlock(40)))];
  const passed = async () => {
    const [b, view] = [await boxOf(shell.locator(paraBlock(40))), await boxOf(doc(shell))];
    return (view.y - b.y) / b.height;
  };
  const before = await passed();
  await askAbout(shell, "質問", paraBlock(42));
  await expect(field(shell)).toBeFocused();
  expect((await boxOf(shell.locator(paraBlock(40)))).height, "the text is narrower").toBeGreaterThan(wide.height + 20);
  expect(Math.abs((await passed()) - before)).toBeLessThan(0.02);
  await shell.keyboard.press("Escape");
  await expect(cards(shell)).toHaveCount(0);
  expect(Math.abs((await scrollTop(shell)) - top)).toBeLessThan(3);
});

test("what is in a sticky is not the article's text: the find, link labels, visual mode and gi pass over it", async ({ shell }) => {
  await shell.addInitScript(() => {
    // What the document keys draw is in a closed shadow root, which no locator reaches.
    // oxlint-disable-next-line typescript/unbound-method -- called on each element below
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      return attach.call(this, { ...init, mode: "open" });
    };
  });
  await shell.goto("/");
  await openSnapshot(shell);
  await askAbout(shell, "質問", "#b-102");
  await field(shell).fill("zymurgy? closely?");
  await shell.keyboard.press("Control+Enter");
  await expect(card(shell, "質問").locator(".answer")).toBeVisible();
  await askAbout(shell, "質問", "#b-106");
  await expect(field(shell)).toBeFocused();
  await shell.locator(".art-title").click();
  await expect(shell.locator(".doc-scroll")).toBeFocused();
  const drawn = shell.locator("[data-lattice-ui]");

  await shell.keyboard.press("/");
  await shell.keyboard.type("zymurgy");
  await expect(drawn).toContainText("0/0");
  await shell.keyboard.press("Escape");
  await shell.keyboard.press("/");
  await shell.keyboard.type("closely");
  await expect(drawn, "the last paragraph's alone").toContainText("1/1");
  await shell.keyboard.press("Enter");
  expect(await selected(shell)).toBe("closely");
  await shell.keyboard.press("Escape");

  await shell.keyboard.press("v");
  await shell.keyboard.press("v");
  await shell.keyboard.press("Shift+G");
  expect(await selected(shell), "from the match to the end of the article").toBe(".");
  await shell.keyboard.press("Escape");
  await shell.keyboard.press("Escape");

  await shell.keyboard.press("f");
  const labels = drawn.locator("div:not(:has(*))").filter({ hasText: /^[A-Z]+$/ });
  await expect(labels.first()).toBeVisible();
  const column = await boxOf(shell.locator(".stickies"));
  for (const l of await labels.all()) {
    expect((await boxOf(l)).x).toBeLessThan(column.x);
  }
  await shell.keyboard.press("Escape");

  // The first field of the document is not the question being written.
  await shell.keyboard.press("g");
  await shell.keyboard.press("i");
  await expect(field(shell)).not.toBeFocused();
});

test("a selection that is not of the article's text offers nothing to ask", async ({ app }) => {
  await openSnapshot(app);
  await askAbout(app, "詳しく", "#b-102");
  await expect(card(app, "詳しく").locator(".answer")).toBeVisible();
  // In the card, by the mouse, of what is no answer.
  await card(app, "詳しく")
    .locator(".sticky-quote")
    .dblclick({ position: { x: 20, y: 10 } });
  expect(await selected(app)).not.toBe("");
  await expect(bar(app)).toHaveCount(0);
  // From the title.
  await drag(app, ".reader", "#b-102");
  expect(await selected(app)).toContain("Every transaction");
  await expect(bar(app)).toHaveCount(0);
  // From the text, by the keyboard, to the end of all there is.
  await app.locator("#b-106 p").click();
  await drag(app, "#b-106", "#b-106");
  await expect(bar(app)).toBeVisible();
  await app.keyboard.press("Control+Shift+End");
  expect(await selected(app)).toContain("選んだ箇所の説明です");
  await expect(bar(app)).toHaveCount(0);
  // A tooltip of the paragraph above would cover it.
  await app.locator(".art-title").hover();
  await expect(app.locator(".pop")).toBeHidden();
  // A triple click on the last paragraph ends its selection after the blocks, with no text there.
  await app.locator("#b-107 p").click({ clickCount: 3 });
  await expect(bar(app).getByRole("button", { name: "詳しく" })).toBeVisible();
});

/** Points in the first line of `block`, `dx` from its start. */
async function inLine(page: Page, block: string, dx: number): Promise<[number, number]> {
  const b = await boxOf(page.locator(`${block} p`));
  return [b.x + dx, b.y + 14];
}

test("a drag past the text's edge over the column selects to the line's end, over a card too", async ({ shell }) => {
  await shell.setViewportSize({ width: 1500, height: 900 });
  await startLong(shell);
  await askElsewhere(shell, LONG_ID, paraId(8));
  await expect(cards(shell)).toHaveCount(1);
  // The last of them well in view: a drag to the view's edge scrolls.
  await scrollTo(shell, paraBlock(3), "start");
  const c = await boxOf(cards(shell).first());
  const x = c.x + c.width / 2;
  for (const [name, i] of [
    ["the empty column above the card", 4],
    ["the empty column below it", 14],
    ["the card", 9],
  ] as const) {
    const from = await inLine(shell, paraBlock(i), 1);
    expect(from[1] > c.y && from[1] < c.y + c.height, name).toBe(i === 9);
    await dragTo(shell, from, [from[0] + 100, from[1]], [x, from[1]]);
    expect(await selected(shell), name).toBe(para(i));
    await expect(bar(shell).getByRole("button", { name: "詳しく" }), name).toBeVisible();
    // Two lines down on the way.
    await dragTo(shell, from, [x, from[1]], [x, (await inLine(shell, paraBlock(i + 2), 0))[1]]);
    expect(await selected(shell), name).toBe([para(i), para(i + 1), para(i + 2)].join(" "));
  }
  // Let go outside the window, and the cards are there to press again.
  const from = await inLine(shell, paraBlock(9), 1);
  await dragTo(shell, from, [x, from[1]], [1600, from[1]]);
  expect(await selected(shell)).toBe(para(9));
  await cards(shell).first().getByRole("button", { name: "付箋を削除" }).click();
  await expect(shell.getByRole("alertdialog")).toBeVisible();
});

test("a passage selected from the margins is asked about, and one that Shift extends there as it is then", async ({ app }) => {
  await openSnapshot(app);
  const text = await boxOf(app.locator("#b-102 p"));
  await dragTo(app, [text.x - 30, text.y + 14], [text.x + text.width + 30, text.y + 14]);
  expect(await selected(app)).not.toBe("");
  await expect(bar(app)).toBeVisible();

  await drag(app, "#b-102", "#b-102");
  await expect(bar(app)).toBeVisible();
  const to = await boxOf(app.locator("#b-103 p"));
  await app.keyboard.down("Shift");
  await app.mouse.click(to.x + to.width + 30, to.y + to.height - 10);
  // With Shift held: letting go of it offers the bar too.
  await bar(app).getByRole("button", { name: "用語" }).click();
  await app.keyboard.up("Shift");
  await expect.poll(async () => (await asked(app)).at(-1)?.quote.split(/\n+/).length).toBe(2);
});

test("a passage selected from the margins after another one, or extended there by Shift, can be asked about", async ({ shell }) => {
  await startLong(shell, 8);
  await scrollTo(shell, paraBlock(3), "center");
  const scroll = async () => {
    await doc(shell).evaluate((el) => (el.scrollTop += 10));
    await expect(bar(shell)).toHaveCount(0);
    return boxOf(shell.locator(`${paraBlock(3)} p`));
  };
  await drag(shell, paraBlock(2), paraBlock(2));
  await expect(bar(shell)).toBeVisible();
  let p = await scroll();
  await shell.mouse.move(p.x - 30, p.y + 14);
  await shell.mouse.down();
  await shell.mouse.move(p.x + p.width + 30, p.y + 14, { steps: 5 });
  await shell.mouse.up();
  expect(await selected(shell)).toContain(para(3));
  await expect(bar(shell)).toBeVisible();
  await shell.keyboard.down("Shift");
  for (const line of [2, 1, 3]) {
    p = await scroll();
    const before = await selected(shell);
    await shell.mouse.click(p.x + p.width + 30, p.y + 14 + 31 * line);
    expect(await selected(shell)).not.toBe(before);
    await expect(bar(shell), `line ${line}`).toBeVisible();
  }
  await shell.keyboard.up("Shift");

  // Dragged backwards, it is the start that goes on.
  p = await scroll();
  await dragTo(shell, [p.x + p.width + 30, p.y + 14 + 31 * 3], [p.x - 30, p.y + 14 + 31 * 2]);
  await expect(bar(shell)).toBeVisible();
  p = await scroll();
  const before = await selected(shell);
  await shell.keyboard.down("Shift");
  await shell.mouse.click(p.x - 30, p.y + 14 + 31);
  const now = await selected(shell);
  expect(now.endsWith(before) && now !== before).toBe(true);
  await expect(bar(shell)).toBeVisible();
  await shell.keyboard.up("Shift");
});

test("a press that begins outside the article leaves what is selected without a bar", async ({ shell }) => {
  await startLong(shell);
  await drag(shell, paraBlock(2), paraBlock(2));
  await doc(shell).evaluate((el) => (el.scrollTop += 20));
  await expect(bar(shell)).toHaveCount(0);
  const border = await boxOf(shell.locator(".splitter.at-list"));
  const nav = await boxOf(shell.locator(".nav"));
  for (const [x, y] of [
    [nav.x + nav.width - 4, nav.y + nav.height - 3],
    [border.x + border.width / 2, border.y + 300],
  ]) {
    await shell.mouse.move(x, y);
    await shell.mouse.down();
    await shell.mouse.move(border.x + 120, border.y + 300, { steps: 6 });
    await shell.mouse.up();
    expect(await selected(shell)).toContain(para(2).slice(0, 10));
    await frames(shell);
    await expect(bar(shell)).toHaveCount(0);
  }
});

test("a passage selected again, as after a scroll took its bar away, can be asked about", async ({ shell }) => {
  await startLong(shell);
  await drag(shell, paraBlock(2), paraBlock(2));
  await expect(bar(shell)).toBeVisible();
  const before = await selected(shell);
  await doc(shell).evaluate((el) => (el.scrollTop += 20));
  await expect(bar(shell)).toHaveCount(0);
  await selectAgain(shell, before);
});

test("a passage that visual mode extends is asked about as it is then", async ({ shell }) => {
  await startLong(shell);
  await drag(shell, paraBlock(2), paraBlock(2));
  await expect(bar(shell)).toBeVisible();
  for (const key of ["v", "j", "j"]) {
    await shell.keyboard.press(key);
  }
  await expect.poll(() => selected(shell)).toContain(para(3));
  const quote = await selected(shell);
  await bar(shell).getByRole("button", { name: "用語" }).click();
  await expect.poll(async () => (await asked(shell)).at(-1)?.quote.replace(/\s+/g, " ")).toBe(quote);
});

test("in a narrow pane a drag over a card selects the text on both sides of it alone", async ({ shell }) => {
  await startNarrow(shell);
  await askElsewhere(shell, LONG_ID, paraId(8));
  await expect(cards(shell)).toHaveCount(1);
  await scrollTo(shell, paraBlock(8), "center");
  const c = await boxOf(cards(shell).first());
  const over: [number, number] = [c.x + 60, c.y + c.height / 2];
  const from = await inLine(shell, paraBlock(7), 1);
  await dragTo(shell, from, over);
  expect(await selected(shell)).toMatch(/^Paragraph 7 of the long article\. Paragr/);
  expect(await selected(shell)).not.toContain("Paragraph 9");
  await expect(bar(shell).getByRole("button", { name: "詳しく" })).toBeVisible();
  const { width } = await boxOf(shell.locator(`${paraBlock(9)} p`));
  await dragTo(shell, from, over, await inLine(shell, paraBlock(9), width - 1));
  expect(await selected(shell)).toBe([para(7), para(8), para(9)].join(" "));
  await bar(shell).getByRole("button", { name: "用語" }).click();
  await expect.poll(async () => (await asked(shell)).at(-1)!.quote.split(/\n+/)).toEqual([para(7), para(8), para(9)]);
});

test("a press on a sticky takes the bar away, and the selection that stays does not bring it back", async ({ app }) => {
  await openSnapshot(app);
  await askAbout(app, "詳しく", "#b-102");
  await expect(card(app, "詳しく").locator(".answer")).toBeVisible();
  const dialog = app.getByRole("alertdialog", { name: "付箋を削除しますか？" });
  for (const press of [
    async () => {
      await card(app, "詳しく").getByRole("button", { name: "付箋を削除" }).click();
      await expect(dialog).toBeVisible();
      await expect(bar(app)).toHaveCount(0);
      await dialog.getByRole("button", { name: "キャンセル" }).click();
      await expect(dialog).toBeHidden();
      await app.keyboard.press("Tab");
      await app.keyboard.press("Shift+Tab");
      await expect(card(app, "詳しく").getByRole("button", { name: "付箋を削除" })).toBeFocused();
    },
    () => card(app, "詳しく").locator(".cite").click(),
  ]) {
    // A tooltip of the paragraph above would cover it.
    await app.locator(".art-title").hover();
    await expect(app.locator(".pop")).toBeHidden();
    await drag(app, "#b-103", "#b-103");
    await expect(bar(app)).toBeVisible();
    await press();
    expect(await selected(app)).toContain("multi-version");
    await expect(bar(app)).toHaveCount(0);
  }
  await drag(app, "#b-106", "#b-106");
  await expect(bar(app)).toBeVisible();
});

for (const layout of ["wide", "narrow"] as const) {
  test(`a drag that starts in a card selects none of the article (${layout})`, async ({ shell }) => {
    await (layout === "wide" ? startLong(shell) : startNarrow(shell));
    await askElsewhere(shell, LONG_ID, paraId(8), "the quote of the card");
    await expect(cards(shell)).toHaveCount(1);
    await expect(shell.locator(".stickies[data-beside]")).toHaveCount(layout === "wide" ? 1 : 0);
    await scrollTo(shell, paraBlock(8), "center");
    const quote = await boxOf(cards(shell).first().locator(".sticky-quote"));
    const from: [number, number] = [quote.x + 14, quote.y + 10];
    for (const i of [4, 14]) {
      await dragTo(shell, from, [from[0] + 60, from[1]], await inLine(shell, paraBlock(i), 90));
      expect(await selected(shell)).not.toBe("");
      expect(await selected(shell)).not.toContain("Paragraph");
      await expect(bar(shell)).toHaveCount(0);
    }
    // And the article's text is to select again.
    await dragTo(shell, await inLine(shell, paraBlock(14), 1), await inLine(shell, paraBlock(14), 90));
    expect(await selected(shell)).toContain("Paragraph");
  });

  test(`a drag that starts in a card selects nothing outside it (${layout})`, async ({ shell }) => {
    await (layout === "wide" ? startLong(shell) : startNarrow(shell));
    for (const i of [7, 8, 9]) {
      await askElsewhere(shell, LONG_ID, paraId(i), `the quote of card ${i}`);
    }
    await expect(cards(shell)).toHaveCount(3);
    await expect(shell.locator(".stickies[data-beside]")).toHaveCount(layout === "wide" ? 1 : 0);
    // With the next card in view: a drag to the view's edge scrolls.
    await scrollTo(shell, paraBlock(8), "start");
    const [middle, next] = [await boxOf(cards(shell).nth(1)), await boxOf(cards(shell).nth(2))];
    const own = (await cards(shell).nth(1).innerText()).replace(/\s+/g, "");
    const answer = await boxOf(cards(shell).nth(1).locator(".answer"));
    const from: [number, number] = [answer.x + 4, answer.y + 12];
    const list = await boxOf(shell.locator(".list"));
    for (const to of [
      [middle.x + middle.width + 5, answer.y + 12],
      [middle.x + 60, next.y + 40],
      [middle.x - 60, answer.y + 30],
      [list.x + 40, answer.y + 30],
      [middle.x + 60, 5],
    ] as [number, number][]) {
      await dragTo(shell, from, [from[0] + 60, from[1]], to);
      const got = (await selected(shell)).replace(/ /g, "");
      expect(got).not.toBe("");
      expect(own).toContain(got);
    }
  });
}

test("the other language of a sentence, shown under its block, and a block's label are not in the passage", async ({ app }) => {
  await openSnapshot(app);
  await askAbout(app, "詳しく", "#b-103");
  await card(app, "詳しく").locator(".cite").click();
  await expect(app.locator("#b-103 .blk-label")).toBeVisible();
  await app.locator("#b-102 .sent").hover();
  await expect(app.locator("#b-102 .pop")).toBeVisible();
  // As a drag up from the second paragraph leaves it: the tooltip of the first is still up.
  await selectFrom(app, "#b-102 .sent", "#b-103 .sent");
  await bar(app).getByRole("button", { name: "用語" }).click();
  await expect.poll(async () => (await asked(app)).length).toBe(2);
  expect((await asked(app))[1].quote.split(/\n+/)).toEqual([
    "Every transaction reads from a consistent snapshot taken when it starts.",
    "PostgreSQL implements it with multi-version concurrency control.",
  ]);
});

test("a drag goes on into an open tooltip and across it, and the passage is the blocks' text on both sides", async ({ app }) => {
  await openSnapshot(app);
  const japanese = /[ぁ-ん]/u;
  const [from, third] = [await inLine(app, "#b-102", 1), await boxOf(app.locator("#b-106 p"))];
  const pop = app.locator("#b-102 .pop");
  /** Presses, with the tooltip of the first paragraph open, and drags into it and on to the third paragraph. */
  const across = async (press: "text" | "tooltip") => {
    await app.evaluate(() => getSelection()!.removeAllRanges());
    await app.locator(".art-title").hover();
    await expect(pop).toBeHidden();
    await app.locator("#b-102 .sent").hover();
    await expect(pop).toBeVisible();
    const box = await boxOf(pop);
    // The tooltip's first line, under what it says of itself.
    const line = box.y + 46;
    await app.mouse.move(...(press === "text" ? from : ([box.x + 30, line] as const)));
    await app.mouse.down();
    await app.mouse.move(box.x + 150, line, { steps: 5 });
    const inTooltip = await selected(app);
    await app.mouse.move(third.x + 200, third.y + third.height - 10, { steps: 5 });
    await app.mouse.up();
    await bar(app).getByRole("button", { name: "用語" }).click();
    return inTooltip;
  };
  expect(await across("text")).toMatch(/^Every transaction .* starts\. .*[ぁ-ん]/u);
  expect(await across("tooltip")).toMatch(japanese);
  await expect.poll(async () => (await asked(app)).length).toBe(2);
  const [first, second] = await asked(app);
  expect(first.blockId).toBe(102);
  expect(first.quote).toMatch(/^Every transaction [^]*Readers never block writers\./);
  expect(second.blockId, "the next block's").toBe(103);
  expect(second.quote).toMatch(/^PostgreSQL implements [^]*Readers never block writers\./);
  expect(first.quote + second.quote).not.toMatch(japanese);
});

test("what came of saving a word stays as a key is pressed", async ({ app }) => {
  await openSnapshot(app);
  const word = await boxOf(app.locator("#b-106 p"));
  await app.mouse.dblclick(word.x + 10, word.y + 12);
  await bar(app)
    .getByRole("button", { name: /単語を登録/ })
    .click();
  await expect(bar(app)).toContainText("登録しました");
  await app.keyboard.press("Control");
  await frames(app);
  await expect(bar(app)).toContainText("登録しました");
});

test("why a word could not be saved stays as a key is pressed", async ({ app }) => {
  await openSnapshot(app);
  await app.evaluate(() => {
    const tauri = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: object) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const invoke = tauri.invoke;
    tauri.invoke = (cmd, args) => (cmd === "vocab_add" ? Promise.reject(new Error("no such word")) : invoke(cmd, args));
  });
  const word = await boxOf(app.locator("#b-106 p"));
  await app.mouse.dblclick(word.x + 10, word.y + 12);
  await bar(app)
    .getByRole("button", { name: /単語を登録/ })
    .click();
  await expect(bar(app)).toContainText("no such word");
  await app.keyboard.press("Control");
  await frames(app);
  await expect(bar(app)).toContainText("no such word");
});

test("a word in a sentence's tooltip can be saved, and not asked about", async ({ app }) => {
  await openSnapshot(app);
  await app.locator("#b-103 .sent").hover();
  const pop = app.locator("#b-103 .pop");
  await expect(pop).toBeVisible();
  const word = await pop.evaluate((el) => {
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const at = n.textContent!.indexOf("PostgreSQL");
      if (at >= 0) {
        const r = document.createRange();
        r.setStart(n, at);
        r.setEnd(n, at + "PostgreSQL".length);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(r);
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        return getSelection()!.toString();
      }
    }
    return null;
  });
  expect(word).toBe("PostgreSQL");
  await expect(bar(app).getByRole("button")).toHaveText([/単語を登録/]);
});

test("letting go of the scrollbar brings no bar", async ({ shell }) => {
  await startLong(shell);
  await scrollTo(shell, paraBlock(3), "center");
  await drag(shell, paraBlock(3), paraBlock(3));
  await expect(bar(shell)).toBeVisible();
  // Where the scrollbar's track is, below its thumb.
  const [x, y] = await doc(shell).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return [r.left + (el.clientWidth + r.width) / 2, r.bottom - 60];
  });
  await shell.mouse.move(x, y);
  await shell.mouse.down();
  await expect.poll(() => scrollTop(shell)).toBeGreaterThan(0);
  await shell.mouse.up();
  expect(await selected(shell)).not.toBe("");
  await expect(bar(shell)).toHaveCount(0);
});

test("a passage over the limit cannot be asked about", async ({ app }) => {
  await openSnapshot(app);
  const grow = (n: number) => app.locator("#b-102 .sent").evaluate((el, text) => (el.textContent = text), "𠮷".repeat(n));
  await grow(2000);
  await selectFrom(app, "#b-102 .sent", "#b-102 .sent");
  await expect(bar(app).getByRole("button", { name: "詳しく" })).toBeEnabled();
  await grow(2001);
  await selectFrom(app, "#b-102 .sent", "#b-102 .sent");
  await expect(bar(app).getByRole("button", { name: "詳しく" })).toBeDisabled();
  await expect(bar(app).getByRole("button", { name: "質問" })).toHaveAttribute("title", "選んだ箇所が空か、2,000文字を超えています");
});

test("the bar of a passage that ends below the view, or at its edge, is in the window", async ({ shell }) => {
  await startLong(shell);
  await selectFrom(shell, paraBlock(0), paraBlock(75));
  await expect(bar(shell)).toBeInViewport({ ratio: 1 });
});

test("the bar of a passage at either end of a line is in a window hardly wider than it", async ({ shell }) => {
  await makeLong(shell, 4);
  await shell.setViewportSize({ width: 520, height: 800 });
  await shell.addInitScript((l) => localStorage.setItem("lattice.window.doc-1", l), JSON.stringify({ root: longPane(1), focused: 1 }));
  await shell.goto("/?window=doc-1");
  await scrollTo(shell, paraBlock(40), "center");
  const line = await boxOf(shell.locator(`${paraBlock(40)} p`));
  for (const x of [line.x + 10, line.x + line.width - 30]) {
    await shell.mouse.dblclick(x, line.y + 14);
    expect(await selected(shell)).not.toBe("");
    await expect(bar(shell)).toBeInViewport({ ratio: 1 });
    await shell.mouse.click(line.x - 4, line.y + 14);
    await expect(bar(shell)).toHaveCount(0);
  }
});

/** The place kept for an article. */
const placeOf = (page: Page, article = LONG_ID) =>
  page.evaluate(
    (id) =>
      (JSON.parse(localStorage.getItem("lattice.readingPlaces") ?? "[]") as [string, { text: string; at: number; page?: { text: string; at: number } }][]).find(
        ([a]) => a === id,
      )?.[1],
    String(article),
  );
const placeText = async (page: Page) => (await placeOf(page))?.text;

test("the reading place is the article's while the view is among the cards that go on below it", async ({ shell }) => {
  await startLong(shell);
  await scrollTo(shell, paraBlock(40), "start");
  await expect.poll(() => placeText(shell)).toBe(para(40));
  await askMany(shell, LONG_ID, paraId(70), 12);
  await doc(shell).evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect(shell.locator(paraBlock(79))).not.toBeInViewport();
  await expect.poll(() => placeText(shell)).toBe(para(79));
  await doc(shell).evaluate((el) => el.scrollTo(0, 0));
  await expect.poll(() => placeText(shell)).toBeUndefined();
});

test("the reading place among the cards under a block is the block's end, and the article opens there again", async ({ shell }) => {
  await startNarrow(shell);
  await askMany(shell, LONG_ID, paraId(40), 4);
  await cards(shell)
    .nth(2)
    .evaluate((el) => el.scrollIntoView({ block: "start" }));
  await expect.poll(() => placeText(shell)).toBe(para(40));
  const { at } = (await placeOf(shell))!;
  expect(at).toBeGreaterThan(0.9);
  expect(at).toBeLessThanOrEqual(1);
  await open(shell, SNAPSHOT_ID);
  await open(shell, LONG_ID);
  const end = async () => {
    const [b, view] = [await boxOf(shell.locator(paraBlock(40))), await boxOf(doc(shell))];
    return Math.abs(b.y + b.height - view.y);
  };
  await expect.poll(end).toBeLessThan(3);
  await expect(cards(shell).first()).toBeInViewport();
  // Past the last block too.
  await askMany(shell, LONG_ID, paraId(79), 6);
  await doc(shell).evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect(shell.locator(paraBlock(79))).not.toBeInViewport();
  await expect.poll(() => placeText(shell)).toBe(para(79));
});

test("the reading place among the cards above the first block is none", async ({ shell }) => {
  await startNarrow(shell);
  for (const quote of ["one", "two", "three", "four"]) {
    await askElsewhere(shell, LONG_ID, null, quote);
  }
  await expect(cards(shell)).toHaveCount(4);
  await scrollTo(shell, paraBlock(40), "start");
  await expect.poll(() => placeText(shell)).toBe(para(40));
  await cards(shell)
    .nth(2)
    .evaluate((el) => el.scrollIntoView({ block: "start" }));
  await expect.poll(() => placeText(shell)).toBeUndefined();
});

test("the place that the Page view gets among the cards below an article that ends in a listing is the listing's end", async ({ shell }) => {
  await shell.setViewportSize({ width: 1500, height: 900 });
  await startLong(shell, 1, "['code', 'the last listing', null]");
  await askMany(shell, LONG_ID, paraId(70), 12);
  await doc(shell).evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect(shell.locator(paraBlock(80))).not.toBeInViewport();
  await expect.poll(() => placeText(shell)).toBe("the last listing");
  // In heights of the paragraph above the listing, a line each.
  expect((await placeOf(shell))!.page!.at).toBeLessThan(5);
});

test("the place that the Page view gets of a code block leaves out the cards between it and the next paragraph", async ({ shell }) => {
  await startNarrow(shell);
  await openSnapshot(shell);
  await askMany(shell, SNAPSHOT_ID, 105, 6);
  await scrollTo(shell, "#b-105", "start");
  await expect.poll(async () => (await placeOf(shell, SNAPSHOT_ID))?.text).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ;");
  const { page } = (await placeOf(shell, SNAPSHOT_ID))!;
  const [code, next] = [await boxOf(shell.locator("#b-105")), await boxOf(shell.locator("#b-106"))];
  expect(page!.text).toBe("Write skew is still possible under snapshot isolation.");
  expect(Math.abs(page!.at * next.height + code.height), "the code block above its start").toBeLessThan(20);
});

test("a passage extended by the keyboard is asked about as it is then", async ({ app }) => {
  await openSnapshot(app);
  await drag(app, "#b-105", "#b-105");
  await expect(bar(app)).toBeVisible();
  const whole = await app.evaluate(() => getSelection()!.toString());
  for (let i = 0; i < 4; i++) {
    await app.keyboard.press("Shift+ArrowLeft");
  }
  await bar(app).getByRole("button", { name: "詳しく" }).click();
  await expect(card(app, "詳しく").locator(".answer")).toHaveText(ANSWERED);
  expect((await asked(app))[0].quote).toBe(whole.slice(0, -4));
});

test("a passage extended by Shift and an arrow can be asked about after a scroll took its bar away", async ({ shell }) => {
  await startLong(shell);
  await drag(shell, paraBlock(2), paraBlock(2));
  await expect(bar(shell)).toBeVisible();
  await doc(shell).evaluate((el) => (el.scrollTop += 20));
  await expect(bar(shell)).toHaveCount(0);
  await shell.keyboard.press("Shift+ArrowLeft");
  await expect(bar(shell)).toBeVisible();
});

test("the print of an article with a column of stickies has the text as without it", async ({ shell }) => {
  await startLong(shell);
  await shell.emulateMedia({ media: "print" });
  const before = await boxOf(shell.locator(paraBlock(1)));
  await shell.emulateMedia({ media: "screen" });
  await askElsewhere(shell, LONG_ID, paraId(1));
  await expect(shell.locator(".stickies[data-beside] > .sticky")).toBeVisible();
  await expect(shell.locator(".sticky-lines")).toBeVisible();
  await shell.emulateMedia({ media: "print" });
  await expect(shell.locator(".stickies")).toBeHidden();
  await expect(shell.locator(".sticky-lines")).toBeHidden();
  expect(await boxOf(shell.locator(paraBlock(1)))).toEqual(before);
});

test("the print of an article leaves its stickies out, and the room that the text of a narrow pane makes for them", async ({ shell }) => {
  await startNarrow(shell);
  const pages = async () => (await shell.pdf()).toString("latin1").match(/[/]Type [/]Page[^s]/g)!.length;
  const before = await pages();
  await askMany(shell, LONG_ID, paraId(1), 12);
  expect(await pages()).toBe(before);
  await shell.emulateMedia({ media: "print" });
  await expect(shell.locator(".stickies")).toBeHidden();
  await expect(shell.locator(paraBlock(1))).toBeVisible();
});

test("続けて質問: the question is written in the card, goes with the send key, and its answer comes under the earlier ones", async ({ shell }) => {
  await hold(shell, "sticky_follow_up");
  await shell.goto("/");
  await openSnapshot(shell);
  await askAbout(shell, "詳しく", "#b-102");
  const sticky = card(shell, "詳しく");
  await expect(sticky.locator(".answer")).toHaveText(ANSWERED);
  for (const drop of [() => shell.keyboard.press("Escape"), () => sticky.getByRole("button", { name: "キャンセル" }).click()]) {
    await followUp(sticky).click();
    await expect(followUp(sticky), "one at a time").toHaveCount(0);
    await expect(followUpField(sticky)).toBeFocused();
    await expect(followUpField(sticky)).toHaveValue("");
    await shell.keyboard.type("half");
    await followUpField(sticky).dispatchEvent("keydown", { key: "Escape", isComposing: true });
    await expect(followUpField(sticky)).toHaveValue("half");
    await drop();
    await expect(followUpField(sticky)).toHaveCount(0);
    await expect(doc(shell)).toBeFocused();
  }

  await followUp(sticky).click();
  await expect(sticky.getByRole("button", { name: "送信" })).toBeDisabled();
  await shell.keyboard.press("Control+Enter");
  await shell.keyboard.type("つまり？");
  await shell.keyboard.press("Enter");
  await shell.keyboard.press("Backspace");
  expect(await callsOf(shell, "sticky_follow_up"), "Enter is a new line by default").toEqual([]);
  await shell.keyboard.press("Control+Enter");
  await expect(sticky.getByRole("status")).toHaveText("回答を生成しています…");
  await expect(followUpField(sticky)).toHaveValue("つまり？");
  await expect(followUpField(sticky)).toBeDisabled();
  await expect(followUp(sticky)).toHaveCount(0);
  await expect(doc(shell)).toBeFocused();
  expect(await callsOf(shell, "sticky_follow_up")).toEqual([{ id: 1, question: "つまり？" }]);
  await shell.evaluate(() => window.__e2e.release("sticky_follow_up"));
  await expect(sticky.locator(".answer")).toHaveText([ANSWERED, ANSWERED]);
  await expect(sticky.getByRole("status")).toHaveCount(0);

  await followUp(sticky).click();
  await followUpField(sticky).fill("それで？");
  await sticky.getByRole("button", { name: "送信" }).click();
  await shell.evaluate(() => window.__e2e.release("sticky_follow_up"));
  await expect(sticky.locator(".answer")).toHaveCount(3);
  // Text alone, and the citations of each.
  await expect(sticky.locator(".sticky-quote, .sticky-q, .answer button")).toHaveText([/^Every transaction/, "1", "つまり？", "1", "それで？", "1"]);
  await expect(cards(shell)).toHaveCount(1);
});

test("a follow-up that failed keeps its text through leaving the article, and can be sent again", async ({ app }) => {
  await openSnapshot(app);
  await askAbout(app, "用語", "#b-102");
  const sticky = card(app, "用語");
  await followUp(sticky).click();
  await followUpField(app).fill("the model is down?");
  await app.keyboard.press("Control+Enter");
  await expect(sticky.getByRole("alert")).toHaveText("モデルが空の回答を返しました");
  await expect(followUpField(sticky)).toHaveValue("the model is down?");
  await expect(sticky.locator(".answer"), "with the answer that is there").toHaveCount(1);

  await open(app, LONG_ID);
  await expect(cards(app)).toHaveCount(0);
  await open(app, SNAPSHOT_ID);
  await expect(sticky.getByRole("alert")).toBeVisible();
  await expect(followUpField(sticky)).toHaveValue("the model is down?");
  await expect(followUpField(sticky), "coming back takes no keyboard").not.toBeFocused();
  await modelUp(app);
  await sticky.getByRole("button", { name: "再試行" }).click();
  await expect(sticky.locator(".answer")).toHaveCount(2);
  await expect(app.getByRole("alert")).toHaveCount(0);
});

test("a follow-up not sent yet keeps its text through another window's sticky and leaving the article, and goes with its sticky", async ({ app }) => {
  await openSnapshot(app);
  await askAbout(app, "用語", "#b-102");
  await followUp(card(app, "用語")).click();
  await followUpField(app).fill("half a question");
  await askElsewhere(app, SNAPSHOT_ID, 103);
  await expect(cards(app)).toHaveCount(2);
  await expect(followUpField(cards(app).first())).toHaveValue("half a question");
  await expect(followUpField(app)).toHaveCount(1);
  await open(app, LONG_ID);
  await expect(cards(app)).toHaveCount(0);
  await open(app, SNAPSHOT_ID);
  await expect(followUpField(cards(app).first())).toHaveValue("half a question");
  await invoke(app, "delete_sticky", { id: 1 });
  await expect(cards(app)).toHaveCount(1);
  await expect(followUpField(app)).toHaveCount(0);
  await expect(followUp(app)).toHaveCount(1);
  // Not to the one that gets the id of the sticky that is gone, as SQLite gives it again.
  await askElsewhere(app, SNAPSHOT_ID, 103);
  await expect(cards(app)).toHaveCount(2);
  await followUp(cards(app).last()).click();
  await followUpField(app).fill("on the last");
  await invoke(app, "delete_sticky", { id: 3 });
  await expect(cards(app)).toHaveCount(1);
  expect(await askElsewhere(app, SNAPSHOT_ID, 103, "another")).toMatchObject({ id: 3 });
  await expect(cards(app)).toHaveCount(2);
  await expect(followUpField(app)).toHaveCount(0);
});

test("a follow-up that waits survives leaving the article, and its answer comes to its sticky alone", async ({ shell }) => {
  await hold(shell, "sticky_follow_up");
  await shell.goto("/");
  await openSnapshot(shell);
  await askElsewhere(shell, SNAPSHOT_ID, 102);
  await askElsewhere(shell, SNAPSHOT_ID, 102);
  await expect(cards(shell)).toHaveCount(2);
  for (const q of ["最初の", "次の"]) {
    await followUp(shell).first().click();
    await followUpField(shell).last().fill(q);
    await shell.keyboard.press("Control+Enter");
  }
  await open(shell, LONG_ID);
  await shell.evaluate(() => window.__e2e.release("sticky_follow_up", 1));
  await open(shell, SNAPSHOT_ID);
  await expect(cards(shell).first().locator(".answer")).toHaveCount(2);
  await expect(cards(shell).first().locator(".sticky-q")).toHaveText("最初の");
  await expect(cards(shell).nth(1).getByRole("status"), "in their order as before").toBeVisible();
  await shell.evaluate(() => window.__e2e.release("sticky_follow_up"));
  await expect(cards(shell).nth(1).locator(".answer")).toHaveCount(2);
});

test("a sticky whose follow-up is answered stays in its place among the others", async ({ app }) => {
  await openSnapshot(app);
  await askElsewhere(app, SNAPSHOT_ID, 102);
  await askElsewhere(app, SNAPSHOT_ID, 102);
  await expect(cards(app)).toHaveCount(2);
  // Read again they would be in their order.
  await app.evaluate(() => void (window.__e2eFail = ["list_stickies"]));
  await followUp(app).first().click();
  await followUpField(app).fill("なぜ？");
  await app.keyboard.press("Control+Enter");
  await expect(app.locator(".stickies").getByRole("alert")).toHaveText(/list_stickies failed/);
  await expect(card(app, "用語").locator(".answer")).toHaveCount(3);
  await expect(card(app, "用語").first().locator(".answer")).toHaveCount(2);
});

test("a follow-up to a sticky that another window deleted meanwhile goes without a word", async ({ shell }) => {
  await hold(shell, "sticky_follow_up");
  await shell.goto("/");
  await openSnapshot(shell);
  await askElsewhere(shell, SNAPSHOT_ID, 102);
  await followUp(shell).click();
  await followUpField(shell).fill("なぜ？");
  await shell.keyboard.press("Control+Enter");
  await expect(cards(shell).getByRole("status")).toBeVisible();
  await invoke(shell, "delete_sticky", { id: 1 });
  await expect(cards(shell)).toHaveCount(0);
  await shell.evaluate(() => window.__e2e.release("sticky_follow_up"));
  await askElsewhere(shell, SNAPSHOT_ID, 103);
  await expect(cards(shell)).toHaveCount(1);
  await expect(shell.getByRole("alert")).toHaveCount(0);
});

test("a selection in an answer offers 質問, 詳しく and 用語, and the child comes right below its parent, set in from it, there after a reload too", async ({
  app,
}) => {
  await openSnapshot(app);
  await askAbout(app, "詳しく", "#b-102");
  await askElsewhere(app, SNAPSHOT_ID, 102, "another on the block");
  const parent = card(app, "詳しく");
  await expect(cards(app)).toHaveCount(2);
  const answer = parent.locator(".answer p");
  // A word that the article's bar would offer to save.
  const word = await answer.evaluate((p) => {
    const text = [...p.childNodes].find((n) => n.textContent!.includes("snapshot"))!;
    const r = document.createRange();
    const at = text.textContent!.indexOf("snapshot");
    r.setStart(text, at);
    r.setEnd(text, at + "snapshot".length);
    const box = r.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  });
  await app.mouse.dblclick(word.x, word.y);
  expect(await selected(app)).toBe("snapshot");
  await expect(bar(app).getByRole("button")).toHaveText(["質問", "詳しく", "用語"]);
  await bar(app).getByRole("button", { name: "用語" }).click();
  await expect(bar(app)).toHaveCount(0);
  await expect(child(app, "用語").locator(".answer")).toHaveText(ANSWERED);
  await expect(child(app, "用語").locator(".sticky-quote")).toHaveText("snapshot");
  await askOn(app, "質問", parent);
  await expect(field(app)).toBeFocused();
  await app.keyboard.type("なぜ？");
  await app.keyboard.press("Control+Enter");
  await expect(child(app, "質問").locator(".answer")).toHaveText(ANSWERED);

  const [, , term, question] = await asked(app);
  expect(term).toMatchObject({ articleId: SNAPSHOT_ID, parent: 1, kind: "term", quote: "snapshot", question: "" });
  expect(question).toMatchObject({ parent: 1, kind: "question", question: "なぜ？" });
  const said = (await answer.textContent())!;
  expect(question.quote, "without the number of its citation").toBe(said.replace("説明です 1。", "説明です 。"));
  expect(said).toContain("説明です 1。");

  // Their headers, and so the order: the parent, its children, then the other on the block.
  const order = ["詳しく", "用語(回答から)", "質問(回答から)", "用語"];
  await expect(cards(app).locator(".sticky-kind")).toHaveText(order);
  const below = async () => {
    const [p, first, second, other] = await Promise.all([0, 1, 2, 3].map((i) => boxOf(cards(app).nth(i))));
    expect(first.y - (p.y + p.height)).toBeCloseTo(10, 0);
    expect(second.y - (first.y + first.height)).toBeCloseTo(10, 0);
    expect(other.y - (second.y + second.height)).toBeGreaterThan(9);
    expect([first.x, second.x, other.x].map((x) => x - p.x)).toEqual([12, 12, 0]);
    expect(first.x + first.width, "to the same edge").toBeCloseTo(p.x + p.width, 0);
  };
  await below();
  await app.reload();
  await open(app, SNAPSHOT_ID);
  await expect(cards(app).locator(".sticky-kind")).toHaveText(order);
  await below();
});

test("a child of a child is set in further, down to the third", async ({ app }) => {
  await openSnapshot(app);
  await askElsewhere(app, SNAPSHOT_ID, 102);
  for (const parent of [1, 2, 3, 4]) {
    await askElsewhere(app, SNAPSHOT_ID, null, `on ${parent}`, parent);
  }
  await expect(cards(app)).toHaveCount(5);
  const x = async (nth: number) => (await boxOf(cards(app).nth(nth))).x - (await boxOf(cards(app).first())).x;
  expect(await Promise.all([1, 2, 3, 4].map(x))).toEqual([12, 24, 36, 36]);
});

test("a selection is of an answer only from within one: what comes after it, and the buttons below it, are none of it", async ({ app }) => {
  await openSnapshot(app);
  await askAbout(app, "詳しく", "#b-102");
  const sticky = card(app, "詳しく");
  await followUp(sticky).click();
  await followUpField(app).fill("つまり？");
  await app.keyboard.press("Control+Enter");
  await expect(sticky.locator(".answer")).toHaveCount(2);
  const [first, second, question] = [sticky.locator(".answer p").first(), sticky.locator(".answer p").nth(1), sticky.locator(".sticky-q")];
  const mid = async (l: Locator): Promise<[number, number]> => {
    const b = await boxOf(l);
    return [b.x + 30, b.y + 10];
  };
  for (const [from, to] of [
    [first, second],
    [first, question],
    [question, second],
    [second, first],
  ]) {
    await dragTo(app, await mid(from), await mid(to));
    expect(await selected(app)).not.toBe("");
    await expect(bar(app)).toHaveCount(0);
  }
  await first.click({ clickCount: 3 });
  await expect(bar(app), "a triple click ends where the answer does").toBeVisible();
  // Past the last line, over 続けて質問 to the card's edge.
  await dragAnswer(app, second, 45);
  await bar(app).getByRole("button", { name: "詳しく" }).click();
  await expect(child(app, "詳しく").locator(".answer")).toHaveText(ANSWERED);
  const { quote, parent } = (await asked(app)).at(-1)!;
  expect(quote).toMatch(/^選んだ箇所の説明です 。.*そのままです。$/);
  expect(parent, "the second answer's").toBe(2);
});

test("the bar of an answer goes as the card is pressed or the column scrolls, and comes as the same is selected or extended again", async ({ shell }) => {
  await startLong(shell);
  await scrollTo(shell, paraBlock(4), "start");
  await askAbout(shell, "詳しく", paraBlock(8));
  const sticky = card(shell, "詳しく");
  await expect(sticky.locator(".answer")).toBeVisible();
  const answer = sticky.locator(".answer p");
  await dragAnswer(shell, answer);
  await expect(bar(shell)).toBeVisible();
  const whole = await selected(shell);
  // A scroll would take the bar away too.
  for (const scrolls of [true, false]) {
    const before = await scrollTop(shell);
    await sticky.locator(".cite").click();
    await expect.poll(async () => (await scrollTop(shell)) !== before).toBe(scrolls);
    expect(await selected(shell)).toBe(whole);
    await expect(bar(shell)).toHaveCount(0);
  }
  await dragAnswer(shell, answer);
  await expect(bar(shell)).toBeVisible();
  await doc(shell).evaluate((el) => (el.scrollTop += 20));
  await expect(bar(shell)).toHaveCount(0);
  await selectAgain(shell, whole);
  await doc(shell).evaluate((el) => (el.scrollTop += 5));
  await expect(bar(shell)).toHaveCount(0);
  await shell.keyboard.press("Shift+ArrowLeft");
  await expect(bar(shell)).toBeVisible();
  await shell.keyboard.press("Shift+ArrowLeft");
  await bar(shell).getByRole("button", { name: "詳しく" }).click();
  await expect(child(shell, "詳しく")).toBeVisible();
  expect((await asked(shell)).at(-1)!.quote).toMatch(/書き換わった出典 \[3\] はそのままで$/);
});

test("a question on an answer keeps its text as one on the article does, and Esc and キャンセル drop it", async ({ app }) => {
  await openSnapshot(app);
  await askAbout(app, "詳しく", "#b-102");
  const parent = card(app, "詳しく");
  for (const drop of [() => app.keyboard.press("Escape"), () => child(app, "質問").getByRole("button", { name: "キャンセル" }).click()]) {
    await askOn(app, "質問", parent);
    await expect(field(app)).toBeFocused();
    await drop();
    await expect(cards(app)).toHaveCount(1);
    await expect(doc(app)).toBeFocused();
  }
  await askOn(app, "質問", parent);
  await field(app).fill("the model is down?");
  await app.keyboard.press("Control+Enter");
  await expect(child(app, "質問").getByRole("alert")).toBeVisible();
  await open(app, LONG_ID);
  await expect(cards(app)).toHaveCount(0);
  await open(app, SNAPSHOT_ID);
  await expect(child(app, "質問").getByRole("alert")).toBeVisible();
  await expect(field(app)).toHaveValue("the model is down?");
  await modelUp(app);
  await child(app, "質問").getByRole("button", { name: "再試行" }).click();
  await expect(child(app, "質問").locator(".answer")).toHaveText(ANSWERED);
  expect((await asked(app)).map((c) => c.parent)).toEqual([null, 1, 1]);
});

test("deleting a sticky says that those made from its answers stay, and they do, with what is being written", async ({ app }) => {
  await openSnapshot(app);
  await askAbout(app, "詳しく", "#b-102");
  await askOn(app, "用語", card(app, "詳しく"));
  await expect(child(app, "用語").locator(".answer")).toBeVisible();
  await askOn(app, "質問", card(app, "詳しく"));
  await field(app).fill("half a question");
  const dialog = app.getByRole("alertdialog", { name: "付箋を削除しますか？" });
  await child(app, "用語").getByRole("button", { name: "付箋を削除" }).click();
  await expect(dialog).toContainText("元に戻せません。");
  await expect(dialog).not.toContainText("回答から作った付箋は残ります。");
  await dialog.getByRole("button", { name: "キャンセル" }).click();
  const { x } = await boxOf(card(app, "詳しく"));
  await card(app, "詳しく").getByRole("button", { name: "付箋を削除" }).click();
  await expect(dialog).toContainText("回答から作った付箋は残ります。");
  await dialog.getByRole("button", { name: "削除" }).click();
  await expect(cards(app).locator(".sticky-kind")).toHaveText(["用語", "質問"]);
  expect((await boxOf(card(app, "用語"))).x).toBe(x);
  await expect(field(app)).toHaveValue("half a question");
  await field(app).press("Control+Enter");
  await expect(card(app, "質問").locator(".answer")).toHaveText(ANSWERED);
  expect((await asked(app)).at(-1)).toMatchObject({ blockId: 102, parent: null, question: "half a question" });
});

test("a question on an answer whose sticky goes while it waits can be sent again, if it fails, as one on the article", async ({ shell }) => {
  await hold(shell, "sticky_ask");
  await shell.goto("/");
  await openSnapshot(shell);
  const answer = release(shell, "sticky_ask");
  const failing = (cmds: string[]) => shell.evaluate((cmds) => void (window.__e2eFail = cmds), cmds);
  await askAbout(shell, "詳しく", "#b-102");
  await answer();
  await askOn(shell, "質問", card(shell, "詳しく"));
  await field(shell).fill("なぜ？");
  await shell.keyboard.press("Control+Enter");
  await invoke(shell, "delete_sticky", { id: 1 });
  await expect(cards(shell).locator(".sticky-kind")).toHaveText(["質問"]);
  await expect(cards(shell).getByRole("status")).toBeVisible();
  const other = askElsewhere(shell, SNAPSHOT_ID, 102);
  await shell.waitForFunction(() => window.__e2e.calls.filter((c) => c.cmd === "sticky_ask").length === 3);
  await shell.evaluate(() => window.__e2e.release("sticky_ask", -1));
  expect(await other, "the ids of the one that is gone").toMatchObject({ id: 1, messages: [{ id: 1 }] });
  await expect(cards(shell)).toHaveCount(2);
  await failing(["sticky_ask"]);
  await answer();
  await expect(card(shell, "質問").getByRole("alert")).toHaveText(/sticky_ask failed/);
  await failing([]);
  await card(shell, "質問").getByRole("button", { name: "再試行" }).click();
  await answer();
  await expect(card(shell, "質問").locator(".answer")).toHaveText(ANSWERED);
  expect((await asked(shell)).map((c) => [c.blockId, c.parent])).toEqual([
    [102, null],
    [102, 1],
    [102, null],
    [102, null],
  ]);
});

/** The article's cards in a wide pane: one on a block, and the one that was asked last, with no room for both at their blocks' heights. */
async function startCrowded(shell: Page) {
  await hold(shell, "sticky_ask", "sticky_follow_up");
  await shell.setViewportSize({ width: 1500, height: 1400 });
  await startLong(shell);
  await scrollTo(shell, paraBlock(31), "center");
  await askAbout(shell, "用語", paraBlock(31));
  // Another window's, which nothing here folds: one asked here before would fold for the one opened on the text after it,
  // and one unfolded here stays where it is. It is answered first, which gives the two the ids of their blocks' order.
  const other = askElsewhere(shell, LONG_ID, paraId(30));
  await shell.waitForFunction(() => window.__e2e.calls.filter((c) => c.cmd === "sticky_ask").length === 2);
  await shell.evaluate(() => window.__e2e.release("sticky_ask", -1));
  expect(await other).toMatchObject({ id: 1 });
  await release(shell, "sticky_ask")();
  await expect(cards(shell).locator(".answer")).toHaveCount(2);
  await frames(shell);
  const off = async (nth: number, block: number) => (await boxOf(cards(shell).nth(nth))).y - (await boxOf(shell.locator(paraBlock(block)))).y;
  expect(await off(0, 30), "gave way").toBeLessThan(-20);
  expect(Math.abs(await off(1, 31))).toBeLessThan(1);
  return off;
}

/** A thing whose place is to stay, as it opens, is written in, is answered or not: the cards up to it, the text and the view. */
async function staysStill(shell: Page, nth: number, steps: (() => Promise<unknown>)[], block = 30) {
  const state = async () => ({
    cards: await Promise.all(Array.from({ length: nth + 1 }, async (_, i) => Math.round((await boxOf(cards(shell).nth(i))).y))),
    text: Math.round((await boxOf(shell.locator(paraBlock(block)))).y),
    top: await scrollTop(shell),
  });
  const before = await state();
  for (const [i, step] of steps.entries()) {
    await step();
    await frames(shell);
    expect(await state(), `after step ${i}`).toEqual(before);
  }
}

test("a child, and a follow-up, move neither the cards above them nor the text as they open, are answered or are closed: the one that is pinned below gives way", async ({
  shell,
}) => {
  const off = await startCrowded(shell);
  const parent = cards(shell).first();
  await staysStill(shell, 0, [
    () => askOn(shell, "質問", parent),
    () => expect(field(shell)).toBeFocused(),
    () => shell.keyboard.type("one\ntwo"),
    () => shell.keyboard.press("Escape"),
    () => expect(cards(shell)).toHaveCount(2),
  ]);
  expect(Math.abs(await off(1, 31)), "the pinned one is back").toBeLessThan(1);
  await staysStill(shell, 0, [
    () => followUp(parent).click(),
    () => shell.keyboard.type("one"),
    () => parent.getByRole("button", { name: "キャンセル" }).click(),
    () => followUp(parent).click(),
    () => shell.keyboard.type("one"),
    () => shell.keyboard.press("Control+Enter"),
    release(shell, "sticky_follow_up"),
    () => expect(parent.locator(".answer")).toHaveCount(2),
    // And then a child of it, in the room of what is there.
    () => askOn(shell, "用語", parent, 1),
    () => expect(child(shell, "用語").getByRole("status")).toBeVisible(),
    release(shell, "sticky_ask"),
    () => expect(child(shell, "用語").locator(".answer")).toBeVisible(),
  ]);
  expect(await off(2, 31), "as far as it has to").toBeGreaterThan(20);
  const [p, c, last] = await Promise.all([0, 1, 2].map((i) => boxOf(cards(shell).nth(i))));
  expect(c.y - (p.y + p.height)).toBeCloseTo(10, 0);
  expect(last.y - (c.y + c.height)).toBeCloseTo(10, 0);
  // A second child, below the first, does not move what is above it.
  await staysStill(shell, 1, [
    () => askOn(shell, "詳しく", parent),
    release(shell, "sticky_ask"),
    () => expect(child(shell, "詳しく").locator(".answer")).toBeVisible(),
  ]);
  await expect(cards(shell).locator(".sticky-kind")).toHaveText(["用語", "用語(回答から)", "詳しく(回答から)", "用語"]);

  // Asked on the text again, it has its block's height, and those above give way to that.
  await scrollTo(shell, paraBlock(32), "center");
  await askAbout(shell, "質問", paraBlock(32));
  expect(Math.abs(await off(4, 32))).toBeLessThan(1);
  await unfold(parent);
  await unfold(child(shell, "用語"));
  // Then a question on the first child, and one in it, move neither it nor its parent, held as the reader unfolded them.
  // Scrolled to leave the question's field in view.
  const first = await boxOf(child(shell, "用語"));
  await doc(shell).evaluate((el, by) => el.scrollBy(0, by), first.y - 200);
  await frames(shell);
  await staysStill(shell, 1, [
    () => askOn(shell, "質問", child(shell, "用語")),
    () => expect(child(shell, "質問").getByRole("textbox")).toBeFocused(),
    () => shell.keyboard.type("one\ntwo\nthree"),
    () => shell.keyboard.press("Escape"),
    () => followUp(child(shell, "用語")).click(),
    () => shell.keyboard.type("one\ntwo\nthree"),
  ]);
});

test("a card asked on in a narrow pane is laid out as any in the column as the pane widens, and the pinned one stays at its block", async ({ shell }) => {
  const off = await startCrowded(shell);
  await shell.setViewportSize({ width: 1000, height: 1400 });
  await frames(shell);
  expect(await doc(shell).evaluate((el) => el.clientWidth)).toBeLessThan(720);
  await followUp(cards(shell).first()).click();
  await shell.keyboard.type("one\ntwo\nthree\nfour\nfive");
  await shell.setViewportSize({ width: 1500, height: 1400 });
  await frames(shell);
  await frames(shell);
  expect(Math.abs(await off(1, 31))).toBeLessThan(1);
  const [held, pinned] = await Promise.all([0, 1].map((i) => boxOf(cards(shell).nth(i))));
  expect(pinned.y - (held.y + held.height)).toBeGreaterThanOrEqual(9);
});

test("cards that the pinned one has given way to stay as others are asked on, and it stays too", async ({ shell }) => {
  const off = await startCrowded(shell);
  // With all in view.
  await shell.setViewportSize({ width: 1500, height: 1800 });
  for (const block of [29, 33]) {
    await Promise.all([askElsewhere(shell, LONG_ID, paraId(block)), release(shell, "sticky_ask")()]);
  }
  await expect(cards(shell)).toHaveCount(4);
  const [above, held, pinned, below] = [0, 1, 2, 3].map((i) => cards(shell).nth(i));
  await above.evaluate((el) => el.scrollIntoView());
  await followUp(held).click();
  await shell.keyboard.type("one");
  await shell.keyboard.press("Control+Enter");
  await release(shell, "sticky_follow_up")();
  await expect(held.locator(".answer")).toHaveCount(2);
  const down = await off(2, 31);
  expect(down, "gives way").toBeGreaterThan(20);
  const write = [() => shell.keyboard.type("one\ntwo"), () => shell.keyboard.press("Escape")];
  await staysStill(shell, 2, [() => followUp(pinned).click(), ...write]);
  await staysStill(shell, 3, [() => askOn(shell, "質問", below), ...write]);
  const at = (await boxOf(held)).y;
  await staysStill(shell, 0, [() => followUp(above).click(), async () => expect((await boxOf(held)).y).toBeGreaterThan(at + 20), ...write]);
  expect((await boxOf(held)).y).toBe(at);
  expect(await off(2, 31)).toBe(down);
});

test("a child is right below its parent where that stays far above its block, as what was between them goes", async ({ shell }) => {
  await startCrowded(shell);
  await shell.setViewportSize({ width: 1500, height: 1800 });
  await Promise.all([askMany(shell, LONG_ID, paraId(30), 2), expect.poll(() => release(shell, "sticky_ask")().then(() => cards(shell).count())).toBe(4)]);
  const parent = cards(shell).first();
  await parent.evaluate((el) => el.scrollIntoView());
  await askOn(shell, "用語", parent);
  await release(shell, "sticky_ask")();
  await expect(child(shell, "用語").locator(".answer")).toBeVisible();
  for (const id of [3, 4]) {
    await invoke(shell, "delete_sticky", { id });
  }
  await expect(cards(shell)).toHaveCount(3);
  await frames(shell);
  const { y, height } = await boxOf(parent);
  expect(y + height).toBeLessThan((await boxOf(shell.locator(paraBlock(30)))).y - 100);
  expect((await boxOf(child(shell, "用語"))).y - y - height).toBeCloseTo(10, 0);
});

test("a drag in an answer that ends on a question that waits below it offers the bar", async ({ shell }) => {
  await hold(shell, "sticky_follow_up");
  await startLong(shell);
  await scrollTo(shell, paraBlock(10), "center");
  await askAbout(shell, "詳しく", paraBlock(10));
  const sticky = card(shell, "詳しく");
  await expect(sticky.locator(".answer")).toBeVisible();
  await followUp(sticky).click();
  await followUpField(sticky).fill("なぜ？");
  await shell.keyboard.press("Control+Enter");
  await expect(followUpField(sticky)).toBeDisabled();
  const p = await boxOf(sticky.locator(".answer p"));
  const f = await boxOf(followUpField(sticky));
  await dragTo(shell, [p.x + 1, p.y + 8], [f.x + 20, f.y + 10]);
  expect(await selected(shell)).toMatch(ANSWERED);
  await expect(bar(shell).getByRole("button", { name: "用語", exact: true })).toBeVisible();
});

/** Four cards, the last asked last, in a view tall enough for all: those before it give way. */
async function startTall(shell: Page) {
  await hold(shell, "sticky_ask", "sticky_follow_up");
  await shell.setViewportSize({ width: 1500, height: 2400 });
  await startLong(shell);
  await scrollTo(shell, paraBlock(31), "center");
  await askAbout(shell, "用語", paraBlock(31));
  // As in `startCrowded`, another window's, answered first.
  for (const [i, block] of [28, 29, 30].entries()) {
    const other = askElsewhere(shell, LONG_ID, paraId(block));
    await shell.waitForFunction((n) => window.__e2e.calls.filter((c) => c.cmd === "sticky_ask").length === n, i + 2);
    await shell.evaluate(() => window.__e2e.release("sticky_ask", -1));
    expect(await other).toMatchObject({ id: i + 1 });
  }
  await release(shell, "sticky_ask")();
  await expect(cards(shell).locator(".answer")).toHaveCount(4);
  await frames(shell);
}

test("cards asked on stay where they were as what is asked on them is closed, in any order, and as the pinned one goes", async ({ shell }) => {
  await startTall(shell);
  const at = (i: number) => cards(shell).nth(i);
  const cancel = (card: Locator) => card.getByRole("button", { name: "キャンセル" }).click();
  await followUp(at(1)).click();
  await followUp(at(2)).click();
  await staysStill(shell, 2, [() => cancel(at(1)), () => cancel(at(2))], 31);

  await askOn(shell, "質問", at(1));
  await followUp(at(3)).click();
  await staysStill(shell, 1, [() => cancel(child(shell, "質問")), () => expect(cards(shell)).toHaveCount(4)], 31);
  await cancel(at(2));

  await askAbout(shell, "質問", paraBlock(32));
  await unfold(at(1));
  await followUp(at(1)).click();
  await staysStill(shell, 1, [() => cancel(cards(shell).last())], 31);
  await cancel(at(1));
  await askAbout(shell, "用語", paraBlock(32));
  await release(shell, "sticky_ask")();
  await expect(cards(shell)).toHaveCount(5);
  await unfold(at(1));
  await frames(shell);
  await followUp(at(1)).click();
  await staysStill(shell, 1, [() => invoke(shell, "delete_sticky", { id: 5 }), () => expect(cards(shell)).toHaveCount(4)], 31);
});

for (const width of [1200, 1500]) {
  test(`at the article's end a question that is sent, and its answer, take up no view, ${width} wide`, async ({ shell }) => {
    await hold(shell, "sticky_ask", "sticky_follow_up");
    await shell.setViewportSize({ width, height: 800 });
    await startLong(shell);
    await Promise.all([askMany(shell, LONG_ID, paraId(79), 2), expect.poll(() => release(shell, "sticky_ask")().then(() => cards(shell).count())).toBe(2)]);
    const last = cards(shell).nth(1);
    const toEnd = async () => {
      await doc(shell).evaluate((el) => (el.scrollTop = el.scrollHeight));
      await frames(shell);
    };
    const send = async (input: Locator, card: Locator, answer: () => Promise<unknown>) => {
      await toEnd();
      await input.fill("なぜ？");
      await staysStill(
        shell,
        1,
        [
          () => shell.keyboard.press("Control+Enter"),
          () => expect(card.getByRole("status")).toBeVisible(),
          answer,
          () => expect(card.getByRole("status")).toHaveCount(0),
        ],
        79,
      );
    };
    await toEnd();
    await followUp(last).click();
    await send(followUpField(last), last, release(shell, "sticky_follow_up"));
    await expect(last.locator(".answer")).toHaveCount(2);
    await toEnd();
    await askOn(shell, "質問", last, 1);
    await send(field(shell), child(shell, "質問"), release(shell, "sticky_ask"));
    await expect(child(shell, "質問").locator(".answer")).toBeVisible();
  });
}

test("a sticky that gets the id of the pinned one, which is gone, is not pinned", async ({ shell }) => {
  const off = await startCrowded(shell);
  await invoke(shell, "delete_sticky", { id: 2 });
  await expect(cards(shell)).toHaveCount(1);
  await frames(shell);
  expect(Math.abs(await off(0, 30))).toBeLessThan(1);
  await staysStill(shell, 0, [
    async () => {
      const [other] = await Promise.all([askElsewhere(shell, LONG_ID, paraId(31)), release(shell, "sticky_ask")()]);
      expect(other).toMatchObject({ id: 2 });
    },
    () => expect(cards(shell)).toHaveCount(2),
  ]);
});

test("a question on an answer whose sticky goes is at its block's height, as far as the pinned one lets it", async ({ shell }) => {
  const off = await startCrowded(shell);
  await askOn(shell, "質問", cards(shell).first());
  await invoke(shell, "delete_sticky", { id: 1 });
  await expect(cards(shell).locator(".sticky-kind")).toHaveText(["質問", "用語"]);
  await frames(shell);
  expect(Math.abs(await off(1, 31))).toBeLessThan(1);
  const [draft, pinned] = [await boxOf(cards(shell).first()), await boxOf(cards(shell).nth(1))];
  expect(pinned.y - (draft.y + draft.height)).toBeCloseTo(10, 0);
});

test("a child, and a follow-up, of the card that is pinned leave it and the ones above it where they are", async ({ shell }) => {
  const off = await startCrowded(shell);
  await staysStill(shell, 1, [
    () => askOn(shell, "質問", cards(shell).nth(1)),
    () => shell.keyboard.type("one\ntwo"),
    () => shell.keyboard.press("Control+Enter"),
    release(shell, "sticky_ask"),
    () => expect(child(shell, "質問").locator(".answer")).toBeVisible(),
    () => followUp(cards(shell).nth(1)).click(),
    () => shell.keyboard.type("one"),
    () => shell.keyboard.press("Escape"),
  ]);
  expect(Math.abs(await off(1, 31))).toBeLessThan(1);
});

test("in a narrow pane a child is right below its parent, and neither it nor a follow-up moves the text or the card above it", async ({ shell }) => {
  await hold(shell, "sticky_ask", "sticky_follow_up");
  await startNarrow(shell);
  await shell.setViewportSize({ width: 1200, height: 1300 });
  await scrollTo(shell, paraBlock(39), "start");
  await askAbout(shell, "用語", paraBlock(40));
  await release(shell, "sticky_ask")();
  const parent = card(shell, "用語");
  await expect(parent.locator(".answer")).toBeVisible();
  const between = async (block: number, above: Locator) => {
    const [b, c] = [await boxOf(shell.locator(paraBlock(block))), await boxOf(above)];
    return b.y - (c.y + c.height);
  };
  const gap = await between(41, parent);
  const below = async (kind: "質問" | "詳しく") => {
    const [p, c] = [await boxOf(parent), await boxOf(child(shell, kind))];
    expect(c.y - (p.y + p.height)).toBeCloseTo(10, 0);
    expect(c.x - p.x).toBe(12);
    expect(Math.abs((await between(41, child(shell, kind))) - gap), "the text below gives way").toBeLessThan(1);
  };
  await staysStill(
    shell,
    0,
    [
      () => askOn(shell, "質問", parent),
      () => below("質問"),
      () => shell.keyboard.type("one two"),
      () => shell.keyboard.press("Escape"),
      () => expect(cards(shell)).toHaveCount(1),
      () => followUp(parent).click(),
      () => shell.keyboard.type("one"),
      () => parent.getByRole("button", { name: "キャンセル" }).click(),
      () => followUp(parent).click(),
      () => shell.keyboard.type("one"),
      () => shell.keyboard.press("Control+Enter"),
      release(shell, "sticky_follow_up"),
      () => expect(parent.locator(".answer")).toHaveCount(2),
      () => askOn(shell, "詳しく", parent),
      () => below("詳しく"),
      release(shell, "sticky_ask"),
      () => expect(child(shell, "詳しく").locator(".answer")).toBeVisible(),
      () => below("詳しく"),
    ],
    39,
  );
});

test("a follow-up, or a child, that opens below the view moves it no further than shows it, and gives the view back as it is closed", async ({ shell }) => {
  await startNarrow(shell);
  await scrollTo(shell, paraBlock(40), "center");
  await askAbout(shell, "用語", paraBlock(40));
  const sticky = card(shell, "用語");
  await expect(sticky.locator(".answer")).toBeVisible();
  await sticky.evaluate((el) => el.scrollIntoView({ block: "end" }));
  await frames(shell);
  const top = await scrollTop(shell);
  const end = async (l: Locator) => {
    const [b, view] = [await boxOf(l), await boxOf(doc(shell))];
    return b.y + b.height - (view.y + view.height);
  };
  for (const [openIt, on] of [
    [() => followUp(sticky).click(), sticky],
    [() => askOn(shell, "質問", sticky), child(shell, "質問")],
  ] as const) {
    await openIt();
    await expect(on.getByRole("textbox")).toBeFocused();
    await expect(on.getByRole("textbox")).toBeInViewport({ ratio: 1 });
    expect(await scrollTop(shell)).toBeGreaterThan(top + 20);
    expect(Math.abs(await end(on)), "to the card's edge").toBeLessThan(2);
    await shell.keyboard.press("Escape");
    await expect(on.getByRole("textbox")).toHaveCount(0);
    expect(await scrollTop(shell)).toBe(top);
  }
});

const ANIMALS =
  "Ants build bridges of their own bodies. Bees dance to say where the flowers are. Crows remember the faces of people who were unkind to them. Dolphins call each other by name. Elephants mourn their dead for days.";

/** The passages marked in the text and in answers, as a quote is taken: without the text of buttons, whitespace as one space. */
const marked = (page: Page) =>
  page.evaluate(() =>
    [...(CSS.highlights.get("sticky") ?? [])].map((r) => {
      const text = (r as Range).cloneContents();
      text.querySelectorAll("button").forEach((b) => b.remove());
      return text.textContent.replace(/\s+/g, " ").trim();
    }),
  );
const quotes = async (page: Page) => (await asked(page)).map((c) => c.quote.replace(/\s+/g, " "));

/** The lines from the text to the cards, each as its two ends in the page. */
const lines = (page: Page) =>
  page.locator(".sticky-lines").evaluate((svg) => {
    const o = svg.getBoundingClientRect();
    const n = "(-?[\\d.]+(?:e-?\\d+)?)";
    const each = new RegExp(`M${n} ${n}C${n} ${n} ${n} ${n} ${n} ${n}`, "g");
    return [...(svg.querySelector("path")!.getAttribute("d") ?? "").matchAll(each)].map((m) => ({
      from: { x: o.left + Number(m[1]), y: o.top + Number(m[2]) },
      to: { x: o.left + Number(m[7]), y: o.top + Number(m[8]) },
    }));
  });

const foldedOnes = (page: Page) => cards(page).evaluateAll((els) => els.map((el) => el.hasAttribute("data-folded")));

test("a passage is marked in the text, and beside it a line goes from the text's edge at its first line to the card's", async ({ shell }) => {
  await shell.setViewportSize({ width: 1500, height: 900 });
  // Of no sentence twice, which would have the first marked.
  await startLong(shell, 1, `['paragraph', '${ANIMALS}', null]`);
  await scrollTo(shell, paraBlock(80), "center");
  const p = shell.locator(`${paraBlock(80)} p`);
  const { x, y } = await boxOf(p);
  const line = await p.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
  // From the second line into the third.
  await dragTo(shell, [x + 150, y + line * 1.5], [x + 300, y + line * 2.5]);
  await bar(shell).getByRole("button", { name: "詳しく", exact: true }).click();
  await expect(card(shell, "詳しく").locator(".answer")).toHaveText(ANSWERED);
  const [quote] = await quotes(shell);
  expect(quote.length).toBeGreaterThan(60);
  expect(await marked(shell)).toEqual([quote]);
  // One whose passage is not in its block's text any more has its line from the block's first.
  await askElsewhere(shell, LONG_ID, paraId(24), "not in the text");
  await expect(cards(shell)).toHaveCount(2);
  await frames(shell);
  expect(await marked(shell)).toEqual([quote]);

  const text = await boxOf(shell.locator(".blocks"));
  const first = await shell.evaluate(() => {
    const [range] = [...(CSS.highlights.get("sticky") ?? [])].map((r) => r as Range);
    const r = [...range.getClientRects()].find((r) => r.width > 0)!;
    return { top: r.top, bottom: r.bottom, left: r.left };
  });
  expect(first.left, "not at the paragraph's start").toBeGreaterThan(x + 50);
  const other = await boxOf(shell.locator(paraBlock(24)));
  const ends = await lines(shell);
  expect(ends).toHaveLength(2);
  // Down the article: the one on the block before first.
  for (const [i, from] of [{ top: other.y, bottom: other.y + line }, first].entries()) {
    const sticky = cards(shell).nth(i);
    const head = await boxOf(sticky.locator(".sticky-h"));
    expect(ends[i].from.x).toBeCloseTo(text.x + text.width, 0);
    expect(ends[i].from.y).toBeGreaterThan(from.top);
    expect(ends[i].from.y).toBeLessThan(from.bottom);
    expect(ends[i].to.x).toBeCloseTo((await boxOf(sticky)).x, 0);
    expect(ends[i].to.y).toBeGreaterThan(head.y);
    expect(ends[i].to.y).toBeLessThan(head.y + head.height);
  }
});

test("under its block a card has no line, and its passage is marked; beside the text it has one", async ({ shell }) => {
  await startNarrow(shell, 3);
  await scrollTo(shell, paraBlock(10), "center");
  await askAbout(shell, "用語", paraBlock(10));
  await expect(card(shell, "用語").locator(".answer")).toBeVisible();
  expect(await marked(shell)).toEqual(await quotes(shell));
  expect(await lines(shell)).toEqual([]);
  await shell.setViewportSize({ width: 1700, height: 800 });
  await frames(shell);
  expect(await lines(shell)).toHaveLength(1);
  expect(await marked(shell)).toEqual(await quotes(shell));
});

test("a passage whose sentence is shown in translation and back is marked again, though nothing changes size", async ({ shell }) => {
  await shell.setViewportSize({ width: 1500, height: 900 });
  await startLong(shell, 1, "", true);
  await shell.locator(".docbar").getByRole("button", { name: "原文", exact: true }).click();
  await scrollTo(shell, paraBlock(10), "center");
  await askAbout(shell, "詳しく", paraBlock(10));
  await expect(card(shell, "詳しく").locator(".answer")).toBeVisible();
  const passage = await quotes(shell);
  expect(await marked(shell)).toEqual(passage);
  const flip = async (shown: number) => {
    await shell.locator(`${paraBlock(10)} .mk`).click();
    await expect(shell.locator(`${paraBlock(10)} .sent.tr`)).toHaveCount(shown);
    await frames(shell);
  };
  await flip(1);
  await flip(0);
  expect(await marked(shell)).toEqual(passage);
  const [{ from }] = await lines(shell);
  const p = await boxOf(shell.locator(`${paraBlock(10)} p`));
  expect(from.y).toBeGreaterThan(p.y);
  expect(from.y).toBeLessThan(p.y + p.height);
});

test("a child's passage is marked in the answer it is from, and a mark goes with its sticky, its answer and the Reader", async ({ shell }) => {
  await shell.setViewportSize({ width: 1500, height: 900 });
  await startLong(shell);
  await scrollTo(shell, paraBlock(10), "center");
  await askAbout(shell, "詳しく", paraBlock(10));
  const parent = card(shell, "詳しく");
  await expect(parent.locator(".answer")).toBeVisible();
  await askOn(shell, "用語", parent);
  await expect(child(shell, "用語").locator(".answer")).toBeVisible();
  const [root, of] = await quotes(shell);
  expect(of, "without the number of its citation").not.toMatch(/です\s*1。/);
  expect(await marked(shell)).toEqual([root, of]);
  expect(await lines(shell), "a child has none").toHaveLength(1);
  await parent.getByRole("button", { name: "付箋をたたむ" }).click();
  await frames(shell);
  expect(await marked(shell)).toEqual([root]);
  await unfold(parent);
  await frames(shell);
  expect(await marked(shell)).toEqual([root, of]);
  await invoke(shell, "delete_sticky", { id: 2 });
  await expect(cards(shell)).toHaveCount(1);
  await expect.poll(() => marked(shell)).toEqual([root]);
  await open(shell, SNAPSHOT_ID);
  expect(await marked(shell)).toEqual([]);
  await open(shell, LONG_ID);
  await expect.poll(() => marked(shell)).toEqual([root]);
});

test("a term alone in a table's cell is marked there, not where it is a word of a later cell", async ({ shell }) => {
  await shell.setViewportSize({ width: 1500, height: 900 });
  const rows = [
    ["Primitive", "Use"],
    ["lock", "Guard a resource with a lock."],
  ];
  await startLong(shell, 1, `['table', ${JSON.stringify(rows.flat().join(" "))}, null, { rows: ${JSON.stringify(rows)} }]`);
  await askElsewhere(shell, LONG_ID, paraId(80), "lock");
  await expect(cards(shell)).toHaveCount(1);
  await frames(shell);
  const at = await shell.evaluate(() => [...(CSS.highlights.get("sticky") ?? [])].map((r) => (r as Range).startContainer.parentElement!.textContent));
  expect(at).toEqual(["lock"]);
});

test("a passage over two paragraphs is marked over both, and the text's DOM is as it was", async ({ shell }) => {
  await shell.setViewportSize({ width: 1500, height: 900 });
  await startLong(shell);
  await scrollTo(shell, paraBlock(10), "center");
  const html = () => shell.locator(".blocks").evaluate((el) => el.innerHTML.replace(/ style="[^"]*"/g, ""));
  const before = await html();
  await drag(shell, paraBlock(10), paraBlock(11));
  await bar(shell).getByRole("button", { name: "詳しく", exact: true }).click();
  await expect(card(shell, "詳しく").locator(".answer")).toBeVisible();
  await frames(shell);
  // The two paragraphs' text runs on, with nothing between them.
  const bare = (t: string) => t.replace(/\s+/g, "");
  expect((await marked(shell)).map(bare)).toEqual([bare(para(10) + para(11))]);
  await shell.evaluate(() => getSelection()!.removeAllRanges());
  expect(await html()).toBe(before);
});

test("each Reader of an article marks its passages", async ({ shell }) => {
  await makeLong(shell);
  await shell.setViewportSize({ width: 1900, height: 900 });
  const root = { kind: "split", id: 90, dir: "row", children: [longPane(1), longPane(3)], sizes: [0.5, 0.5] };
  await shell.addInitScript((l) => localStorage.setItem("lattice.layout", l), JSON.stringify({ root, focused: 3 }));
  await shell.goto("/");
  await expect(doc(shell).first().locator(paraBlock(10))).toBeAttached({ timeout: 30_000 });
  await askElsewhere(shell, LONG_ID, paraId(10), para(10));
  await expect(cards(shell)).toHaveCount(2);
  await frames(shell);
  expect(await marked(shell)).toEqual([para(10), para(10)]);
});

test("a child of a later answer is marked in that answer", async ({ shell }) => {
  await shell.setViewportSize({ width: 1500, height: 900 });
  await startLong(shell);
  await scrollTo(shell, paraBlock(10), "center");
  await askAbout(shell, "詳しく", paraBlock(10));
  const parent = card(shell, "詳しく");
  await expect(parent.locator(".answer")).toBeVisible();
  await followUp(parent).click();
  await followUpField(parent).fill("なぜ？");
  await shell.keyboard.press("Control+Enter");
  await expect(parent.locator(".answer")).toHaveCount(2);
  await askOn(shell, "用語", parent, 1);
  await expect(child(shell, "用語").locator(".answer")).toBeVisible();
  await frames(shell);
  // The answers all say the same: where it is marked tells them apart.
  const where = await shell.evaluate(() =>
    [...(CSS.highlights.get("sticky") ?? [])].map((r) => (r as Range).startContainer.parentElement!.closest(".answer")?.getAttribute("data-message") ?? null),
  );
  expect(where).toEqual([null, await parent.locator(".answer").nth(1).getAttribute("data-message")]);
});

test("a child whose parent is folded is marked nowhere and has no line, though its words are in the text too", async ({ shell }) => {
  await shell.setViewportSize({ width: 1500, height: 900 });
  await startLong(shell);
  await scrollTo(shell, paraBlock(10), "center");
  await askAbout(shell, "詳しく", paraBlock(10));
  const parent = card(shell, "詳しく");
  await expect(parent.locator(".answer")).toBeVisible();
  const [root] = await quotes(shell);
  // As an answer that quotes the article would have it.
  await askElsewhere(shell, LONG_ID, null, para(10), 1);
  await expect(cards(shell)).toHaveCount(2);
  await parent.getByRole("button", { name: "付箋をたたむ" }).click();
  await frames(shell);
  expect(await marked(shell)).toEqual([root]);
  expect(await lines(shell)).toHaveLength(1);
});

test("a sticky folds to a line by its label and unfolds, and folded for one asked below, above the view, moves no text", async ({ shell }) => {
  await startNarrow(shell);
  await scrollTo(shell, paraBlock(10), "center");
  await askAbout(shell, "詳しく", paraBlock(10));
  const sticky = card(shell, "詳しく");
  await expect(sticky.locator(".answer")).toBeVisible();
  const tall = (await boxOf(sticky)).height;
  const fold = sticky.getByRole("button", { name: "付箋をたたむ" });
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  const at = (await boxOf(sticky)).y;
  await fold.click();
  await frames(shell);
  await expect(sticky.locator(".answer")).toHaveCount(0);
  await expect(followUp(sticky)).toHaveCount(0);
  await expect(sticky.getByRole("button", { name: "付箋を広げる" })).toHaveAttribute("aria-expanded", "false");
  expect((await boxOf(sticky)).y).toBeCloseTo(at, 0);
  expect((await boxOf(sticky)).height).toBeLessThan(40);
  const head = await boxOf(sticky.locator(".sticky-h"));
  const quote = await boxOf(sticky.locator(".sticky-quote"));
  expect(quote.y, "beside the label").toBeGreaterThanOrEqual(head.y);
  expect(quote.y + quote.height).toBeLessThanOrEqual(head.y + head.height);
  await unfold(sticky);
  await frames(shell);
  await expect(sticky.locator(".answer")).toHaveText(ANSWERED);
  expect((await boxOf(sticky)).height).toBeCloseTo(tall, 0);

  // The card in view no more.
  await scrollTo(shell, paraBlock(14), "start");
  await doc(shell).evaluate((el) => (el.scrollTop -= 100));
  await frames(shell);
  const text = async () => (await boxOf(shell.locator(paraBlock(14)))).y;
  const before = await text();
  await askAbout(shell, "用語", paraBlock(14));
  await expect(card(shell, "用語").locator(".answer")).toBeVisible();
  await frames(shell);
  await expect(sticky).toHaveAttribute("data-folded");
  expect(await text()).toBeCloseTo(before, 0);

  // Another window's sticky that gets its id once it is gone is not folded.
  await card(shell, "用語").getByRole("button", { name: "付箋をたたむ" }).click();
  await invoke(shell, "delete_sticky", { id: 2 });
  await expect(cards(shell)).toHaveCount(1);
  expect(await askElsewhere(shell, LONG_ID, paraId(10))).toMatchObject({ id: 2 });
  await expect(cards(shell)).toHaveCount(2);
  expect(await foldedOnes(shell)).toEqual([true, false]);
});

test("in a narrow pane the column's end takes no press on the text's first pixel", async ({ shell }) => {
  await startNarrow(shell);
  await askMany(shell, LONG_ID, paraId(30), 1);
  await doc(shell).evaluate((el) => (el.scrollTop = 0));
  await frames(shell);
  const under = await shell.locator(`${paraBlock(2)} p`).evaluate((p) => {
    const r = document.createRange();
    r.selectNodeContents(p);
    const line = r.getClientRects()[0];
    const end = document.querySelector(".stickies")!.getBoundingClientRect().left;
    return { over: Math.abs(end - line.left) < 1, under: document.elementFromPoint(line.left + 0.5, line.top + line.height / 2) === p };
  });
  expect(under).toEqual({ over: true, under: true });
});

for (const narrow of [true, false]) {
  test(`a card folded at the article's end moves no text${narrow ? ", in a narrow pane" : ""}, and one that goes takes the view up`, async ({ shell }) => {
    if (narrow) {
      await startNarrow(shell);
    } else {
      await shell.setViewportSize({ width: 1500, height: 900 });
      await startLong(shell);
    }
    // Folded far above, they took nothing from what is under the view.
    await askMany(shell, LONG_ID, paraId(30), 2);
    for (const above of await cards(shell).all()) {
      await above.getByRole("button", { name: "付箋をたたむ" }).click();
    }
    const toEnd = async () => {
      await doc(shell).evaluate((el) => (el.scrollTop = el.scrollHeight));
      await frames(shell);
    };
    await toEnd();
    await askAbout(shell, "詳しく", paraBlock(79));
    const sticky = card(shell, "詳しく");
    await expect(sticky.locator(".answer")).toBeVisible();
    await toEnd();
    const text = async () => (await boxOf(shell.locator(paraBlock(78)))).y;
    const before = await text();
    await sticky.getByRole("button", { name: "付箋をたたむ" }).click();
    await frames(shell);
    expect(await text()).toBeCloseTo(before, 0);
    await unfold(sticky);
    await frames(shell);
    expect(await text()).toBeCloseTo(before, 0);
    // A sticky that goes leaves no room for the view to stay in.
    const end = await scrollTop(shell);
    await sticky.getByRole("button", { name: "付箋を削除" }).click();
    await shell.getByRole("alertdialog").getByRole("button", { name: "削除" }).click();
    await expect(cards(shell)).toHaveCount(2);
    await frames(shell);
    expect(await scrollTop(shell)).toBeLessThan(end - 100);
  });
}

test("in a narrow pane a card folded far from the article's end leaves no room below the text", async ({ shell }) => {
  await startNarrow(shell);
  await scrollTo(shell, paraBlock(10), "center");
  await askAbout(shell, "詳しく", paraBlock(10));
  const sticky = card(shell, "詳しく");
  await expect(sticky.locator(".answer")).toBeVisible();
  await frames(shell);
  const height = () => doc(shell).evaluate((el) => el.scrollHeight);
  const [before, by] = [await height(), (await boxOf(sticky)).height];
  await sticky.getByRole("button", { name: "付箋をたたむ" }).click();
  await frames(shell);
  await expect(sticky).toHaveAttribute("data-folded");
  expect(await height()).toBeCloseTo(before - (by - (await boxOf(sticky)).height), -1);
});

test("in a narrow pane at the article's end a card whose first line the view's top is in folds where it is", async ({ shell }) => {
  await startNarrow(shell);
  await scrollTo(shell, paraBlock(72), "center");
  await askAbout(shell, "詳しく", paraBlock(72));
  const sticky = card(shell, "詳しく");
  await expect(sticky.locator(".answer")).toBeVisible();
  await frames(shell);
  // A view as tall as from 5px into the card to the article's end.
  const [needed, has] = await doc(shell).evaluate((el) => {
    const c = el.querySelector(".stickies > .sticky")!.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    return [el.scrollHeight - (c + 5), el.clientHeight];
  });
  await shell.setViewportSize({ width: 1200, height: Math.round(800 + needed - has) });
  await frames(shell);
  await doc(shell).evaluate((el) => (el.scrollTop = el.scrollHeight));
  await frames(shell);
  const view = await boxOf(doc(shell));
  const at = (await boxOf(sticky)).y;
  expect(view.y - at, "the view's top is in its first line").toBeGreaterThan(0);
  expect(view.y - at).toBeLessThan(15);
  await sticky.getByRole("button", { name: "付箋をたたむ" }).click();
  await frames(shell);
  await expect(sticky).toHaveAttribute("data-folded");
  expect((await boxOf(sticky)).y).toBeCloseTo(at, 0);
});

test("a sticky opened on the text folds those there before it, and has its block's height however tall they were", async ({ shell }) => {
  await shell.setViewportSize({ width: 1500, height: 900 });
  await startLong(shell);
  const off = async (nth: number, block: number) => (await boxOf(cards(shell).nth(nth))).y - (await boxOf(shell.locator(paraBlock(block)))).y;
  for (let i = 0; i < 7; i++) {
    await askAbout(shell, "詳しく", paraBlock(i));
    await expect(cards(shell).nth(i).locator(".answer")).toBeVisible();
    await frames(shell);
    expect(Math.abs(await off(i, i)), `the ${i}th`).toBeLessThan(1);
  }
  expect(await foldedOnes(shell)).toEqual([true, true, true, true, true, true, false]);
  const boxes = await Promise.all((await cards(shell).all()).map(boxOf));
  expect(boxes.slice(1).every((b, i) => b.y >= boxes[i].y + boxes[i].height)).toBe(true);
});

test("an answer that comes after another is opened on the text comes folded, and one sent after that does not", async ({ shell }) => {
  await hold(shell, "sticky_ask");
  await shell.setViewportSize({ width: 1500, height: 900 });
  await startLong(shell);
  await scrollTo(shell, paraBlock(12), "center");
  await askAbout(shell, "詳しく", paraBlock(10));
  await askAbout(shell, "質問", paraBlock(12));
  await release(shell, "sticky_ask")();
  await expect(card(shell, "詳しく")).toHaveAttribute("data-folded");
  await askAbout(shell, "用語", paraBlock(14));
  await field(shell).fill("なぜ？");
  await field(shell).press("Control+Enter");
  await expect.poll(async () => (await asked(shell)).length).toBe(3);
  await release(shell, "sticky_ask")();
  await expect(card(shell, "質問").locator(".answer")).toBeVisible();
  await expect(card(shell, "用語").locator(".answer")).toBeVisible();
  expect(await foldedOnes(shell)).toEqual([true, false, false]);
});

test("an ask on the text closed unsent unfolds what it folded, unless one has been folded or unfolded since", async ({ shell }) => {
  await shell.setViewportSize({ width: 1500, height: 900 });
  await startLong(shell);
  await scrollTo(shell, paraBlock(12), "center");
  await askMany(shell, LONG_ID, paraId(10), 2);
  await askAbout(shell, "質問", paraBlock(12));
  expect(await foldedOnes(shell)).toEqual([true, true, false]);
  await field(shell).press("Escape");
  await expect(cards(shell)).toHaveCount(2);
  expect(await foldedOnes(shell)).toEqual([false, false]);
  await askAbout(shell, "質問", paraBlock(12));
  await unfold(cards(shell).first());
  await field(shell).press("Escape");
  await expect(cards(shell)).toHaveCount(2);
  expect(await foldedOnes(shell)).toEqual([false, true]);
});

test("two asks on the text closed unsent, in either order, unfold what they folded once both have", async ({ shell }) => {
  await shell.setViewportSize({ width: 1500, height: 900 });
  await startLong(shell);
  await scrollTo(shell, paraBlock(12), "center");
  await askMany(shell, LONG_ID, paraId(10), 2);
  for (const first of [1, 0]) {
    await askAbout(shell, "質問", paraBlock(12));
    await askAbout(shell, "質問", paraBlock(14));
    await expect(cards(shell)).toHaveCount(4);
    await field(shell).nth(first).press("Escape");
    await expect(cards(shell)).toHaveCount(3);
    expect(await foldedOnes(shell), "folded for the one still open").toEqual([true, true, false]);
    await field(shell).press("Escape");
    await expect(cards(shell)).toHaveCount(2);
    expect(await foldedOnes(shell)).toEqual([false, false]);
  }
});

test("an answer that waits as two asks on the text open and close unsent, the first first, comes unfolded", async ({ shell }) => {
  await hold(shell, "sticky_ask");
  await shell.setViewportSize({ width: 1500, height: 900 });
  await startLong(shell);
  await scrollTo(shell, paraBlock(12), "center");
  await askAbout(shell, "詳しく", paraBlock(10));
  await askAbout(shell, "質問", paraBlock(12));
  await askAbout(shell, "質問", paraBlock(14));
  await field(shell).first().press("Escape");
  await expect(cards(shell)).toHaveCount(2);
  await field(shell).press("Escape");
  await expect(cards(shell)).toHaveCount(1);
  await release(shell, "sticky_ask")();
  await expect(card(shell, "詳しく").getByRole("button", { name: /^付箋を(たたむ|広げる)$/ })).toBeVisible();
  expect(await foldedOnes(shell)).toEqual([false]);
});

test("of two asks on the text with an unfold of the reader's between their openings, closed unsent the first first, the second gives back what it folded", async ({
  shell,
}) => {
  await shell.setViewportSize({ width: 1500, height: 900 });
  await startLong(shell);
  await scrollTo(shell, paraBlock(12), "center");
  await askMany(shell, LONG_ID, paraId(10), 2);
  await askAbout(shell, "質問", paraBlock(12));
  await unfold(cards(shell).first());
  await askAbout(shell, "質問", paraBlock(14));
  expect(await foldedOnes(shell)).toEqual([true, true, false, false]);
  await field(shell).first().press("Escape");
  await expect(cards(shell)).toHaveCount(3);
  await field(shell).press("Escape");
  await expect(cards(shell)).toHaveCount(2);
  expect(await foldedOnes(shell)).toEqual([false, true]);
});

test("an answer that comes as two asks on the text are open stays folded until both have closed unsent", async ({ shell }) => {
  await hold(shell, "sticky_ask");
  await shell.setViewportSize({ width: 1500, height: 900 });
  await startLong(shell);
  await scrollTo(shell, paraBlock(12), "center");
  await askAbout(shell, "詳しく", paraBlock(10));
  await askAbout(shell, "質問", paraBlock(12));
  await askAbout(shell, "質問", paraBlock(14));
  await release(shell, "sticky_ask")();
  await expect(cards(shell).first()).toHaveAttribute("data-folded");
  await field(shell).last().press("Escape");
  await expect(cards(shell)).toHaveCount(2);
  expect(await foldedOnes(shell), "folded for the one still open").toEqual([true, false]);
  await field(shell).press("Escape");
  await expect(cards(shell)).toHaveCount(1);
  expect(await foldedOnes(shell)).toEqual([false]);
});

test("an answer that came folded for an ask on the text unfolds as that closes unsent", async ({ shell }) => {
  await hold(shell, "sticky_ask");
  await shell.setViewportSize({ width: 1500, height: 900 });
  await startLong(shell);
  await scrollTo(shell, paraBlock(12), "center");
  await askAbout(shell, "詳しく", paraBlock(10));
  await askAbout(shell, "質問", paraBlock(12));
  await release(shell, "sticky_ask")();
  await expect(card(shell, "詳しく")).toHaveAttribute("data-folded");
  await field(shell).press("Escape");
  await expect(cards(shell)).toHaveCount(1);
  expect(await foldedOnes(shell)).toEqual([false]);
});

test("an answer that waits as an ask opens on the text comes folded, though the ask closes unsent after a fold of the reader's", async ({ shell }) => {
  await hold(shell, "sticky_ask");
  await shell.setViewportSize({ width: 1500, height: 900 });
  await startLong(shell);
  await scrollTo(shell, paraBlock(12), "center");
  await askAbout(shell, "用語", paraBlock(8));
  await release(shell, "sticky_ask")();
  await expect(card(shell, "用語").locator(".answer")).toBeVisible();
  await askAbout(shell, "詳しく", paraBlock(10));
  await askAbout(shell, "質問", paraBlock(12));
  await unfold(card(shell, "用語"));
  // That one folded for the question stays folded: so would the answer have.
  await field(shell).press("Escape");
  await release(shell, "sticky_ask")();
  await expect(card(shell, "詳しく").getByRole("button", { name: "付箋を広げる" })).toBeVisible();
  expect(await foldedOnes(shell)).toEqual([false, true]);
});

test("an answer asked again while an ask on the text is open does not come folded once that closes unsent", async ({ shell }) => {
  await hold(shell, "sticky_ask");
  await shell.setViewportSize({ width: 1500, height: 900 });
  await startLong(shell);
  await scrollTo(shell, paraBlock(12), "center");
  const failing = (cmds: string[]) => shell.evaluate((cmds) => void (window.__e2eFail = cmds), cmds);
  await failing(["sticky_ask"]);
  await askAbout(shell, "詳しく", paraBlock(10));
  await release(shell, "sticky_ask")();
  await expect(card(shell, "詳しく").getByRole("alert")).toBeVisible();
  await failing([]);
  await askAbout(shell, "質問", paraBlock(12));
  await card(shell, "詳しく").getByRole("button", { name: "再試行" }).click();
  await field(shell).press("Escape");
  await release(shell, "sticky_ask")();
  await expect(card(shell, "詳しく").locator(".answer")).toBeVisible();
  expect(await foldedOnes(shell)).toEqual([false]);
});

test("in a narrow pane an ask below a card that the view's top is in moves no text as that card folds for it", async ({ shell }) => {
  await startNarrow(shell);
  await scrollTo(shell, paraBlock(10), "center");
  await askAbout(shell, "詳しく", paraBlock(10));
  const first = card(shell, "詳しく");
  await expect(first.locator(".answer")).toBeVisible();
  const view = await boxOf(doc(shell));
  await doc(shell).evaluate((el, by) => (el.scrollTop += by), (await boxOf(shell.locator(paraBlock(11)))).y - view.y - 100);
  await frames(shell);
  const { y, height } = await boxOf(first);
  expect(y, "the view's top is in it").toBeLessThan(view.y);
  expect(y + height).toBeGreaterThan(view.y);
  const text = async () => (await boxOf(shell.locator(paraBlock(11)))).y;
  const before = await text();
  await askAbout(shell, "用語", paraBlock(11));
  await expect(card(shell, "用語").locator(".answer")).toBeVisible();
  await frames(shell);
  await expect(first).toHaveAttribute("data-folded");
  expect(await text()).toBeCloseTo(before, 0);
});

test("in a narrow pane a card that folded under the view's top unfolds where the reader sees it", async ({ shell }) => {
  await startNarrow(shell);
  await scrollTo(shell, paraBlock(10), "center");
  await askAbout(shell, "詳しく", paraBlock(10));
  const first = card(shell, "詳しく");
  await expect(first.locator(".answer")).toBeVisible();
  const view = await boxOf(doc(shell));
  await doc(shell).evaluate((el, by) => (el.scrollTop += by), (await boxOf(shell.locator(paraBlock(11)))).y - view.y - 100);
  await frames(shell);
  expect((await boxOf(first)).y, "the view's top is in it").toBeLessThan(view.y);
  await askAbout(shell, "用語", paraBlock(11));
  await expect(card(shell, "用語").locator(".answer")).toBeVisible();
  await frames(shell);
  const at = (await boxOf(first)).y;
  expect(at, "in view, so that the click scrolls nothing").toBeGreaterThan(view.y);
  const text = shell.locator(paraBlock(10));
  const above = (await boxOf(text)).y;
  await unfold(first);
  await frames(shell);
  expect((await boxOf(first)).y).toBeCloseTo(at, 0);
  expect((await boxOf(text)).y).toBeCloseTo(above, 0);
});

test("beside the text a child that gave way to the one opened last folds and unfolds where it is", async ({ shell }) => {
  await startCrowded(shell);
  const parent = Number(await cards(shell).first().locator(".answer").getAttribute("data-message"));
  const asked = askElsewhere(shell, LONG_ID, paraId(30), "elsewhere", parent);
  await shell.waitForFunction(() => window.__e2e.calls.filter((c) => c.cmd === "sticky_ask").length === 3);
  await release(shell, "sticky_ask")();
  await asked;
  const kid = child(shell, "用語");
  await expect(kid.locator(".answer")).toBeVisible();
  await frames(shell);
  const text = async () => (await boxOf(shell.locator(paraBlock(31)))).y;
  const [at, before] = [(await boxOf(kid)).y, await text()];
  await kid.getByRole("button", { name: "付箋をたたむ" }).click();
  await frames(shell);
  expect((await boxOf(kid)).y).toBeCloseTo(at, 0);
  await unfold(kid);
  await frames(shell);
  expect((await boxOf(kid)).y).toBeCloseTo(at, 0);
  expect(await text()).toBeCloseTo(before, 0);
});

test("beside the text a second child that gave way to the one opened last folds where it is", async ({ shell }) => {
  await startCrowded(shell);
  const parent = Number(await cards(shell).first().locator(".answer").getAttribute("data-message"));
  for (const n of [3, 4]) {
    const asked = askElsewhere(shell, LONG_ID, paraId(30), "elsewhere", parent);
    await shell.waitForFunction((n) => window.__e2e.calls.filter((c) => c.cmd === "sticky_ask").length === n, n);
    await release(shell, "sticky_ask")();
    await asked;
  }
  await expect(cards(shell).locator(".answer")).toHaveCount(4);
  await expect(cards(shell).locator(".sticky-kind")).toHaveText(["用語", "用語(回答から)", "用語(回答から)", "用語"]);
  await frames(shell);
  const kid = cards(shell).nth(2);
  const at = (await boxOf(kid)).y;
  await kid.getByRole("button", { name: "付箋をたたむ" }).click();
  await frames(shell);
  await expect(kid).toHaveAttribute("data-folded");
  expect((await boxOf(kid)).y).toBeCloseTo(at, 0);
});

test("beside the text a card folded above the one opened last unfolds where it is, and that one gives way to it", async ({ shell }) => {
  await shell.setViewportSize({ width: 1500, height: 900 });
  await startLong(shell);
  await askElsewhere(shell, LONG_ID, paraId(10), para(10));
  await expect(cards(shell)).toHaveCount(1);
  await scrollTo(shell, paraBlock(10), "start");
  await doc(shell).evaluate((el) => (el.scrollTop -= 5));
  await frames(shell);
  await askAbout(shell, "質問", paraBlock(12));
  const [above, opened] = [cards(shell).first(), cards(shell).last()];
  await expect(above).toHaveAttribute("data-folded");
  const at = (await boxOf(above)).y;
  const text = async () => (await boxOf(shell.locator(paraBlock(12)))).y;
  const before = await text();
  await unfold(above);
  await frames(shell);
  const { y, height } = await boxOf(above);
  expect(y).toBeCloseTo(at, 0);
  expect((await boxOf(opened)).y, "below it").toBeGreaterThan(y + height);
  expect(await text()).toBeCloseTo(before, 0);
});

test("beside the text a card after another that gave way to the one opened last folds where it is", async ({ shell }) => {
  await startTall(shell);
  const second = cards(shell).nth(1);
  const at = (await boxOf(second)).y;
  expect(at - (await boxOf(shell.locator(paraBlock(29)))).y, "gave way").toBeLessThan(-20);
  await second.getByRole("button", { name: "付箋をたたむ" }).click();
  await frames(shell);
  await expect(second).toHaveAttribute("data-folded");
  expect((await boxOf(second)).y).toBeCloseTo(at, 0);
});

test.describe("in English", () => {
  test.use({ locale: "en-US" });
  test("folded, a card of an answer is one line with some of its passage in the narrowest column, however deep", async ({ shell }) => {
    await shell.setViewportSize({ width: 1380, height: 900 });
    await startLong(shell);
    let parent: number | null = null;
    for (let i = 0; i < 4; i++) {
      await askElsewhere(shell, LONG_ID, paraId(3), "a passage of an answer that goes on for a while", parent);
      await expect(cards(shell)).toHaveCount(i + 1);
      parent = Number(await cards(shell).nth(i).locator(".answer").getAttribute("data-message"));
    }
    const cut = () =>
      cards(shell)
        .locator(".sticky-kind")
        .evaluateAll((els) => els.map((el) => el.scrollWidth > el.clientWidth));
    expect(await cut(), "open, a label is whole").toEqual([false, false, false, false]);
    for (let i = 3; i >= 0; i--) {
      await cards(shell).nth(i).getByRole("button", { name: "Fold the sticky" }).click();
    }
    await frames(shell);
    expect(await cut(), "those of answers are long for it").toEqual([false, true, true, true]);
    const sizes = await cards(shell).evaluateAll((els) =>
      els.map((el) => ({ card: Math.round(el.getBoundingClientRect().height), quote: el.querySelector(".sticky-quote")!.getBoundingClientRect().width > 30 })),
    );
    expect(sizes).toEqual(sizes.map(() => ({ card: sizes[0].card, quote: true })));
  });
});

test("a sticky folded before an ask on the text opens stays folded as that closes unsent", async ({ shell }) => {
  await shell.setViewportSize({ width: 1500, height: 900 });
  await startLong(shell);
  await scrollTo(shell, paraBlock(12), "center");
  await askMany(shell, LONG_ID, paraId(10), 2);
  await cards(shell).first().getByRole("button", { name: "付箋をたたむ" }).click();
  await askAbout(shell, "質問", paraBlock(12));
  expect(await foldedOnes(shell)).toEqual([true, true, false]);
  await field(shell).press("Escape");
  await expect(cards(shell)).toHaveCount(2);
  expect(await foldedOnes(shell)).toEqual([true, false]);
});

test("an answer that waits as an ask on the text opens and closes unsent comes unfolded", async ({ shell }) => {
  await hold(shell, "sticky_ask");
  await shell.setViewportSize({ width: 1500, height: 900 });
  await startLong(shell);
  await scrollTo(shell, paraBlock(12), "center");
  await askAbout(shell, "詳しく", paraBlock(10));
  await askAbout(shell, "質問", paraBlock(12));
  await field(shell).press("Escape");
  await expect(cards(shell)).toHaveCount(1);
  await release(shell, "sticky_ask")();
  await expect(card(shell, "詳しく").locator(".answer")).toBeVisible();
  expect(await foldedOnes(shell)).toEqual([false]);
});

test("after a fold of the reader's an answer comes folded, and an ask on the text closed unsent gives nothing back", async ({ shell }) => {
  await hold(shell, "sticky_ask");
  await shell.setViewportSize({ width: 1500, height: 900 });
  await startLong(shell);
  await scrollTo(shell, paraBlock(12), "center");
  await askAbout(shell, "用語", paraBlock(8));
  await release(shell, "sticky_ask")();
  await expect(card(shell, "用語").locator(".answer")).toBeVisible();
  await askAbout(shell, "詳しく", paraBlock(10));
  await askAbout(shell, "質問", paraBlock(12));
  await unfold(card(shell, "用語"));
  await release(shell, "sticky_ask")();
  await expect(card(shell, "詳しく")).toHaveAttribute("data-folded");
  await field(shell).press("Escape");
  await expect(cards(shell)).toHaveCount(2);
  expect(await foldedOnes(shell)).toEqual([false, true]);
});

test("a follow-up being written stays as its sticky folds and unfolds", async ({ shell }) => {
  await shell.setViewportSize({ width: 1500, height: 900 });
  await startLong(shell);
  await scrollTo(shell, paraBlock(12), "center");
  await askMany(shell, LONG_ID, paraId(10), 1);
  const sticky = cards(shell).first();
  await followUp(sticky).click();
  await followUpField(sticky).fill("half a follow-up");
  await askAbout(shell, "質問", paraBlock(12));
  await expect(sticky).toHaveAttribute("data-folded");
  await field(shell).press("Escape");
  await expect(followUpField(sticky)).toHaveValue("half a follow-up");
  await sticky.getByRole("button", { name: "付箋をたたむ" }).click();
  await unfold(sticky);
  await expect(followUpField(sticky)).toHaveValue("half a follow-up");
});

test("a sticky with a passage of several lines folds to one", async ({ shell }) => {
  await shell.setViewportSize({ width: 1500, height: 900 });
  await startLong(shell, 6);
  await askElsewhere(shell, LONG_ID, paraId(10), Array(6).fill(para(10)).join(" "));
  await expect(cards(shell)).toHaveCount(1);
  const sticky = cards(shell).first();
  expect((await boxOf(sticky.locator(".sticky-quote"))).height, "of more than one line unfolded").toBeGreaterThan(40);
  await sticky.getByRole("button", { name: "付箋をたたむ" }).click();
  await frames(shell);
  expect((await boxOf(sticky.locator(".sticky-quote"))).height).toBeLessThan(25);
  expect((await boxOf(sticky)).height).toBeLessThan(40);
});

test("at the column's end a fold of the card taller than the others moves no text", async ({ shell }) => {
  await shell.setViewportSize({ width: 1500, height: 900 });
  await startLong(shell);
  await askMany(shell, LONG_ID, paraId(79), 4);
  const tall = cards(shell).last();
  for (let i = 0; i < 2; i++) {
    await followUp(tall).click();
    await followUpField(tall).fill("なぜ？");
    await shell.keyboard.press("Control+Enter");
    await expect(tall.locator(".answer")).toHaveCount(i + 2);
  }
  await doc(shell).evaluate((el) => (el.scrollTop = el.scrollHeight));
  await frames(shell);
  const top = await scrollTop(shell);
  await expect(tall.getByRole("button", { name: "付箋をたたむ" })).toBeInViewport();
  await tall.getByRole("button", { name: "付箋をたたむ" }).click();
  await frames(shell);
  expect(await scrollTop(shell)).toBe(top);
});

test("a follow-up, and a child, fold no other sticky", async ({ shell }) => {
  await shell.setViewportSize({ width: 1500, height: 900 });
  await startLong(shell);
  await scrollTo(shell, paraBlock(10), "center");
  await askMany(shell, LONG_ID, paraId(10), 2);
  await followUp(cards(shell).first()).click();
  expect(await foldedOnes(shell), "as it is open").toEqual([false, false]);
  await shell.keyboard.press("Escape");
  await askOn(shell, "用語", cards(shell).first());
  await expect(child(shell, "用語").locator(".answer")).toBeVisible();
  expect(await foldedOnes(shell)).toEqual([false, false, false]);
});

const draftField = (sticky: Locator) => sticky.getByRole("textbox", { name: "メモの下書き" });
const memoButton = (page: Page) => page.getByRole("button", { name: "メモ", exact: true });
const memoField = (page: Page) => page.getByRole("complementary", { name: "メモ" }).getByRole("textbox", { name: "メモ" });
const lastMemo = async (page: Page) => (await callsOf(page, "set_article_note")).at(-1);
const DRAFTED = /^「.+」の下書き。答え1件から。$/;

test("メモに下書き: the draft waits, stays through leaving the article, is changed in the sticky and goes to the end of the memo", async ({ shell }) => {
  await hold(shell, "sticky_note_draft");
  await shell.goto("/");
  await openSnapshot(shell);
  await askAbout(shell, "詳しく", "#b-102");
  const sticky = card(shell, "詳しく");
  await expect(sticky.locator(".answer")).toHaveText(ANSWERED);
  await sticky.getByRole("button", { name: "メモに下書き" }).click();
  await expect(sticky.getByRole("status")).toHaveText("下書きを作成中…");
  await expect(doc(shell), "the keyboard goes back to the article as the button goes").toBeFocused();
  await open(shell, LONG_ID);
  await shell.evaluate(() => window.__e2e.release("sticky_note_draft"));
  await open(shell, SNAPSHOT_ID);
  await expect(draftField(sticky)).toHaveValue(DRAFTED);
  expect(await callsOf(shell, "sticky_note_draft")).toEqual([{ id: 1 }]);
  await expect(draftField(sticky), "the keyboard stays where it was").not.toBeFocused();

  await draftField(sticky).fill("自分の言葉で直した下書き");
  await open(shell, LONG_ID);
  await open(shell, SNAPSHOT_ID);
  await expect(draftField(sticky), "what the reader changed stays too").toHaveValue("自分の言葉で直した下書き");

  // A memo being typed in an open panel.
  await memoButton(shell).click();
  await memoField(shell).fill("2PLと比べる");
  await sticky.getByRole("button", { name: "メモに足す" }).click();
  await expect(sticky.getByRole("status")).toHaveText("メモに足しました");
  await expect(draftField(sticky)).toHaveCount(0);
  await expect(memoField(shell), "the panel shows it").toHaveValue("2PLと比べる\n\n自分の言葉で直した下書き");
  await expect.poll(() => lastMemo(shell)).toEqual({ id: SNAPSHOT_ID, body: "2PLと比べる\n\n自分の言葉で直した下書き" });
  await memoField(shell).press("Control+End");
  await memoField(shell).pressSequentially("。");
  await expect.poll(() => lastMemo(shell), "typing on keeps it").toEqual({ id: SNAPSHOT_ID, body: "2PLと比べる\n\n自分の言葉で直した下書き。" });
});

test("メモに下書き: a failed draft is asked again, Esc and キャンセル leave the memo alone, and one added marks メモ", async ({ shell }) => {
  await shell.addInitScript(() => void (window.__e2eFail = ["sticky_note_draft"]));
  await shell.goto("/");
  await openSnapshot(shell);
  await askAbout(shell, "詳しく", "#b-102");
  const sticky = card(shell, "詳しく");
  const draft = sticky.getByRole("button", { name: "メモに下書き" });
  await draft.click();
  await expect(sticky.getByRole("alert")).toHaveText(/sticky_note_draft failed/);
  await shell.evaluate(() => void (window.__e2eFail = []));
  await sticky.getByRole("button", { name: "再試行" }).click();
  await expect(draftField(sticky)).toHaveValue(DRAFTED);
  await expect(doc(shell)).toBeFocused();
  await draftField(sticky).press("Escape");
  await expect(draftField(sticky)).toHaveCount(0);
  await draft.click();
  await sticky.getByRole("button", { name: "キャンセル" }).click();
  await expect(draftField(sticky)).toHaveCount(0);
  expect(await callsOf(shell, "set_article_note")).toEqual([]);
  await expect(memoButton(shell)).not.toHaveClass(/\bon\b/);

  await draft.click();
  await draftField(sticky).fill(" ");
  await expect(sticky.getByRole("button", { name: "メモに足す" })).toBeDisabled();
  await draftField(sticky).fill(" 下書き ");
  await sticky.getByRole("button", { name: "メモに足す" }).click();
  await expect(memoButton(shell), "with the panel closed too").toHaveClass(/\bon\b/);
  expect(await callsOf(shell, "set_article_note")).toEqual([{ id: SNAPSHOT_ID, body: "下書き" }]);
  await memoButton(shell).click();
  await expect(memoField(shell)).toHaveValue("下書き");
});

test("メモに下書き: a memo that cannot be saved says so in the sticky, and the memo saves the text again", async ({ shell }) => {
  await shell.addInitScript(() => void (window.__e2eFail = ["set_article_note"]));
  await shell.goto("/");
  await openSnapshot(shell);
  await askAbout(shell, "詳しく", "#b-102");
  const sticky = card(shell, "詳しく");
  await sticky.getByRole("button", { name: "メモに下書き" }).click();
  await sticky.getByRole("button", { name: "メモに足す" }).click();
  await expect(sticky.getByRole("alert")).toHaveText(/set_article_note failed/);
  await memoButton(shell).click();
  const panel = shell.getByRole("complementary", { name: "メモ" });
  await expect(panel.getByRole("alert")).toBeVisible();
  await expect(memoField(shell)).toHaveValue(DRAFTED);
  await shell.evaluate(() => void (window.__e2eFail = []));
  await memoField(shell).blur();
  await expect(panel.getByRole("status")).toHaveText("保存しました");
  expect(await lastMemo(shell)).toEqual({ id: SNAPSHOT_ID, body: expect.stringMatching(DRAFTED) });
});

test("メモに下書き: the draft of a sticky deleted meanwhile goes to no other, though a new one has its id", async ({ shell }) => {
  // Answered as it is asked, as the backend reads the sticky then, and delivered at its release.
  await shell.addInitScript(() => void (window.__e2eLate = ["sticky_note_draft"]));
  await shell.goto("/");
  await openSnapshot(shell);
  await askAbout(shell, "詳しく", "#b-102");
  const deleted = card(shell, "詳しく");
  await deleted.getByRole("button", { name: "メモに下書き" }).click();
  await deleted.getByRole("button", { name: "付箋を削除" }).click();
  await shell.getByRole("alertdialog").getByRole("button", { name: "削除" }).click();
  await expect(deleted).toHaveCount(0);
  await askAbout(shell, "用語", "#b-103");
  const sticky = card(shell, "用語");
  await sticky.getByRole("button", { name: "メモに下書き" }).click();
  expect(await callsOf(shell, "sticky_note_draft"), "the new sticky has the deleted one's id").toEqual([{ id: 1 }, { id: 1 }]);
  await shell.evaluate(() => window.__e2e.release("sticky_note_draft", 1));
  await shell.evaluate(() => window.__e2e.release("sticky_note_draft"));
  await expect(draftField(sticky)).toHaveValue(/^「PostgreSQL implements it with multi-version concurrency control\.」の下書き。/);
});

test("単語を登録 on a 用語 sticky saves its word in its sentence with what the sticky says, which the word list shows", async ({ app }) => {
  await openSnapshot(app);
  await selectWord(app, 106, "snapshot");
  await bar(app).getByRole("button", { name: "用語", exact: true }).click();
  const term = card(app, "用語");
  await expect(term.locator(".answer")).toHaveText(ANSWERED);
  await term.getByRole("button", { name: "単語を登録" }).click();
  await expect(term.getByRole("status")).toHaveText("「snapshot」を単語帳に登録しました");
  const explanation =
    "選んだ箇所の説明です。記事には書かれていませんが、一般にも使います(snapshot)。出典のない番号 [7] と消えた出典、書き換わった出典 はそのままです。";
  expect(await callsOf(app, "vocab_add")).toEqual([
    {
      capture: {
        surface: "snapshot",
        sentence: "Write skew is still possible under snapshot isolation.",
        article_id: SNAPSHOT_ID,
        block_id: 106,
        url: ARTICLES[0].original_url,
        explanation,
      },
    },
  ]);

  // Not of another kind, of code, of more than a word, or of an answer.
  await askAbout(app, "詳しく", "#b-103");
  await askAbout(app, "用語", "#b-105");
  await askAbout(app, "用語", "#b-102");
  const on = (block: number) => card(app, "用語").and(app.locator(`[data-block="${block}"]`));
  await askOn(app, "用語", on(102));
  for (const sticky of [card(app, "詳しく"), on(105), on(102), child(app, "用語")]) {
    if ((await sticky.getAttribute("data-folded")) != null) {
      await unfold(sticky);
    }
    await expect(sticky.getByRole("button", { name: "メモに下書き" })).toBeVisible();
    await expect(sticky.getByRole("button", { name: "単語を登録" })).toHaveCount(0);
  }

  await navItem(app, "単語帳").click();
  const row = app.locator(".vocab tbody tr").filter({ has: app.locator(".hw").getByText("snapshot", { exact: true }) });
  await expect(row.locator(".explain")).toHaveText(explanation);
});
