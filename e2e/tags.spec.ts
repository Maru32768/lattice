import { test, expect, list, listCount } from "./harness.ts";
import type { Page } from "@playwright/test";
import { ARTICLES } from "./fixtures.ts";

const all = ARTICLES.length;
const tagged = (t: string) => ARTICLES.filter((a) => a.tags.includes(t));
const postgres = tagged("postgres").length;
const both = tagged("postgres").filter((a) => a.tags.includes("mvcc")).length;
const either = ARTICLES.filter((a) => a.tags.includes("postgres") || a.tags.includes("mvcc")).length;
const tagsInSet = new Set(ARTICLES.flatMap((a) => a.tags)).size;
const filter = (app: Page) => app.getByRole("dialog", { name: "タグで絞り込む" });
const openFilter = (app: Page) => list(app).getByRole("button", { name: "タグ", exact: true }).click();

test("tag popover: every tag in the set, search, AND / any, Backspace drops the last tag", async ({ app }) => {
  await openFilter(app);
  const pv = filter(app);
  const search = pv.getByRole("combobox", { name: "タグを検索" });
  const options = pv.getByRole("listbox", { name: "タグ" }).getByRole("option");
  await expect(search).toBeFocused();
  await expect(options.first(), "no top few: every tag in the set is an option").toHaveAttribute("aria-setsize", String(tagsInSet));
  await expect(options.first()).toHaveAttribute("aria-description", "この集合に含まれる");

  await search.fill("postg");
  await expect(options.first()).toContainText("postgres");
  await expect(pv.getByText(/^\d+件一致$/)).toBeVisible();
  await app.keyboard.press("Enter");
  await expect(search).toHaveValue("");
  await expect(listCount(app)).toHaveText(`${postgres} / ${all}`);

  await search.fill("mvcc");
  await app.keyboard.press("Enter");
  await expect(listCount(app)).toHaveText(`${both} / ${all}`);
  await expect(list(app).locator(".chip.on .chip-body")).toHaveText("タグpostgres + mvcc");

  await pv.getByRole("button", { name: "いずれか" }).click();
  await expect(listCount(app)).toHaveText(`${either} / ${all}`);
  await expect(list(app).locator(".chip.on .chip-body")).toHaveText("タグpostgres / mvcc");
  await expect(search, "a press on the mode keeps the focus in the search").toBeFocused();

  await app.keyboard.press("Backspace");
  await expect(listCount(app)).toHaveText(`${postgres} / ${all}`);
  await expect(pv.getByRole("button", { name: "postgresを解除" })).toBeVisible();

  await search.fill("no-such-tag");
  await expect(pv.getByText("該当なし")).toBeVisible();
  await expect(pv.getByRole("listbox"), "no list without a match").toHaveCount(0);
  await expect(search).toHaveAttribute("aria-expanded", "false");
  await expect(search).not.toHaveAttribute("aria-controls");

  await app.keyboard.press("Escape");
  await expect(pv).toBeHidden();
});

test("tag popover keyboard: arrows move, Space toggles and the tag keeps its row, Ctrl+Enter applies", async ({ app }) => {
  await openFilter(app);
  const pv = filter(app);
  const box = pv.getByRole("listbox", { name: "タグ" });
  const opts = box.getByRole("option");
  await expect(box).toHaveAttribute("aria-multiselectable", "true");
  await expect(opts.first()).toHaveClass(/\bact\b/);
  await app.keyboard.press("ArrowDown");
  await expect(opts.nth(1)).toHaveClass(/\bact\b/);
  const second = (await opts.nth(1).locator(".opt-l").textContent())!;
  const labels = await opts.locator(".opt-l").allTextContents();

  await app.keyboard.press("Space");
  await expect(listCount(app)).toHaveText(`${tagged(second).length} / ${all}`);
  const together = labels.map((l) => tagged(second).filter((a) => a.tags.includes(l)).length);
  await expect(opts.locator(".c"), "every count is now the articles that also have the picked tag").toHaveText(together.map(String));
  expect(together).toContain(0);
  await expect(opts.nth(together.indexOf(0)), "a tag no such article has is faint").toHaveClass(/\bzero\b/);
  await expect(opts.nth(1), "a picked tag stays in its row, checked").toHaveAttribute("aria-selected", "true");
  await expect(opts.nth(1).locator(".opt-l")).toHaveText(second);
  await expect(opts.nth(1)).toHaveClass(/\bact\b/);
  await expect(opts.nth(0)).toHaveAttribute("aria-selected", "false");

  const first = (await opts.nth(0).locator(".opt-l").textContent())!;
  await pv.getByRole("combobox").fill(first);
  await expect(pv.locator("[role=option].act .opt-l")).toHaveText(first);
  await app.keyboard.press("Control+Enter");
  await expect(pv).toBeHidden();
  await expect(list(app).locator(".chip.on .chip-body"), "Ctrl+Enter closes without picking the highlighted tag").toHaveText(`タグ${second}`);
  await expect(listCount(app)).toHaveText(`${tagged(second).length} / ${all}`);
});

test("a click on a tag leaves every row where it was, also when the chosen tags first show", async ({ app }) => {
  await openFilter(app);
  const pv = filter(app);
  const third = pv.getByRole("option").nth(2);
  const label = (await third.locator(".opt-l").textContent())!;
  const y = (await third.boundingBox())!.y;
  await third.click();
  await expect(pv.getByRole("button", { name: `${label}を解除` })).toBeVisible();
  await expect(third.locator(".opt-l")).toHaveText(label);
  expect((await third.boundingBox())!.y, "the next click at the same place hits the same tag").toBe(y);
});

test("Tab completes the search to the highlighted tag, and Enter then toggles that tag, also one outside the set", async ({ app }) => {
  const other = ARTICLES.find((a) => !a.tags.includes("kafka"))!;
  await app.evaluate(async (id) => {
    const { invoke } = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
    await invoke("add_tag", { id, name: "stream" });
    await window.__e2e.emit("article-changed", id);
  }, other.id);
  await openFilter(app);
  const pv = filter(app);
  const search = pv.getByRole("combobox");
  await search.fill("kafk");
  await app.keyboard.press("Tab");
  await expect(search).toHaveValue("kafka");
  await app.keyboard.press("Enter");
  await expect(list(app).locator(".chip.on .chip-body")).toHaveText("タグkafka");

  // "streaming" is in the set of kafka articles and "stream" is not: a new search lists it first.
  const active = pv.locator("[role=option].act .opt-l");
  await expect(async () => {
    await search.fill("");
    await search.fill("strea");
    await expect(pv.locator(".opt-l", { hasText: /^stream$/ })).toBeVisible({ timeout: 1000 });
  }).toPass();
  await expect(active).toHaveText("streaming");
  await app.keyboard.press("ArrowDown");
  await expect(active).toHaveText("stream");
  await app.keyboard.press("Tab");
  await expect(search).toHaveValue("stream");
  await expect(active, "the search names a tag: the highlight starts on it, not on the first match").toHaveText("stream");
  await app.keyboard.press("Enter");
  await expect(list(app).locator(".chip.on .chip-body")).toHaveText("タグkafka + stream");
  await expect(listCount(app)).toHaveText(`0 / ${all}`);
});

test("both tag popovers list thousands of tags, draw only those in view, and name the highlighted one only while it is drawn", async ({ app }) => {
  const a = ARTICLES.find((x) => x.title && x.fetch_status === "ok")!;
  await app.evaluate(async (id) => {
    const { invoke } = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
    await Promise.all(Array.from({ length: 2000 }, (_, i) => invoke("add_tag", { id, name: `zz-${String(i).padStart(4, "0")}` })));
    await window.__e2e.emit("article-changed", id);
  }, a.id);
  const pv = filter(app);
  const options = pv.getByRole("option");
  const search = pv.getByRole("combobox");
  // An open list keeps the rows it opened with: open it again until the library has the new tags.
  await expect(async () => {
    if (await pv.isVisible()) {
      await app.keyboard.press("Escape");
    }
    await openFilter(app);
    expect(Number(await options.first().getAttribute("aria-setsize"))).toBeGreaterThan(2000);
  }).toPass();
  expect(await options.count()).toBeLessThan(60);
  await expect(search).toHaveAttribute("aria-activedescendant", (await options.first().getAttribute("id"))!);

  await pv.getByRole("listbox").hover();
  await app.mouse.wheel(0, 30 * 400);
  await expect(options.first()).not.toHaveClass(/\bact\b/);
  await expect(search, "the highlighted row scrolled out and was unmounted: the field names no row").not.toHaveAttribute("aria-activedescendant");
  await app.keyboard.press("ArrowDown");
  const active = pv.locator("[role=option].act");
  await expect(active).toBeInViewport();
  await expect(search).toHaveAttribute("aria-activedescendant", (await active.getAttribute("id"))!);
  await app.keyboard.press("Escape");

  await list(app).locator(".row", { hasText: a.title! }).click({ button: "right" });
  await app.getByRole("menu", { name: "記事のメニュー" }).getByRole("menuitem", { name: "タグを編集…" }).click();
  const picker = app.getByRole("dialog", { name: "タグ" }).getByRole("option");
  await expect.poll(async () => Number(await picker.first().getAttribute("aria-setsize"))).toBeGreaterThan(2000);
  expect(await picker.count()).toBeLessThan(60);
});

test("closing a facet popover returns focus to its chip, also after the first pick replaced the chip", async ({ app }) => {
  await list(app).getByRole("button", { name: "ジャンル", exact: true }).click();
  const pv = app.getByRole("dialog", { name: "ジャンルで絞り込む" });
  await app.keyboard.press("Space");
  await expect(list(app).locator(".chip.on .chip-body")).toContainText("ジャンル");
  await app.keyboard.press("Escape");
  await expect(pv).toBeHidden();
  const chip = list(app).locator(".chip.on .chip-body");
  await expect(chip).toBeFocused();

  await app.keyboard.press("Enter");
  await expect(pv).toBeVisible();
  await app.keyboard.press("Escape");
  await expect(chip, "an already active chip gets focus back too").toBeFocused();

  await chip.click();
  await app.keyboard.press("Space");
  await expect(list(app).locator(".chip.on")).toHaveCount(0);
  await expect(pv).toBeVisible();
  await list(app).getByRole("button", { name: "ジャンル", exact: true }).click();
  await expect(pv, "the replaced chip still toggles its popover closed").toBeHidden();
  await expect(list(app).getByRole("button", { name: "ジャンル", exact: true })).toBeFocused();
});
