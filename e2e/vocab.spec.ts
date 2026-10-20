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
  await page.evaluate(({ block, word }) => {
    const root = document.getElementById(`b-${block}`)!;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.textContent!.indexOf(word);
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(n, i);
      range.setEnd(n, i + word.length);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      root.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return;
    }
    throw new Error(`${word} not in block ${block}`);
  }, { block, word });
}

test("単語を登録: select a word in the Reader, save it with its sentence, and see it marked", async ({ app }) => {
  await openSnapshot(app);
  // A saved word is underlined, its meaning on hover.
  await expect(app.locator("#b-106 .vw")).toHaveText("Write skew");
  await expect(app.locator("#b-106 .vw")).toHaveAttribute("title", "書き込みスキュー");

  await select(app, 102, "consistent");
  await app.getByRole("button", { name: /単語を登録/ }).click();
  await expect(app.locator(".vw-cap")).toHaveText("「consistent」を単語帳に登録しました");
  expect(await callsOf(app, "vocab_add")).toEqual([{
    capture: { surface: "consistent", sentence: "Every transaction reads from a consistent snapshot taken when it starts.", article_id: SNAPSHOT_ID, block_id: 102, url: ARTICLES[0].original_url },
  }]);
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

test("今日の復習: a saved word comes back as a cloze after the quiz cards", async ({ app }) => {
  await openSnapshot(app);
  await select(app, 104, "block");
  await app.getByRole("button", { name: /単語を登録/ }).click();
  await expect(app.locator(".vw-cap")).toContainText("登録しました");
  const review = app.locator(".nav .ni").filter({ hasText: "今日の復習" });
  await expect(review.locator(".bd")).toHaveText(String(REVIEW.length + 1));
  await review.click();

  const session = app.getByRole("region", { name: "復習カード" });
  // The quiz cards first (due earlier), then the word.
  await session.getByRole("button", { name: "答えを見る" }).click();
  await session.getByRole("button", { name: /正解/ }).click();
  await session.getByRole("button", { name: /インデックスの不足/ }).click();
  await app.keyboard.press("Enter");

  await expect(session.locator(".vc-cloze")).toHaveText("Readers never writers.");
  await expect(session.locator(".vc-hint")).toHaveText("ヒントblock の意味");
  await session.getByRole("button", { name: "答えを見る" }).click();
  await expect(session.locator(".vc-fill")).toHaveText("block");
  await expect(session.locator(".vc-word")).toContainText("block");
  await session.getByRole("button", { name: /正解/ }).click();
  const graded = await callsOf(app, "vocab_grade");
  expect(graded).toHaveLength(1);
  expect(graded[0]).toMatchObject({ grade: "good" });
  await expect(app.locator(".qz-summary")).toContainText("3 枚を復習しました");
});

test("a word's card opens the passage it came from", async ({ app }) => {
  await openSnapshot(app);
  await select(app, 104, "writers");
  await app.getByRole("button", { name: /単語を登録/ }).click();
  await expect(app.locator(".vw-cap")).toContainText("登録しました");
  await app.locator(".nav .ni").filter({ hasText: "今日の復習" }).click();
  const session = app.getByRole("region", { name: "復習カード" });
  for (let i = 0; i < REVIEW.length; i++) {
    await session.getByRole("button", { name: "カードの操作" }).click();
    await app.getByRole("menuitem", { name: "このカードを復習から外す" }).click();
  }
  await expect(session.locator(".vc-cloze")).toBeVisible();
  await session.getByRole("button", { name: "答えを見る" }).click();
  await session.getByRole("button", { name: "出典へ" }).click();
  await expect(app.locator("#b-104")).toHaveClass(/is-cite/);
  await expect(app.locator("#b-104 .blk-label")).toHaveText("単語の出典");
});
