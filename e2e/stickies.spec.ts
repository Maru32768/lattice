// Stickies: asking about a passage in the Reader, and the answer that stays beside it.
import { test, expect, callsOf, list, listRow } from "./harness.ts";
import { ARTICLES, SNAPSHOT_ID } from "./fixtures.ts";
import type { Locator, Page } from "@playwright/test";

const titleOf = (id: number) => ARTICLES.find((a) => a.id === id)!.title!;
const LONG_ID = ARTICLES[1].id;
const para = (i: number) => `Paragraph ${i} of the long article.`;

async function open(page: Page, id: number) {
  await (await listRow(page, titleOf(id))).click();
  await expect(page.locator(".art-title")).toHaveText(titleOf(id));
}

/** The article with blocks of every kind, in the original language. */
async function openSnapshot(page: Page) {
  await open(page, SNAPSHOT_ID);
  await page.locator(".docbar").getByRole("button", { name: "原文", exact: true }).click();
}

/** The app with one article long enough to scroll. */
async function startLong(shell: Page) {
  await shell.route(/\/fixtures\.ts(\?|$)/, async (route) => {
    const res = await route.fetch();
    const more = `genericBlocks = ((plain) => (a) => (a.id === ${LONG_ID} ? [...plain(a), ...Array.from({ length: 80 }, (_, i) => ['paragraph', \`Paragraph \${i} of the long article.\`, null])] : plain(a)))(genericBlocks);`;
    await route.fulfill({ response: res, body: `${await res.text()}\n${more}\n` });
  });
  await shell.goto("/");
  await expect(list(shell).locator(".row").first()).toBeVisible({ timeout: 30_000 });
  await open(shell, LONG_ID);
}

const bar = (page: Page) => page.locator(".vw-cap");
const cards = (page: Page) => page.locator(".stickies > .sticky");
const card = (page: Page, kind: "質問" | "詳しく" | "用語") => page.locator(".stickies").getByRole("region", { name: kind, exact: true });
const field = (page: Page) => page.getByRole("textbox", { name: "選んだ箇所への質問" });
const asked = async (page: Page) => (await callsOf(page, "sticky_ask")) as { blockId: number | null; kind: string; quote: string; question: string }[];

const ANSWERED = /選んだ箇所の説明です/;

const boxOf = async (l: Locator) => (await l.boundingBox())!;

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
  await page.mouse.move(start.x + 1, start.y);
  await page.mouse.down();
  await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2);
  await page.mouse.move(end.x - 1, end.y);
  if (beyond) {
    await page.mouse.move(end.x + beyond, end.y);
  }
  await page.mouse.up();
}

/** Selects from the start of `from` to the end of `to` and lets the mouse go there, without moving it. */
const selectFrom = (page: Page, from: string, to: string) =>
  page.evaluate(
    (ids) => {
      const [start, end] = ids.map((id) => document.querySelector(id)!);
      const r = document.createRange();
      r.setStart(start, 0);
      r.setEnd(end, end.childNodes.length);
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
const askElsewhere = (page: Page, articleId: number, blockId: number | null, quote = "elsewhere") =>
  page.evaluate(
    (args) =>
      (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke(
        "sticky_ask",
        args,
      ),
    { articleId, blockId, kind: "term", quote, question: "" },
  );

const hold = (shell: Page, cmd: string) => shell.addInitScript((c) => void (window.__e2eHold = [c]), cmd);

test("詳しく: a passage over two paragraphs gets an answer beside the first, and no chat hears of it", async ({ shell }) => {
  await hold(shell, "sticky_ask");
  await shell.goto("/");
  await openSnapshot(shell);
  const text = await boxOf(shell.locator("#b-102"));
  await expect(cards(shell)).toHaveCount(0);
  await expect(shell.locator(".stickies")).toHaveCount(0);

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

  const [beside, block, reader] = [await boxOf(detail), await boxOf(shell.locator("#b-102")), await boxOf(shell.locator(".reader"))];
  expect(Math.abs(beside.y - block.y), "at its block's height").toBeLessThan(1);
  expect(beside.x, "right of the text").toBeGreaterThanOrEqual(reader.x + reader.width);
  await expect(shell.locator(".dpane")).not.toContainText("対話を閉じる");
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

test("a citation goes to its block; a number without a block of the article is text", async ({ app }) => {
  await openSnapshot(app);
  await askAbout(app, "詳しく", "#b-103");
  const answer = card(app, "詳しく").locator(".answer");
  await expect(answer).toHaveText(/\[7\].*\[2\]/);
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
  await remove.click();
  await dialog.getByRole("button", { name: "キャンセル" }).click();
  await expect(cards(app)).toHaveCount(1);
  expect(await callsOf(app, "delete_sticky")).toEqual([]);
  await remove.click();
  await dialog.getByRole("button", { name: "削除" }).click();
  await expect(app.locator(".stickies")).toHaveCount(0);
  expect(await callsOf(app, "delete_sticky")).toEqual([{ id: 1 }]);
  expect(await boxOf(app.locator("#b-102"))).toEqual(before);
  await open(app, LONG_ID);
  await open(app, SNAPSHOT_ID);
  await expect(app.locator(".stickies")).toHaveCount(0);
});

test("a sticky asked or deleted in another window shows here", async ({ app }) => {
  await openSnapshot(app);
  const reads = async () => (await callsOf(app, "list_stickies")).length;
  const before = await reads();
  await askElsewhere(app, LONG_ID, null);
  await askElsewhere(app, SNAPSHOT_ID, 103);
  await expect(card(app, "用語").locator(".sticky-quote")).toHaveText("elsewhere");
  expect(await reads(), "another article's is none of this one's").toBe(before + 1);
  await app.evaluate(() =>
    (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke("delete_sticky", {
      id: 2,
    }),
  );
  await expect(app.locator(".stickies")).toHaveCount(0);
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

test("the column goes on below a short article, and scrolls with it", async ({ app }) => {
  await openSnapshot(app);
  for (let i = 0; i < 8; i++) {
    await askElsewhere(app, SNAPSHOT_ID, 107, `card ${i}`);
  }
  await expect(cards(app)).toHaveCount(8);
  await cards(app).last().scrollIntoViewIfNeeded();
  await expect(cards(app).last()).toBeInViewport({ ratio: 1 });
});

test("in a narrow pane the cards come after the article, and go back beside it in a wider one", async ({ shell }) => {
  await shell.setViewportSize({ width: 1500, height: 900 });
  await startLong(shell);
  await askElsewhere(shell, LONG_ID, LONG_ID * 100 + 2, "one");
  await askElsewhere(shell, LONG_ID, LONG_ID * 100 + 3, "two");
  const beside = async () => {
    const [c, r] = [await boxOf(cards(shell).first()), await boxOf(shell.locator(".reader"))];
    return c.x >= r.x + r.width - 1;
  };
  const below = async () => {
    const [one, two, r] = [await boxOf(cards(shell).first()), await boxOf(cards(shell).last()), await boxOf(shell.locator(".reader"))];
    return one.y >= r.y + r.height && two.y >= one.y + one.height;
  };
  await expect.poll(beside).toBe(true);
  // The pane keeps what the sidebar and the list leave.
  const pane = await shell.locator(".doc-scroll").evaluate((el) => el.clientWidth);
  await shell.setViewportSize({ width: 1500 - pane + 575, height: 900 });
  await expect.poll(beside).toBe(true);
  const text = await boxOf(shell.locator(".reader .blocks"));
  expect(text.width, "the text gives up width").toBeGreaterThan(240);
  await shell.setViewportSize({ width: 1500 - pane + 540, height: 900 });
  await expect.poll(below).toBe(true);
  await askAbout(shell, "質問", `#b-${LONG_ID}02`);
  await expect(field(shell)).toBeFocused();
  await expect(field(shell), "down there, brought into view").toBeInViewport();
  await shell.keyboard.press("Escape");
  await shell.setViewportSize({ width: 1500, height: 900 });
  await expect.poll(beside).toBe(true);
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
  const selected = () => shell.evaluate(() => getSelection()!.toString());

  await shell.keyboard.press("/");
  await shell.keyboard.type("zymurgy");
  await expect(drawn).toContainText("0/0");
  await shell.keyboard.press("Escape");
  await shell.keyboard.press("/");
  await shell.keyboard.type("closely");
  await expect(drawn, "the last paragraph's alone").toContainText("1/1");
  await shell.keyboard.press("Enter");
  expect(await selected()).toBe("closely");
  await shell.keyboard.press("Escape");

  await shell.keyboard.press("v");
  await shell.keyboard.press("v");
  await shell.keyboard.press("Shift+G");
  expect(await selected(), "from the match to the end of the article").toBe(".");
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
  expect(await app.evaluate(() => getSelection()!.toString())).not.toBe("");
  await expect(bar(app)).toHaveCount(0);
  // From the card into the article: everything between is selected.
  await app.locator(".art-title").click();
  const answer = await boxOf(card(app, "詳しく").locator(".answer"));
  const block = await boxOf(app.locator("#b-103 p"));
  await app.mouse.move(answer.x + 30, answer.y + 30);
  await app.mouse.down();
  await app.mouse.move(block.x + 200, block.y + 10, { steps: 5 });
  await app.mouse.up();
  expect(await app.evaluate(() => getSelection()!.toString())).toContain("Monitor them closely.");
  await expect(bar(app)).toHaveCount(0);
  // From the title.
  await drag(app, ".reader", "#b-102");
  expect(await app.evaluate(() => getSelection()!.toString())).toContain("Every transaction");
  await expect(bar(app)).toHaveCount(0);
  // A triple click on the last paragraph ends its selection after the blocks, with no text there.
  await app.locator("#b-107 p").click({ clickCount: 3 });
  await expect(bar(app).getByRole("button", { name: "詳しく" })).toBeVisible();
});

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
  await selectFrom(shell, `#b-${LONG_ID}05`, `#b-${LONG_ID}80`);
  await expect(bar(shell)).toBeInViewport({ ratio: 1 });
});

test("the reading place is the article's while the view is among the cards below it", async ({ shell }) => {
  await shell.setViewportSize({ width: 900, height: 700 });
  await startLong(shell);
  for (let i = 0; i < 12; i++) {
    await askElsewhere(shell, LONG_ID, LONG_ID * 100 + 2, `card ${i}`);
  }
  await expect(cards(shell)).toHaveCount(12);
  const doc = shell.locator(".doc-scroll");
  const places = () => shell.evaluate(() => localStorage.getItem("lattice.readingPlaces") ?? "");
  await doc.getByText(para(40)).evaluate((el) => el.scrollIntoView({ block: "start" }));
  await expect.poll(places).toContain(para(40));
  await doc.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect(doc.getByText(para(79))).not.toBeInViewport();
  await expect.poll(places).toContain(para(79));
  await doc.evaluate((el) => el.scrollTo(0, 0));
  await expect.poll(places).not.toContain("long article");
});

test("the print of an article leaves its stickies out", async ({ app }) => {
  await openSnapshot(app);
  await askAbout(app, "詳しく", "#b-102");
  await expect(card(app, "詳しく").locator(".answer")).toBeVisible();
  await app.emulateMedia({ media: "print" });
  await expect(app.locator(".stickies")).toBeHidden();
  await expect(app.locator("#b-102")).toBeVisible();
});
