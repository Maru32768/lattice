import { test, expect, list, listCount } from "./harness.ts";
import { ARTICLES } from "./fixtures.ts";

const all = ARTICLES.length;
const tagged = (t: string) => ARTICLES.filter((a) => a.tags.includes(t));
const postgres = tagged("postgres").length;
const both = tagged("postgres").filter((a) => a.tags.includes("mvcc")).length;
const either = ARTICLES.filter((a) => a.tags.includes("postgres") || a.tags.includes("mvcc")).length;

test("tag popover: search, AND / any, Backspace drops the last tag", async ({ app }) => {
  await list(app).getByRole("button", { name: "タグ", exact: true }).click();
  const pv = app.getByRole("dialog", { name: "タグで絞り込む" });
  const search = pv.getByRole("textbox");
  await expect(search).toBeFocused();
  await expect(pv.getByRole("group", { name: "この集合で多い" }).locator(".opt")).toHaveCount(8);

  await search.fill("postg");
  await expect(pv.getByRole("group", { name: "この集合に含まれる" }).locator(".opt").first()).toContainText("postgres");
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

  await search.focus();
  await app.keyboard.press("Backspace");
  await expect(listCount(app)).toHaveText(`${postgres} / ${all}`);
  await expect(pv.getByRole("button", { name: "postgres を解除" })).toBeVisible();

  await app.keyboard.press("Escape");
  await expect(pv).toBeHidden();
});

test("tag popover keyboard: arrows move, Space toggles, Ctrl+Enter applies", async ({ app }) => {
  await list(app).getByRole("button", { name: "タグ", exact: true }).click();
  const pv = app.getByRole("dialog", { name: "タグで絞り込む" });
  const opts = pv.getByRole("group", { name: "この集合で多い" }).locator(".opt");
  await expect(opts.first()).toHaveClass(/\bact\b/);
  await app.keyboard.press("ArrowDown");
  await expect(opts.nth(1)).toHaveClass(/\bact\b/);
  const second = (await opts.nth(1).locator(".opt-l").textContent())!;

  await app.keyboard.press("Space");
  await expect(listCount(app)).toHaveText(`${tagged(second).length} / ${all}`);

  await pv.getByRole("textbox").fill("x");
  await app.keyboard.press("Control+Enter");
  await expect(pv).toBeHidden();
  await expect(list(app).locator(".chip.on .chip-body")).toHaveText(`タグ${second}`);
});
