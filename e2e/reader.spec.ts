import { test, expect, list, callsOf } from "./harness.ts";
import { ARTICLES, MARKDOWN_ID, SNAPSHOT_ID, blocksOf } from "./fixtures.ts";

const snapshot = ARTICLES.find((a) => a.id === SNAPSHOT_ID)!;
const blocks = blocksOf(snapshot);
const translatable = blocks.filter((b) => b.translation != null);

async function open(page: import("@playwright/test").Page, title: string) {
  await list(page).locator(".row", { hasText: title }).click();
  await expect(page.locator(".art-title")).toHaveText(title);
}

/** The language each translatable block shows: "ja" when its translation is on screen. */
const shown = (page: import("@playwright/test").Page) =>
  Promise.all(translatable.map(async (b) => ((await page.locator(`#b-${b.id}`).textContent())!.includes(b.translation!) ? "ja" : "en")));

test("the language segment switches every block; a block flips on its own", async ({ app }) => {
  await open(app, snapshot.title!);
  const seg = app.getByRole("group", { name: "表示言語" });
  // Mixed 70%: three of the five translated blocks, spread out.
  await expect(seg.getByRole("button", { name: /混在/ })).toHaveAttribute("aria-pressed", "true");
  expect(await shown(app)).toEqual(["en", "ja", "ja", "en", "ja"]);

  await seg.getByRole("button", { name: "原文", exact: true }).click();
  expect(await shown(app)).toEqual(["en", "en", "en", "en", "en"]);
  await seg.getByRole("button", { name: "訳文", exact: true }).click();
  expect(await shown(app)).toEqual(["ja", "ja", "ja", "ja", "ja"]);
  await expect(app.locator(`#b-${blocks[4].id}`)).toHaveText(blocks[4].text);

  await app.locator(`#b-${translatable[1].id}`).getByRole("button", { name: "この block を原文に切り替え" }).click();
  expect(await shown(app)).toEqual(["ja", "en", "ja", "ja", "ja"]);
  await app.locator(`#b-${translatable[1].id}`).getByRole("button", { name: "この block を訳文に切り替え" }).click();
  expect(await shown(app)).toEqual(["ja", "ja", "ja", "ja", "ja"]);

  await seg.getByRole("button", { name: "訳文の割合を下げる ([)" }).click();
  await expect(seg.getByRole("button", { name: /混在/ })).toHaveText("混在 60%");
  await app.keyboard.press("]");
  await app.keyboard.press("]");
  await expect(seg.getByRole("button", { name: /混在/ })).toHaveText("混在 80%");
});

test("the summary expands, and imported Markdown has no Page view", async ({ app }) => {
  await open(app, snapshot.title!);
  await app.getByRole("region", { name: "要約" }).getByRole("button").click();
  await expect(app.locator(".summary-body")).toContainText("MVCC で実装する");

  const md = ARTICLES.find((a) => a.id === MARKDOWN_ID)!;
  await open(app, md.title!);
  await expect(app.getByRole("group", { name: "表示" }).getByRole("button", { name: /Page/ })).toBeDisabled();
  await expect(app.locator(".art-meta")).toContainText("ローカル");
});

const untranslated = ARTICLES.find((a) => a.id % 3 === 0 && a.fetch_status === "ok" && a.title && a.language !== "ja")!;

test("picking 訳文 on an untranslated article starts its translation and shows the progress", async ({ app }) => {
  await open(app, untranslated.title!);
  const seg = app.getByRole("group", { name: "表示言語" });
  await seg.getByRole("button", { name: "訳文", exact: true }).click();
  // The Reader and the list row count the same blocks.
  await expect(app.locator(".tr-prog")).toHaveText("翻訳待ち 0 / 4 ブロック");
  await expect(list(app).locator(".row").filter({ hasText: untranslated.title! })).toContainText("翻訳中 0/4");
  await seg.getByRole("button", { name: /混在/ }).click();
  expect(await callsOf(app, "translate_article"), "queued once; the waiting job is not queued again").toEqual([{ id: untranslated.id }]);

  // A translated article is left alone.
  await open(app, snapshot.title!);
  await seg.getByRole("button", { name: "訳文", exact: true }).click();
  expect(await callsOf(app, "translate_article")).toHaveLength(1);
});

test("with 表示を切り替えたら自動で翻訳 off, switching the view translates nothing", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  await app
    .getByRole("navigation", { name: "設定カテゴリ" })
    .locator(".ni")
    .filter({ has: app.locator(".label").getByText("翻訳", { exact: true }) })
    .click();
  const onSwitch = app.getByRole("switch", { name: "表示を切り替えたら自動で翻訳" });
  await expect(onSwitch).toBeChecked();
  await onSwitch.uncheck();
  const onSave = app.getByRole("switch", { name: "保存した記事を自動で翻訳" });
  await expect(onSave).not.toBeChecked();
  await onSave.check();
  expect(await callsOf(app, "set_auto_translate")).toEqual([{ on: true }]);
  await app.getByRole("button", { name: "ライブラリに戻る" }).click();

  await open(app, untranslated.title!);
  await app.getByRole("group", { name: "表示言語" }).getByRole("button", { name: "訳文", exact: true }).click();
  await expect(app.getByRole("button", { name: "翻訳する", exact: true })).toHaveAttribute("title", "日本語に訳します");
  expect(await callsOf(app, "translate_article")).toEqual([]);
});

test("訳し直す is in the ⋯ menu, with what it does, as soon as an article has a translation", async ({ app }) => {
  await open(app, snapshot.title!);
  const more = app.getByRole("button", { name: /^その他/ });
  await more.click();
  const item = app.getByRole("menuitem", { name: /訳し直す/ });
  await expect(item).toBeEnabled();
  await expect(item).toContainText("今の設定で訳し直します");
  await item.click();
  // Snapshot isolation has 5 translated blocks, under the confirmation threshold: it goes straight away.
  expect(await callsOf(app, "translate_article")).toEqual([{ id: SNAPSHOT_ID, fresh: true }]);

  await open(app, untranslated.title!);
  await more.click();
  await expect(app.getByRole("menuitem", { name: /訳し直す/ }), "nothing to redo yet").toHaveCount(0);
});
