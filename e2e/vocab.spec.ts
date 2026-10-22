import { test, expect, list, callsOf, navItem } from "./harness.ts";
import { ARTICLES, REVIEW, SNAPSHOT_ID, VOCAB } from "./fixtures.ts";
import type { Page } from "@playwright/test";

async function openSnapshot(page: Page) {
  const title = ARTICLES.find((a) => a.id === SNAPSHOT_ID)!.title!;
  await list(page).locator(".row", { hasText: title }).click();
  await expect(page.locator(".art-title")).toHaveText(title);
  // The English text, where words are selected and marked.
  await page.locator(".docbar").getByRole("button", { name: "原文", exact: true }).click();
}

/** Selects `word` inside block `block` as a mouse would, ending with mouseup. */
async function select(page: Page, block: number, word: string) {
  await page.evaluate(
    ({ block, word }) => {
      const root = document.getElementById(`b-${block}`)!;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = n.textContent!.indexOf(word);
        if (i < 0) {
          continue;
        }
        const range = document.createRange();
        range.setStart(n, i);
        range.setEnd(n, i + word.length);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(range);
        root.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        return;
      }
      throw new Error(`${word} not in block ${block}`);
    },
    { block, word },
  );
}

test("単語を登録: select a word in the Reader, save it with its sentence, and see it marked", async ({ app }) => {
  await openSnapshot(app);
  // A saved word is underlined, its meaning on hover.
  await expect(app.locator("#b-106 .vw")).toHaveText("Write skew");
  await expect(app.locator("#b-106 .vw")).toHaveAttribute("title", "書き込みスキュー");

  await select(app, 102, "consistent");
  await app.getByRole("button", { name: /単語を登録/ }).click();
  await expect(app.locator(".vw-cap")).toHaveText("「consistent」を単語帳に登録しました");
  expect(await callsOf(app, "vocab_add")).toEqual([
    {
      capture: {
        surface: "consistent",
        sentence: "Every transaction reads from a consistent snapshot taken when it starts.",
        article_id: SNAPSHOT_ID,
        block_id: 102,
        url: ARTICLES[0].original_url,
      },
    },
  ]);
  await expect(app.locator("#b-102 .vw")).toHaveText("consistent");

  // The shortcut saves the selection too; a form already in the book gains the sentence.
  await select(app, 103, "multi-version");
  await expect(app.getByRole("button", { name: /単語を登録/ })).toBeVisible();
  await app.keyboard.press("w");
  await expect(app.locator(".vw-cap")).toHaveText("「multi-version」を単語帳に登録しました");
  await select(app, 106, "snapshot isolation");
  await app.keyboard.press("w");
  await expect.poll(async () => (await callsOf(app, "vocab_add")).length).toBe(3);

  // Japanese text offers nothing.
  await app.locator(".docbar").getByRole("button", { name: "訳文", exact: true }).click();
  await select(app, 102, "スナップショット");
  await expect(app.getByRole("button", { name: /単語を登録/ })).toBeHidden();
});

test("単語帳: search, edit a meaning, suspend, export and delete", async ({ app }) => {
  await navItem(app, "単語帳").click();
  const main = app.locator(".vocab");
  await expect(main.getByRole("heading", { level: 1 })).toHaveText("単語帳");
  await expect(main.locator(".sub")).toHaveText(`${VOCAB.length} 語`);
  const row = (word: string) => main.locator("tbody tr", { hasText: word });
  await expect(row("write skew").locator(".ctx b")).toHaveText("Write skew");
  await expect(row("bloat")).toContainText("取得に失敗");

  await main.getByRole("searchbox", { name: "単語・意味で検索" }).fill("スキュー");
  await expect(main.locator("tbody tr")).toHaveCount(1);
  await main.getByRole("searchbox", { name: "単語・意味で検索" }).fill("");

  await row("bloat").getByRole("button", { name: "bloat の操作" }).click();
  await app.getByRole("menuitem", { name: "意味を編集" }).click();
  await main.getByRole("textbox", { name: "bloat の意味" }).fill("肥大化");
  await main.getByRole("button", { name: "保存" }).click();
  expect(await callsOf(app, "vocab_set_meaning")).toEqual([{ id: 1, meaning: "肥大化" }]);
  await expect(row("bloat")).toContainText("肥大化");

  // A ready word can be asked again (an entry from before the learner's-dictionary prompt).
  await row("write skew").getByRole("button", { name: "write skew の操作" }).click();
  await app.getByRole("menuitem", { name: /意味と例文を再生成/ }).click();
  expect(await callsOf(app, "vocab_retry")).toEqual([{ id: 2 }]);

  await row("write skew").getByRole("button", { name: "write skew の操作" }).click();
  await app.getByRole("menuitem", { name: "復習を停止" }).click();
  await expect(row("write skew")).toContainText("停止中");
  expect(await callsOf(app, "vocab_suspend")).toEqual([{ id: 2, suspended: true }]);

  await main.getByRole("button", { name: "CSV に書き出す" }).click();
  await expect(main.getByRole("status")).toContainText("lattice-vocab-20261020T030000Z.csv");

  await row("bloat").getByRole("button", { name: "bloat の操作" }).click();
  await app.getByRole("menuitem", { name: "削除" }).click();
  await app.getByRole("alertdialog", { name: "「bloat」を削除しますか？" }).getByRole("button", { name: "削除" }).click();
  await expect(row("bloat")).toHaveCount(0);
  expect(await callsOf(app, "vocab_delete")).toEqual([{ id: 1 }]);

  // Marking is a setting of the book.
  await main.getByRole("switch", { name: "記事中の登録語に下線を引く" }).uncheck();
  await navItem(app, "すべての記事").click();
  await openSnapshot(app);
  await expect(app.locator("#b-106 .vw")).toHaveCount(0);
});

/**
 * Replaces the Web Speech API before the app loads: `voices` are what the system offers, and what
 * the app says is recorded in `window.__spoken`.
 */
async function speech(page: Page, voices: { name: string; lang: string; localService: boolean }[]) {
  await page.addInitScript((voices) => {
    const spoken: string[] = [];
    Object.assign(window, { __spoken: spoken });
    const synth = Object.assign(new EventTarget(), {
      getVoices: () => voices,
      speak: (u: { text: string }) => spoken.push(u.text),
      cancel: () => {},
    });
    Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
    Object.defineProperty(window, "SpeechSynthesisUtterance", {
      value: class {
        text: string;
        constructor(text: string) {
          this.text = text;
        }
      },
      configurable: true,
    });
  }, voices);
  await page.goto("/");
  await expect(list(page).locator(".row").first()).toBeVisible({ timeout: 30_000 });
}
const spoken = (page: Page) => page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken);

/** Saves `word` from block 104 and opens today's review at its card, the quiz cards taken out. */
async function reviewWord(page: Page, word: string, beforeStart?: () => Promise<void>) {
  await openSnapshot(page);
  await select(page, 104, word);
  await page.getByRole("button", { name: /単語を登録/ }).click();
  await expect(page.locator(".vw-cap")).toContainText("登録しました");
  const review = page.locator(".nav .ni").filter({ hasText: "今日の復習" });
  await expect(review.locator(".bd")).toHaveText(String(REVIEW.length + 1));
  await review.click();
  // The cards wait for a press: a word card speaks as it appears.
  const start = page.getByRole("button", { name: "復習を始める" });
  await expect(start).toBeFocused();
  await beforeStart?.();
  await start.click();
  const session = page.getByRole("region", { name: "復習カード" });
  for (let i = 0; i < REVIEW.length; i++) {
    await session.getByRole("button", { name: "カードの操作" }).click();
    await page.getByRole("menuitem", { name: "このカードを復習から外す" }).click();
  }
  await expect(session.locator(".vc-word")).toBeVisible();
  return session;
}

test("今日の復習: a saved word is a word → meaning card, said aloud", async ({ shell: app }) => {
  await speech(app, [
    { name: "Haruka", lang: "ja-JP", localService: true },
    { name: "Zira", lang: "en-US", localService: true },
  ]);
  const session = await reviewWord(app, "block", async () => {
    await app.waitForTimeout(300);
    expect(await spoken(app), "nothing is said before the review starts").toEqual([]);
  });

  // Front: the word, its part of speech, and nothing that gives the meaning away.
  await expect(session.locator(".vc-word")).toHaveText("block");
  await expect(session.locator(".vc-pos")).toHaveText("noun");
  await expect(session.getByText("block is a word the mock explains.")).toHaveCount(0);
  await expect(session.getByText("block の意味")).toHaveCount(0);
  await expect.poll(() => spoken(app)).toEqual(["block"]);
  await session.getByRole("button", { name: "発音を聞く" }).click();
  await app.keyboard.press("r");
  await expect.poll(() => spoken(app)).toEqual(["block", "block", "block"]);

  await session.getByRole("button", { name: "答えを見る" }).click();
  await expect(session.getByRole("region", { name: "意味" })).toHaveText("意味block is a word the mock explains.");
  await expect(session.getByRole("region", { name: "例文" })).toContainText("An example sentence with block.");
  await session.getByRole("button", { name: "例文を聞く" }).click();
  await expect.poll(() => spoken(app)).toEqual(["block", "block", "block", "An example sentence with block."]);
  await expect(session.locator(".vc-gloss")).toHaveText("日本語block の意味");
  await expect(session.locator(".vc-context b")).toHaveText("block");
  await expect(session.getByRole("button", { name: "出典へ" })).toBeVisible();

  await session.getByRole("button", { name: /正解/ }).click();
  const graded = await callsOf(app, "vocab_grade");
  expect(graded).toHaveLength(1);
  expect(graded[0]).toMatchObject({ grade: "good" });
  await expect(app.locator(".qz-summary")).toContainText("1 枚を復習しました");
});

test("without an offline English voice the card is silent and has no audio buttons", async ({ shell: app }) => {
  await speech(app, [
    { name: "Haruka", lang: "ja-JP", localService: true },
    { name: "Aria Online", lang: "en-US", localService: false },
  ]);
  const session = await reviewWord(app, "block");
  await expect(session.locator(".vc-word")).toHaveText("block");
  await expect(session.getByRole("button", { name: "発音を聞く" })).toHaveCount(0);
  await app.keyboard.press("r");
  await session.getByRole("button", { name: "答えを見る" }).click();
  await expect(session.getByRole("region", { name: "例文" })).toContainText("An example sentence with block.");
  await expect(session.getByRole("button", { name: "例文を聞く" })).toHaveCount(0);
  expect(await spoken(app)).toEqual([]);
});

test("auto-play can be turned off in Settings › 復習; the buttons still speak", async ({ shell: app }) => {
  await speech(app, [{ name: "Hazel", lang: "en-GB", localService: true }]);
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  await app.getByRole("navigation", { name: "設定カテゴリ" }).getByRole("button", { name: "復習" }).click();
  await app.getByRole("switch", { name: "単語カードの発音を自動で再生" }).uncheck();
  // The first Esc leaves the switch, the second the settings.
  await app.keyboard.press("Escape");
  await app.keyboard.press("Escape");
  const session = await reviewWord(app, "block");
  await expect(session.getByRole("button", { name: "発音を聞く" })).toBeVisible();
  expect(await spoken(app)).toEqual([]);
  await session.getByRole("button", { name: "発音を聞く" }).click();
  await expect.poll(() => spoken(app)).toEqual(["block"]);
});

test("a word's card opens the passage it came from", async ({ app }) => {
  await openSnapshot(app);
  await select(app, 104, "writers");
  await app.getByRole("button", { name: /単語を登録/ }).click();
  await expect(app.locator(".vw-cap")).toContainText("登録しました");
  await app.locator(".nav .ni").filter({ hasText: "今日の復習" }).click();
  await app.getByRole("button", { name: "復習を始める" }).click();
  const session = app.getByRole("region", { name: "復習カード" });
  for (let i = 0; i < REVIEW.length; i++) {
    await session.getByRole("button", { name: "カードの操作" }).click();
    await app.getByRole("menuitem", { name: "このカードを復習から外す" }).click();
  }
  await expect(session.locator(".vc-word")).toHaveText("writers");
  await session.getByRole("button", { name: "答えを見る" }).click();
  await session.getByRole("button", { name: "出典へ" }).click();
  await expect(app.locator("#b-104")).toHaveClass(/is-cite/);
  await expect(app.locator("#b-104 .blk-label")).toHaveText("単語の出典");
});
