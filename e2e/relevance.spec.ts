import { test, expect, callsOf, list, listCount, navItem } from "./harness.ts";
import { ARTICLES } from "./fixtures.ts";

const all = ARTICLES.length;
const important = ARTICLES.filter((a) => (a.relevance ?? 0) >= 4);
const top = ARTICLES.find((a) => a.relevance === 5)!;
const stale = ARTICLES.find((a) => a.relevance_stale)!;
const low = ARTICLES.find((a) => a.relevance === 2)!;

async function openSettings(page: import("@playwright/test").Page, title: string) {
  await page.locator(".nav").getByRole("button", { name: "設定" }).click();
  await page.getByRole("navigation", { name: "設定カテゴリ" }).locator(".ni").filter({ has: page.locator(".label").getByText(title, { exact: true }) }).click();
}

test("重要 lists the important articles, which carry a mark with the reason", async ({ app }) => {
  await expect(navItem(app, "重要").locator(".n")).toHaveText(String(important.length));
  const row = (title: string) => list(app).locator(".row", { hasText: title });
  await expect(row(top.title!).locator(".imp")).toHaveText("重要 5");
  await expect(row(top.title!).locator(".imp")).toHaveAttribute("title", top.relevance_reason!);
  await expect(row(low.title!).locator(".imp"), "1-3 get no mark").toHaveCount(0);

  await navItem(app, "重要").click();
  await expect(list(app).getByRole("heading", { level: 1 })).toHaveText("重要");
  await expect(listCount(app)).toHaveText(`${important.length} / ${important.length}`);
});

test("sorting and filtering by importance; the Reader shows the reason", async ({ app }) => {
  await list(app).getByRole("button", { name: "並び順とグループ" }).click();
  await app.getByRole("menuitemradio", { name: /重要度・高い順/ }).click();
  await expect(list(app).locator(".row").first()).toContainText(top.title!);
  const note = list(app).getByText("「自分について」がないため重要度は判定していません");
  await expect(note).toBeVisible();
  // A narrow list cuts the note to one line; its title keeps the whole of it.
  await app.locator(".list").evaluate((e) => void ((e as HTMLElement).style.width = "300px"));
  await expect(note).toHaveAttribute("title", "「自分について」がないため重要度は判定していません");
  expect(await note.evaluate((e) => [e.scrollWidth > e.clientWidth, e.clientHeight < 2 * parseFloat(getComputedStyle(e).lineHeight)])).toEqual([true, true]);
  await app.locator(".list").evaluate((e) => void ((e as HTMLElement).style.width = ""));

  await list(app).getByRole("button", { name: "重要度", exact: true }).click();
  await app.getByRole("dialog", { name: "重要度で絞り込む" }).getByRole("button", { name: /必読/ }).click();
  await app.keyboard.press("Escape");
  await expect(listCount(app)).toHaveText(`1 / ${all}`);
  await list(app).getByRole("button", { name: /クリア/ }).click();

  await list(app).locator(".row", { hasText: stale.title! }).click();
  const line = app.locator(".art-relevance");
  await expect(line).toContainText(`重要度 ${stale.relevance}/5`);
  await expect(line).toContainText(stale.relevance_reason!);
  await expect(line).toContainText("以前のプロフィールで判定");
});

test("without a profile nothing is rated and settings say why; with one, scores can be redone", async ({ app }) => {
  await openSettings(app, "重要度");
  await expect(app.getByRole("note")).toContainText("「自分について」が空なので");
  await expect(app.getByRole("button", { name: "重要度を付け直す" })).toBeDisabled();

  await app.getByRole("navigation", { name: "設定カテゴリ" }).getByRole("button", { name: "要約・対話" }).click();
  await app.getByLabel("自分について").fill("PostgreSQL の運用をしている");
  await app.getByRole("button", { name: "保存", exact: true }).click();
  await app.getByRole("navigation", { name: "設定カテゴリ" }).getByRole("button", { name: "重要度" }).click();
  await expect(app.getByRole("note")).toHaveCount(0);
  await app.getByRole("button", { name: "重要度を付け直す" }).click();
  const outdated = ARTICLES.filter((a) => a.extraction_status === "ok" && (a.relevance == null || a.relevance_stale)).length;
  await expect(app.getByRole("status")).toHaveText(`${outdated} 件を判定キューに追加しました`);
  expect(await callsOf(app, "rescore_relevance")).toEqual([{ ids: null }]);

  await app.getByLabel("「重要」に入れる重要度").selectOption("5");
  await app.getByRole("button", { name: "ライブラリに戻る" }).click();
  await expect(navItem(app, "重要").locator(".n")).toHaveText("1");

  // The shown articles can be rated again from the list.
  await navItem(app, "重要").click();
  await list(app).getByRole("button", { name: "重要度を付け直す" }).click();
  await expect(list(app).getByRole("status")).toHaveText("1 件を判定キューに追加しました");
  expect((await callsOf(app, "rescore_relevance")).at(-1)).toEqual({ ids: [top.id] });
});
