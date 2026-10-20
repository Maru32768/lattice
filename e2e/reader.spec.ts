import { test, expect, list } from "./harness.ts";
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
