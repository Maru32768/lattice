import { test, expect, list, callsOf, navItem } from "./harness.ts";
import { ARTICLES, QUIZ, REVIEW, SNAPSHOT_ID } from "./fixtures.ts";

async function open(page: import("@playwright/test").Page, id: number) {
  const title = ARTICLES.find((a) => a.id === id)!.title!;
  await list(page).locator(".row", { hasText: title }).click();
  await expect(page.locator(".art-title")).toHaveText(title);
}

const review = (page: import("@playwright/test").Page) => page.locator(".nav .ni").filter({ hasText: "今日の復習" });

test("理解度チェック: answer, see the source, then add the answers to review", async ({ app }) => {
  await expect(review(app).locator(".bd")).toHaveText(String(REVIEW.length));
  await open(app, SNAPSHOT_ID);
  await app.getByRole("button", { name: "理解度チェック", exact: true }).click();
  const panel = app.getByRole("complementary", { name: "理解度チェック" });
  await expect(panel.locator(".qz-n")).toHaveText(`1 / ${QUIZ.questions.length}`);

  // A wrong choice shows the answer and suggests もう一度; the suggestion can be overridden.
  await panel.getByRole("button", { name: /2 相ロック/ }).click();
  await expect(panel.getByRole("status")).toHaveText("不正解 · 答えは「MVCC」");
  await expect(panel.locator(".qz-opt.right")).toContainText("MVCC");
  await expect(panel.getByRole("button", { name: "もう一度" })).toHaveClass(/pri/);
  await expect(panel.getByRole("button", { name: "もう一度" })).toBeFocused();
  await panel.getByRole("button", { name: "難しい" }).click();

  // Recall: reveal, then jump to the passage the answer comes from.
  await expect(panel.locator(".qz-n")).toHaveText(`2 / ${QUIZ.questions.length}`);
  await panel.getByRole("textbox", { name: "自分の答え" }).fill("lost update");
  await panel.getByRole("button", { name: "答えを見る" }).click();
  await expect(panel.locator(".qz-answer")).toHaveText("答えwrite skew");
  await expect(panel.locator(".qz-mine")).toContainText("lost update");
  await panel.getByRole("button", { name: "出典へ" }).click();
  await expect(app.locator("#b-106")).toHaveClass(/is-cite/);
  await expect(app.locator("#b-106 .blk-label")).toHaveText("クイズの出典");
  await app.keyboard.press("3");
  await expect(panel.locator(".qz-n")).toHaveText(`3 / ${QUIZ.questions.length}`);

  await panel.getByRole("button", { name: /妨げない/ }).click();
  await expect(panel.getByRole("button", { name: "正解" })).toHaveClass(/pri/);
  await app.keyboard.press("Enter");
  await expect(panel.locator(".qz-score")).toHaveText("3 / 3 問 答えられました");

  await panel.locator(".qz-done").getByRole("button", { name: "復習に追加" }).click();
  await expect(panel.locator(".qz-done")).toContainText("復習中です（3 枚）");
  expect(await callsOf(app, "review_add")).toEqual([{
    quizId: QUIZ.id,
    answers: [{ question_id: 11, grade: "hard" }, { question_id: 12, grade: "good" }, { question_id: 13, grade: "good" }],
  }]);
  // Answered cards are scheduled from these answers, so today's count does not grow.
  await expect(review(app).locator(".bd")).toHaveText(String(REVIEW.length));

  await panel.locator(".qz-meta").getByRole("button", { name: "復習から外す" }).click();
  await expect(panel.locator(".qz-done").getByRole("button", { name: "復習に追加" })).toBeVisible();
});

test("理解度チェック stays open with its progress across another screen and another tab", async ({ app }) => {
  await open(app, SNAPSHOT_ID);
  await app.getByRole("button", { name: "理解度チェック", exact: true }).click();
  const panel = app.getByRole("complementary", { name: "理解度チェック" });
  await panel.getByRole("button", { name: /2 相ロック/ }).click();
  await panel.getByRole("button", { name: "難しい" }).click();
  await expect(panel.locator(".qz-n")).toHaveText(`2 / ${QUIZ.questions.length}`);

  await navItem(app, "処理状況").click();
  await expect(app.getByRole("heading", { name: "処理状況" })).toBeVisible();
  await expect(panel).toHaveCount(0);
  await app.keyboard.press("Alt+ArrowLeft");
  await expect(panel.locator(".qz-n"), "still on the second question").toHaveText(`2 / ${QUIZ.questions.length}`);

  // Another article in the same tab, then back: its panel is closed, this one's comes back.
  await open(app, 2);
  await expect(panel).toHaveCount(0);
  await open(app, SNAPSHOT_ID);
  await expect(panel.locator(".qz-n")).toHaveText(`2 / ${QUIZ.questions.length}`);
  await panel.getByRole("button", { name: "答えを見る" }).click();
  await panel.getByRole("button", { name: "正解" }).click();
  await panel.getByRole("button", { name: /妨げない/ }).click();
  await panel.getByRole("button", { name: "正解" }).click();
  await panel.locator(".qz-done").getByRole("button", { name: "復習に追加" }).click();
  expect(await callsOf(app, "review_add"), "the answer given before leaving counts").toEqual([{
    quizId: QUIZ.id,
    answers: [{ question_id: 11, grade: "hard" }, { question_id: 12, grade: "good" }, { question_id: 13, grade: "good" }],
  }]);
});

test("an article without a quiz offers to make one", async ({ app }) => {
  await open(app, 2);
  await app.getByRole("button", { name: "理解度チェック", exact: true }).click();
  const panel = app.getByRole("complementary", { name: "理解度チェック" });
  await panel.getByRole("button", { name: "クイズを作成" }).click();
  await expect(panel.locator(".qz-q")).toHaveText("1 段落目の要点は？");
  await panel.getByRole("button", { name: "理解度チェックを閉じる" }).click();
  await expect(panel).toBeHidden();
});

test("今日の復習: due cards one by one with their next intervals, then a summary", async ({ app }) => {
  await review(app).click();
  const main = app.locator(".qz-review");
  await expect(main.getByRole("heading", { level: 1 })).toHaveText("今日の復習");
  await expect(main.locator(".sub")).toHaveText(`残り ${REVIEW.length} 枚`);
  const session = main.getByRole("region", { name: "復習カード" });
  await expect(session.locator(".qz-q")).toHaveText(REVIEW[0].question);
  await session.getByRole("button", { name: "答えを見る" }).click();
  await expect(session.getByRole("button", { name: /正解/ })).toHaveText("正解6日");
  await session.getByRole("button", { name: /正解/ }).click();
  expect(await callsOf(app, "review_grade")).toEqual([{ questionId: REVIEW[0].id, grade: "good" }]);

  await expect(session.locator(".qz-q")).toHaveText(REVIEW[1].question);
  await session.getByRole("button", { name: /インデックスの不足/ }).click();
  await session.getByRole("button", { name: /もう一度/ }).click();
  await expect(main.locator(".qz-summary")).toContainText("2 枚を復習しました");
  await expect(main.locator(".qz-summary")).toContainText("今日の復習は終わりです。");
  await expect(review(app).locator(".bd")).toHaveCount(0);

  // The source of a card opens the article at that passage.
  const row = main.locator("tr", { hasText: ARTICLES[1].title! });
  await expect(row).toContainText("1 日後");
  await row.getByRole("button", { name: "外す" }).click();
  await expect(main.locator("tr", { hasText: ARTICLES[1].title! })).toHaveCount(0);
  await expect(main.locator(".qz-summary")).toContainText("復習するカードはまだありません");
});

test("a card's source opens the Reader at the passage", async ({ app }) => {
  await review(app).click();
  const session = app.getByRole("region", { name: "復習カード" });
  await session.getByRole("button", { name: "答えを見る" }).click();
  await session.getByRole("button", { name: "出典へ" }).click();
  await expect(app.locator(".art-title")).toHaveText(ARTICLES[1].title!);
  await expect(app.locator(`#b-${REVIEW[0].block_ids[0]}`)).toHaveClass(/is-cite/);
  await expect(navItem(app, "すべての記事")).toBeVisible();
});

test("Settings › 復習 sets the minimum interval with a unit", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  await app.getByRole("navigation", { name: "設定カテゴリ" }).getByRole("button", { name: "復習" }).click();
  await expect(app.getByLabel("最短間隔", { exact: true })).toHaveValue("1");
  await app.getByLabel("最短間隔の単位").selectOption("分");
  await app.getByLabel("最短間隔", { exact: true }).fill("10");
  expect((await callsOf(app, "set_review_settings")).at(-1)).toEqual({
    settings: { new_per_day: 20, reviews_per_day: 200, min_interval_minutes: 10, max_interval_days: 365 },
  });
});
