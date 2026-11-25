// Stickies: asking about a passage in the Reader, and the answer that stays beside it.
import { test, expect, callsOf, list, listRow } from "./harness.ts";
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
const card = (page: Page, kind: "質問" | "詳しく" | "用語") => page.locator(".stickies").getByRole("region", { name: kind, exact: true });
const field = (page: Page) => page.getByRole("textbox", { name: "選んだ箇所への質問" });
const asked = async (page: Page) => (await callsOf(page, "sticky_ask")) as { blockId: number | null; kind: string; quote: string; question: string }[];

const ANSWERED = /選んだ箇所の説明です/;

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
async function askAbout(page: Page, kind: "質問" | "詳しく" | "用語", block: string) {
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
const askElsewhere = (page: Page, articleId: number, blockId: number | null, quote = "elsewhere") =>
  invoke(page, "sticky_ask", { articleId, blockId, parent: null, kind: "term", quote, question: "" });

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

const hold = (shell: Page, cmd: string) => shell.addInitScript((c) => void (window.__e2eHold = [c]), cmd);

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
  await app.evaluate(() => void ((window as unknown as { __modelUp: boolean }).__modelUp = true));
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
  expect(await off(6, paraBlock(32))).toBeLessThan(0);
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
        const kind = int(6);
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
          const ids = (await invoke(shell, "list_stickies", { articleId: LONG_ID })) as { id: number }[];
          if (ids.length > 2) {
            const { id } = ids[int(ids.length)];
            steps.push(`delete ${id}`);
            await invoke(shell, "delete_sticky", { id });
            await frames(shell);
          }
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
  await askAbout(shell, "質問", paraBlock(79));
  await expect(field(shell)).toBeFocused();
  await frames(shell);
  expect(await scrollTop(shell)).toBeGreaterThan(top + 50);
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
  // In the card, by the mouse.
  await card(app, "詳しく")
    .locator(".answer")
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
  await scrollTo(shell, paraBlock(8), "center");
  const c = await boxOf(cards(shell).first());
  const x = c.x + c.width / 2;
  for (const [name, i] of [
    ["the empty column above the card", 4],
    ["the empty column below it", 12],
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
  const end = await shell.evaluate(() => {
    const rects = getSelection()!.getRangeAt(0).getClientRects();
    const r = rects[rects.length - 1];
    return { x: r.right - 1, y: r.top + r.height / 2 };
  });
  await shell.keyboard.down("Shift");
  await shell.mouse.click(end.x, end.y);
  expect(await selected(shell)).toBe(before);
  await expect(bar(shell)).toBeVisible();
  await shell.keyboard.up("Shift");
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
    const answer = await boxOf(cards(shell).first().locator(".answer"));
    const from: [number, number] = [answer.x + 4, answer.y + 12];
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
    await scrollTo(shell, paraBlock(8), "center");
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
  await shell.emulateMedia({ media: "print" });
  await expect(shell.locator(".stickies")).toBeHidden();
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
