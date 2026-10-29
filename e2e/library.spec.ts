import { test, expect, navItem, list, listCount } from "./harness.ts";
import { ARTICLES, NOW } from "./fixtures.ts";
import type { ArticleRow } from "../src/api.ts";

const count = (f: (a: ArticleRow) => boolean) => ARTICLES.filter(f).length;
const all = ARTICLES.length;
const unread = count((a) => a.read_status === "unread");
const favorites = count((a) => a.favorite);
const recent = count((a) => NOW - Date.parse(a.saved_at) <= 7 * 86_400_000);

test("sidebar counts each scope, and a scope narrows the list", async ({ app }) => {
  await expect(navItem(app, "すべての記事").locator(".n")).toHaveText(String(all));
  await expect(navItem(app, "未読").locator(".n")).toHaveText(String(unread));
  await expect(navItem(app, "お気に入り").locator(".n")).toHaveText(String(favorites));
  await expect(navItem(app, "最近追加").locator(".n")).toHaveText(String(recent));
  await expect(listCount(app)).toHaveText(`${all} / ${all}`);

  await navItem(app, "未読").click();
  await expect(list(app).getByRole("heading", { level: 1 })).toHaveText("未読");
  await expect(listCount(app)).toHaveText(`${unread} / ${unread}`);
  // The list is virtualized: the count line, not the mounted rows, says how many it holds.

  const db = count((a) => a.genre === "データベース");
  await navItem(app, "データベース").click();
  await expect(list(app).getByRole("heading", { level: 1 })).toHaveText("データベース");
  await expect(listCount(app)).toHaveText(`${db} / ${db}`);

  // 未分類 and the two smallest genres sit behind the expander.
  await expect(navItem(app, "ネットワーク")).toHaveCount(0);
  await app.getByRole("button", { name: /他 \d+ ジャンル/ }).click();
  await navItem(app, "ネットワーク").click();
  await expect(listCount(app)).toHaveText("1 / 1");
});

test("facets AND across dimensions, show counts in the set, and clear", async ({ app }) => {
  const postgresWeekly = count((a) => a.feed_id === 1);
  await list(app).getByRole("button", { name: "ソース", exact: true }).click();
  const sources = app.getByRole("dialog", { name: "ソースで絞り込む" });
  await expect(sources.getByRole("button", { name: /Postgres Weekly/ }).locator(".c")).toHaveText(String(postgresWeekly));
  await sources.getByRole("button", { name: /Postgres Weekly/ }).click();
  await expect(listCount(app)).toHaveText(`${postgresWeekly} / ${all}`);
  await app.keyboard.press("Escape");
  await expect(sources).toBeHidden();
  await expect(list(app).locator(".chip.on")).toHaveText(/ソースPostgres Weekly/);

  const hard = count((a) => a.feed_id === 1 && a.difficulty === 4);
  await list(app).getByRole("button", { name: "難易度", exact: true }).click();
  await app.getByRole("dialog", { name: "難易度で絞り込む" }).getByRole("button", { name: /上級/ }).click();
  await app.keyboard.press("Escape");
  await expect(listCount(app)).toHaveText(`${hard} / ${all}`);

  await list(app).getByRole("button", { name: "ソースの絞り込みを解除" }).click();
  await expect(listCount(app)).toHaveText(`${count((a) => a.difficulty === 4)} / ${all}`);
  await list(app)
    .getByRole("button", { name: /クリア/ })
    .click();
  await expect(listCount(app)).toHaveText(`${all} / ${all}`);
});

test("an empty result offers to drop one condition", async ({ app }) => {
  await navItem(app, "お気に入り").click();
  await list(app).getByRole("button", { name: "ソース", exact: true }).click();
  await app
    .getByRole("dialog", { name: "ソースで絞り込む" })
    .getByRole("button", { name: /web\.dev/ })
    .click();
  await app.keyboard.press("Escape");
  await expect(list(app).getByText("この条件の記事はありません")).toBeVisible();

  const webDev = count((a) => a.feed_id === 3);
  await list(app)
    .getByRole("button", { name: `お気に入り → すべての記事 → ${webDev} 件` })
    .click();
  await expect(list(app).getByRole("heading", { level: 1 })).toHaveText("すべての記事");
  await expect(listCount(app)).toHaveText(`${webDev} / ${all}`);
});

test("最近追加 and 要対応 say what they hold in a tooltip", async ({ app }) => {
  await expect(navItem(app, "最近追加")).toHaveAttribute("title", "7 日以内に保存した記事");
  await list(app).getByRole("button", { name: "状態", exact: true }).click();
  await expect(app.getByRole("dialog", { name: "状態で絞り込む" }).getByRole("button", { name: /要対応/ })).toHaveAttribute(
    "title",
    "取得か本文の抽出に失敗した記事と、本文が短い記事",
  );
});
