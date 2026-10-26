import { test, expect, list, callsOf, navItem } from "./harness.ts";
import { ARTICLES, SNAPSHOT_ID, blocksOf } from "./fixtures.ts";

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
  await expect.poll(() => callsOf(app, "search_blocks")).toEqual([{ query: "mvcc", articles: ARTICLES.map((a) => a.id) }]);

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

test("the search scope picker shows the list's scope, with the chat's groups but no tags", async ({ app }) => {
  await navItem(app, "重要").click();
  await app.keyboard.press("/");
  const scope = app.getByLabel("検索範囲");
  await expect(scope.locator("option:checked")).toHaveText("重要");
  const labels = await scope.locator("optgroup").evaluateAll((gs) => gs.map((g) => g.getAttribute("label")));
  expect(labels).toEqual(["グループ", "ジャンル", "ソース"]);
  await scope.selectOption({ label: "手動追加" });
  await expect(scope.locator("option:checked")).toHaveText("手動追加");
});

test("facets restrict candidates before the search page limit and rerun an active query", async ({ app }) => {
  await app.keyboard.press("/");
  await app.keyboard.type("a");
  await app.keyboard.press("Enter");
  const pane = app.getByRole("region", { name: "検索結果" });
  await expect(pane.locator(".hit")).toHaveCount(30);
  const selected = ARTICLES.find((a) => a.tags.includes("crdt"))!;
  await expect(pane.locator(".sgrp .at").filter({ hasText: selected.title! })).toHaveCount(0);

  await pane.getByRole("button", { name: "タグ", exact: true }).click();
  await app.getByRole("dialog", { name: "タグで絞り込む" }).getByRole("textbox", { name: "タグを検索" }).fill("crdt");
  await app.getByRole("dialog", { name: "タグで絞り込む" }).getByRole("button", { name: /^crdt/ }).click();
  await app.keyboard.press("Escape");
  await expect.poll(async () => (await callsOf(app, "search_blocks")).at(-1)).toEqual({ query: "a", articles: [selected.id] });
  await expect(pane.locator(".sgrp .at")).toHaveText([selected.title!]);

  await pane.getByRole("button", { name: "ソース", exact: true }).click();
  await app
    .getByRole("dialog", { name: "ソースで絞り込む" })
    .getByRole("button", { name: /Postgres Weekly/ })
    .click();
  await app.keyboard.press("Escape");
  await expect.poll(async () => (await callsOf(app, "search_blocks")).at(-1)).toEqual({ query: "a", articles: [] });
  await expect(pane.locator(".search-count")).toHaveText("0 block · 0 記事");
  await expect(pane.locator(".hit")).toHaveCount(0);
});

test("an older search response cannot replace results after its scope changes", async ({ app }) => {
  await app.evaluate(() => {
    const internals: unknown = Reflect.get(window, "__TAURI_INTERNALS__");
    if (!internals || typeof internals !== "object" || !("invoke" in internals) || typeof internals.invoke !== "function") {
      throw new Error("Tauri invoke is unavailable");
    }
    const invoke = internals.invoke;
    let held = false;
    internals.invoke = (cmd: string, args?: unknown, options?: unknown): Promise<unknown> => {
      const result: Promise<unknown> = Promise.resolve(Reflect.apply(invoke, internals, [cmd, args, options]));
      if (cmd !== "search_blocks" || held) {
        return result;
      }
      held = true;
      let releaseSearch = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseSearch = resolve;
      });
      const delayed = result.then(async (value) => {
        await gate;
        return value;
      });
      Object.assign(window, { releaseSearch, searchReturned: delayed });
      return delayed;
    };
  });
  await app.keyboard.press("/");
  await app.keyboard.type("a");
  await app.keyboard.press("Enter");
  await expect.poll(async () => (await callsOf(app, "search_blocks")).length).toBe(1);
  const pane = app.getByRole("region", { name: "検索結果" });
  await pane.getByLabel("検索範囲").selectOption({ label: "お気に入り" });
  const favorites = ARTICLES.filter((a) => a.favorite);
  const expected = favorites.filter((a) => blocksOf(a).some((b) => (b.text + (b.translation ?? "")).toLowerCase().includes("a"))).map((a) => a.title!);
  await expect(pane.locator(".sgrp .at")).toHaveText(expected);
  await app.evaluate(async () => {
    const release: unknown = Reflect.get(window, "releaseSearch");
    if (typeof release !== "function") {
      throw new Error("The search response was not held");
    }
    const returned: unknown = Reflect.get(window, "searchReturned");
    if (!(returned instanceof Promise)) {
      throw new Error("The delayed search promise is unavailable");
    }
    Reflect.apply(release, window, []);
    await returned;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await expect(pane.locator(".sgrp .at")).toHaveText(expected);
  await expect.poll(async () => (await callsOf(app, "search_blocks")).length).toBe(2);
});
