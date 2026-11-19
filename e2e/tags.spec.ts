import { test, expect, list, listCount } from "./harness.ts";
import type { Page } from "@playwright/test";
import { ARTICLES } from "./fixtures.ts";

const all = ARTICLES.length;
const tagged = (t: string) => ARTICLES.filter((a) => a.tags.includes(t));
const postgres = tagged("postgres").length;
const both = tagged("postgres").filter((a) => a.tags.includes("mvcc")).length;
const either = ARTICLES.filter((a) => a.tags.includes("postgres") || a.tags.includes("mvcc")).length;
const tags = [...new Set(ARTICLES.flatMap((a) => a.tags))];
const tagsInSet = tags.length;
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
  await app.keyboard.press("Tab");
  await expect(search, "Tab with nothing typed completes nothing").toHaveValue("");

  await search.fill("postg");
  await expect(options.first()).toContainText("postgres");
  await expect(pv.getByText(`${tags.filter((t) => t.includes("postg")).length}件一致`, { exact: true })).toBeVisible();
  await search.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await search.dispatchEvent("keydown", { key: " ", isComposing: true });
  await expect(search, "the Enter and Space that end a conversion neither clear the search").toHaveValue("postg");
  await expect(list(app).locator(".chip.on"), "nor pick").toHaveCount(0);
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
  await search.fill("mvcc");
  await app.keyboard.press("Enter");
  await expect(listCount(app), "Enter on a chosen tag drops it").toHaveText(`${postgres} / ${all}`);
  await search.fill("mvcc");
  await app.keyboard.press("Enter");
  await expect(listCount(app)).toHaveText(`${either} / ${all}`);

  await app.keyboard.press("Backspace");
  await expect(listCount(app)).toHaveText(`${postgres} / ${all}`);
  await expect(pv.getByRole("button", { name: "postgresを解除" })).toBeVisible();
  await search.fill("postg");
  await app.keyboard.press("Backspace");
  await expect(search, "Backspace while typing deletes a letter").toHaveValue("post");
  await expect(listCount(app), "and keeps the tags").toHaveText(`${postgres} / ${all}`);

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

  await app.keyboard.press("Space");
  await expect(listCount(app)).toHaveText(`${tagged(second).length} / ${all}`);
  const together = (l: string) => String(tagged(second).filter((a) => a.tags.includes(l)).length);
  // Labels and counts read at once: Virtuoso may still be drawing more rows.
  await expect(async () => {
    const labels = await opts.locator(".opt-l").allTextContents();
    expect(await opts.locator(".c").allTextContents(), "every count is now the articles that also have the picked tag").toEqual(labels.map(together));
  }).toPass({ timeout: 15_000 });
  const none = (await opts.locator(".opt-l").allTextContents()).findIndex((l) => together(l) === "0");
  expect(none).toBeGreaterThanOrEqual(0);
  await expect(opts.nth(none), "a tag no such article has is faint").toHaveClass(/\bzero\b/);
  await expect(opts.nth(1), "one they have is not").not.toHaveClass(/\bzero\b/);
  await expect(opts.nth(1), "a picked tag stays in its row, checked").toHaveAttribute("aria-selected", "true");
  await expect(opts.nth(1).locator(".opt-l")).toHaveText(second);
  await expect(opts.nth(1)).toHaveClass(/\bact\b/);
  await expect(opts.nth(0)).toHaveAttribute("aria-selected", "false");
  await app.keyboard.press("Space");
  await expect(opts.nth(1), "Space again drops it").toHaveAttribute("aria-selected", "false");
  await expect(list(app).locator(".chip.on")).toHaveCount(0);
  await app.keyboard.press("Space");
  await expect(opts.nth(1)).toHaveAttribute("aria-selected", "true");

  const first = (await opts.nth(0).locator(".opt-l").textContent())!;
  await pv.getByRole("combobox").fill(first);
  await expect(pv.locator("[role=option].act .opt-l")).toHaveText(first);
  await app.keyboard.press("Control+Enter");
  await expect(pv).toBeHidden();
  await expect(list(app).locator(".chip.on .chip-body"), "Ctrl+Enter closes without picking the highlighted tag").toHaveText(`タグ${second}`);
  await expect(listCount(app)).toHaveText(`${tagged(second).length} / ${all}`);
});

test("a click on a tag leaves every row and the popover where they were, down the list and as the chosen tags wrap", async ({ shell: app }) => {
  // In the widest list the tag chip moves ahead of the others on the first pick, and its label grows with each.
  await app.addInitScript(() => localStorage.setItem("lattice.paneWidths", JSON.stringify({ list: 640 })));
  await app.goto("/");
  await expect(list(app).locator(".row").first()).toBeVisible({ timeout: 30_000 });
  await openFilter(app);
  const pv = filter(app);
  // Placed: Radix parks a popover above the window until it has measured it.
  await expect(pv).toBeInViewport();
  const { x, y } = (await pv.boundingBox())!;
  const chip = (await list(app).getByRole("button", { name: "タグ", exact: true }).boundingBox())!;
  // Off the top, where a list drawn anew would scroll back.
  await app.keyboard.press("PageDown");
  for (let i = 0; i < 6; i++) {
    const row = pv.locator(`[id="${await pv.locator("[role=option].act").getAttribute("id")}"]`);
    const label = (await row.locator(".opt-l").textContent())!;
    const at = (await row.boundingBox())!.y;
    await row.click();
    await expect(pv.getByRole("button", { name: `${label}を解除` })).toBeVisible();
    await expect(row.locator(".opt-l")).toHaveText(label);
    expect((await row.boundingBox())!.y, "the next click at the same place hits the same tag").toBe(at);
    expect((await pv.boundingBox())!, "the popover stays where it opened").toMatchObject({ x, y });
    await app.keyboard.press("ArrowDown");
  }
  const moved = (await list(app).locator(".chip.on", { hasText: "タグ" }).boundingBox())!;
  expect(moved, "the picks moved the tag chip").not.toMatchObject({ x: chip.x, y: chip.y });
  const lines = await pv.locator(".pv-chips .chip").evaluateAll((cs) => new Set(cs.map((c) => c.getBoundingClientRect().top)).size);
  expect(lines, "the chosen tags took a second line").toBeGreaterThan(1);
});

test("after the first pick replaced the tag chip, a narrower window puts the filter under the chip of now", async ({ shell: app }) => {
  await app.addInitScript(() => localStorage.setItem("lattice.paneWidths", JSON.stringify({ list: 640 })));
  await app.goto("/");
  await expect(list(app).locator(".row").first()).toBeVisible({ timeout: 30_000 });
  await openFilter(app);
  const pv = filter(app);
  await expect(pv).toBeInViewport();
  await pv.getByRole("option").nth(2).click();
  const chip = list(app).locator(".chip.on", { hasText: "タグ" });
  await expect(chip).toBeVisible();
  await app.setViewportSize({ width: 1300, height: 880 });
  const under = async () => {
    const c = (await chip.boundingBox())!;
    const p = (await pv.boundingBox())!;
    return { gap: Math.round(p.y - c.y - c.height), dx: Math.round(p.x - c.x) };
  };
  await expect.poll(under).toEqual({ gap: 4, dx: 0 });
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
  for (let i = 0; i < 4; i++) {
    await app.keyboard.press("PageDown");
  }
  await expect(active).toBeInViewport();
  await app.mouse.wheel(0, -30 * 400);
  await expect(options.first()).toBeInViewport();
  await expect(search, "also one that scrolled out below").not.toHaveAttribute("aria-activedescendant");
  await app.keyboard.press("Escape");

  await list(app).locator(".row", { hasText: a.title! }).click({ button: "right" });
  await app.getByRole("menu", { name: "記事のメニュー" }).getByRole("menuitem", { name: "タグを編集…" }).click();
  const picker = app.getByRole("dialog", { name: "タグ" }).getByRole("option");
  await expect.poll(async () => Number(await picker.first().getAttribute("aria-setsize"))).toBeGreaterThan(2000);
  expect(await picker.count()).toBeLessThan(60);
});

test("a filter with no search keeps its keys: j moves, Enter picks, Backspace drops the last, Ctrl+Enter closes without a pick", async ({ app }) => {
  await list(app).getByRole("button", { name: "ジャンル", exact: true }).click();
  const pv = app.getByRole("dialog", { name: "ジャンルで絞り込む" });
  const opts = pv.locator(".opt");
  const chip = list(app).locator(".chip.on .chip-body");
  await expect(opts.nth(0)).toHaveClass(/\bact\b/);
  await app.keyboard.press("j");
  await expect(opts.nth(1)).toHaveClass(/\bact\b/);
  const genre = (await opts.nth(1).locator(".opt-l").textContent())!;
  await app.keyboard.press("Enter");
  await expect(chip).toContainText(genre);
  await expect(opts.nth(1)).toHaveAttribute("aria-pressed", "true");
  await expect(opts.nth(0), "Enter puts the highlight back on the first").toHaveClass(/\bact\b/);
  await app.keyboard.press("Space");
  await expect(opts.nth(0)).toHaveAttribute("aria-pressed", "true");
  await app.keyboard.press("Backspace");
  await expect(opts.nth(0), "Backspace drops the last pick").toHaveAttribute("aria-pressed", "false");
  await expect(opts.nth(1), "and keeps the one before").toHaveAttribute("aria-pressed", "true");
  await app.keyboard.press("Backspace");
  await expect(chip).toHaveCount(0);
  await app.keyboard.press("Control+Enter");
  await expect(pv).toBeHidden();
  await expect(chip, "Ctrl+Enter picks nothing").toHaveCount(0);
});

test("the tag editor opened from a row moves with the list's scroll", async ({ app }) => {
  const title = (await list(app).locator(".row").nth(1).locator(".t").textContent())!;
  const row = list(app).locator(".row", { hasText: title });
  await row.click({ button: "right" });
  await app.getByRole("menu", { name: "記事のメニュー" }).getByRole("menuitem", { name: "タグを編集…" }).click();
  const pv = app.getByRole("dialog", { name: "タグ" });
  await expect(pv).toBeInViewport();
  const r = (await row.boundingBox())!;
  const p = (await pv.boundingBox())!;
  await list(app)
    .locator(".list-body")
    .evaluate((e) => (e.scrollTop = 60));
  await expect.poll(async () => Math.round((await row.boundingBox())!.y - r.y)).toBe(-60);
  await expect.poll(async () => Math.round((await pv.boundingBox())!.y - p.y), "the editor moves with its row").toBe(-60);
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
