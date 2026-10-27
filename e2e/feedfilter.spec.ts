import { test, expect, callsOf } from "./harness.ts";
import { REJECTED } from "./fixtures.ts";
import type { Page } from "@playwright/test";

const [sponsored, meetup] = REJECTED[1];

async function openFeeds(page: Page) {
  await page.locator(".nav").getByRole("button", { name: "管理", exact: true }).click();
  await expect(page.locator("main.manage h1")).toHaveText("フィードを管理");
}

test("a feed's rejected entries show why, and can be imported or let in by dropping the rule", async ({ app }) => {
  await openFeeds(app);
  await expect(app.locator("main.manage")).toContainText("LLM での判定に失敗したため、そのまま取り込みました: usage limit reached");
  await app.getByRole("button", { name: "Postgres Weekly の除外された記事 2 件" }).click();

  const filter = app.getByRole("region", { name: "このフィードの取り込みフィルタ" });
  await expect(filter.getByLabel("キーワード")).toHaveValue("sponsored");
  await expect(filter.getByRole("switch")).toBeChecked();
  await expect(filter.getByLabel("取り込む記事の指示")).toHaveValue("Postgres の内部実装だけ");

  const list = app.getByRole("region", { name: "除外された記事" });
  await expect(list.locator("li")).toHaveCount(2);
  await expect(list.locator("li", { hasText: sponsored.title! })).toContainText("このフィードのルール「タイトルに sponsored を含むものを除く」で除外");
  await expect(list.locator("li", { hasText: meetup.title! })).toContainText("LLM: イベント告知で内部実装の記事ではない (重要度 2)");

  await list.getByRole("button", { name: `${meetup.title} を取り込む` }).click();
  await expect(list.getByRole("status")).toHaveText(`「${meetup.title}」を取り込みました`);
  expect(await callsOf(app, "import_rejected")).toEqual([{ feedId: 1, url: meetup.url }]);
  await expect(list.locator("li")).toHaveCount(1);

  await list.getByRole("button", { name: "このルールを外す" }).click();
  await expect(list.getByRole("status")).toHaveText("再評価: 取り込み 1 件・LLM の判定待ち 0 件・除外のまま 0 件");
  expect((await callsOf(app, "set_feed_filter")).at(-1)).toMatchObject({ feedId: 1, filter: { rules: [] } });
  await expect(list).toContainText("除外された記事はありません");
  await expect(app.getByRole("button", { name: /Postgres Weekly の除外された記事/ })).toHaveCount(0);
});

test("rules are edited per feed, and a bad regex is refused with the reason", async ({ app }) => {
  await openFeeds(app);
  await app.getByRole("button", { name: "Rust Blog の名前・アイコン・取り込みフィルタを編集" }).click();
  const filter = app.getByRole("region", { name: "このフィードの取り込みフィルタ" });
  await expect(filter.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  await filter.getByRole("button", { name: "ルールを追加" }).click();
  const rule = filter.getByRole("group", { name: "ルール 1" });
  await rule.getByLabel("キーワード").fill("(release");
  await rule.getByLabel("正規表現").check();
  await rule.getByLabel("含む・除く").selectOption("include");
  await filter.getByRole("button", { name: "保存", exact: true }).click();
  await expect(filter.getByRole("alert")).toContainText("正規表現「(release」を読めません");

  await rule.getByLabel("キーワード").fill("release|edition");
  await filter.getByLabel("本文の最短文字数").fill("400");
  await filter.getByRole("button", { name: "保存", exact: true }).click();
  await expect(filter.getByRole("status")).toHaveText("保存しました");
  expect((await callsOf(app, "set_feed_filter")).at(-1)).toEqual({
    feedId: 5,
    filter: {
      rules: [{ field: "title", action: "include", pattern: "release|edition", regex: true }],
      min_chars: 400,
      llm: false,
      instruction: "",
      min_relevance: null,
    },
  });
  await filter.getByRole("button", { name: "除外分を再評価" }).click();
  await expect(filter.getByRole("status")).toHaveText("再評価: 取り込み 0 件・LLM の判定待ち 0 件・除外のまま 0 件");
});

test("the global filter lives in Settings › 取り込みフィルタ", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  await app.getByRole("navigation", { name: "設定カテゴリ" }).getByRole("button", { name: "取り込みフィルタ" }).click();
  const filter = app.getByRole("region", { name: "全体の取り込みフィルタ" });
  await filter.getByRole("switch").check();
  await filter.getByLabel("取り込む記事の指示").fill("求人と広告は除く");
  await filter.getByLabel("重要度の下限").selectOption("3");
  await filter.getByRole("button", { name: "保存", exact: true }).click();
  await expect(filter.getByRole("status")).toHaveText("保存しました");
  expect((await callsOf(app, "set_feed_filter")).at(-1)).toEqual({
    feedId: null,
    filter: { rules: [], min_chars: null, llm: true, instruction: "求人と広告は除く", min_relevance: 3 },
  });
  await filter.getByRole("button", { name: "除外分を再評価" }).click();
  expect(await callsOf(app, "reevaluate_rejected")).toEqual([{ feedId: null }]);
});
