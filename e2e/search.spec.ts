import { test, expect, list, callsOf } from "./harness.ts";
import { ARTICLES, SNAPSHOT_ID } from "./fixtures.ts";

const title = (id: number) => ARTICLES.find((a) => a.id === id)!.title!;
// "mvcc" in the fixtures: a translation-only (semantic) hit in the snapshot article, and one
// paragraph each in the three other articles tagged mvcc.
const groups = [SNAPSHOT_ID, 2, 31, 36].map(title);

test("search groups hits by article, filters by match type, and Esc leaves it", async ({ app }) => {
  await app.keyboard.press("/");
  const pane = app.getByRole("region", { name: "検索結果" });
  await expect(pane.getByRole("textbox", { name: "検索語" })).toBeFocused();
  await app.keyboard.type("mvcc");
  await app.keyboard.press("Enter");
  await expect.poll(() => callsOf(app, "search_blocks")).toEqual([{ query: "mvcc", filter: { kind: "all" } }]);

  await expect(pane.locator(".search-count")).toHaveText("4 block · 4 記事");
  await expect(pane.locator(".sgrp .at")).toHaveText(groups);
  await expect(pane.locator(".sgrp").first().locator(".mt")).toHaveText(/^意味/);

  const method = pane.getByRole("group", { name: "検索方式" });
  await method.getByRole("button", { name: "全文" }).click();
  await expect(pane.locator(".sgrp .at")).toHaveText(groups.slice(1));
  await method.getByRole("button", { name: "意味" }).click();
  await expect(pane.locator(".sgrp .at")).toHaveText(groups.slice(0, 3));
  await method.getByRole("button", { name: "Hybrid" }).click();

  await pane.getByRole("textbox", { name: "検索語" }).focus();
  await app.keyboard.press("Escape");
  await expect(pane).toBeHidden();
  await expect(list(app)).toBeVisible();
});

test("the arrows move through the hits and Enter opens the Reader at the hit block", async ({ app }) => {
  await app.keyboard.press("/");
  await app.keyboard.type("mvcc");
  await app.keyboard.press("Enter");
  const pane = app.getByRole("region", { name: "検索結果" });
  await expect(pane.locator(".hit")).toHaveCount(4);

  await app.keyboard.press("ArrowDown");
  await expect(pane.locator(".hit.cur")).toContainText("Understanding MVCC bloat");
  await app.keyboard.press("Enter");
  await expect(app.locator(".art-title")).toHaveText(title(2));
  await expect(app.locator(".blk.is-hit .blk-label")).toHaveText(/検索一致/);
  await expect(app.locator(".docbar .matches")).toContainText("一致 1 / 1");
});
