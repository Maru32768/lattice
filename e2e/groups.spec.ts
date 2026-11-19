import { test, expect, navItem, list, listCount, callsOf, chatScope, scopeDialog } from "./harness.ts";
import type { Page } from "@playwright/test";
import { ARTICLES, GROUPS } from "./fixtures.ts";

const all = ARTICLES.length;
const [mvcc, rust, empty] = GROUPS;
const members = (id: number) => ARTICLES.filter((a) => a.groups.includes(id));
const nav = (app: Page) => app.locator(".nav");
const picker = (app: Page) => app.getByRole("dialog", { name: "グループ" });
/** Two frames: a scroll the layout made has reached floating-ui, which places the popover on the next one. */
const frames = async (app: Page) => {
  await app.evaluate(() => new Promise(requestAnimationFrame));
  await app.evaluate(() => new Promise(requestAnimationFrame));
};

test("a sidebar group is a scope; groups are renamed and deleted there (articles stay)", async ({ app }) => {
  await expect(navItem(app, mvcc.name).locator(".n")).toHaveText(String(members(mvcc.id).length));
  await navItem(app, mvcc.name).click();
  await expect(list(app).locator("h1")).toHaveText(mvcc.name);
  await expect(listCount(app)).toHaveText(`${members(mvcc.id).length} / ${members(mvcc.id).length}`);

  await nav(app).getByRole("button", { name: "グループを管理" }).click();
  await app.getByRole("textbox", { name: "グループを作成" }).fill("論文");
  await app.getByRole("textbox", { name: "グループを作成" }).press("Enter");
  await expect(navItem(app, "論文")).toBeVisible();
  await navItem(app, "論文").click();
  await expect(list(app).locator("h1")).toHaveText("論文");
  await expect(listCount(app)).toHaveText("0 / 0");
  const name = nav(app).getByLabel("グループ名");

  await nav(app).getByRole("button", { name: "論文の操作" }).click();
  await app.getByRole("menuitem", { name: "名前を変更" }).click();
  await name.fill(rust.name);
  await name.press("Enter");
  await expect(app.getByRole("alert")).toContainText(`グループ「${rust.name}」はすでにあります`);
  await nav(app).getByRole("button", { name: "論文の操作" }).click();
  await app.getByRole("menuitem", { name: "名前を変更" }).click();
  await name.fill("論文2026");
  await name.press("Enter");
  await expect(list(app).locator("h1")).toHaveText("論文2026");

  await navItem(app, mvcc.name).click();
  await nav(app)
    .getByRole("button", { name: `${mvcc.name}の操作` })
    .click();
  await app.getByRole("menuitem", { name: "削除" }).click();
  const dialog = app.getByRole("alertdialog", { name: `グループ「${mvcc.name}」を削除しますか？` });
  await dialog.getByRole("button", { name: "削除", exact: true }).click();
  await expect(navItem(app, mvcc.name)).toHaveCount(0);
  await expect(list(app).locator("h1")).toHaveText("すべての記事");
  await expect(listCount(app)).toHaveText(`${all} / ${all}`);
});

test("the Reader's group chips: pick a group, create one, remove one", async ({ app }) => {
  const a = members(mvcc.id)[0];
  await list(app).locator(".row", { hasText: a.title! }).click();
  const chips = app.locator(".art-chips");
  await expect(chips.locator(".chip", { hasText: mvcc.name })).toBeVisible();

  const add = chips.getByRole("button", { name: "＋ グループ" });
  await add.click();
  await expect(picker(app)).toBeInViewport();
  const { x, y } = (await picker(app).boundingBox())!;
  const before = (await add.boundingBox())!;
  await picker(app)
    .getByRole("option", { name: new RegExp(rust.name) })
    .click();
  await expect(chips.locator(".chip", { hasText: rust.name })).toBeVisible();
  expect((await add.boundingBox())!, "the new chip moves the ＋ button").not.toMatchObject({ x: before.x, y: before.y });
  expect((await picker(app).boundingBox())!, "but not the picker").toMatchObject({ x, y });
  await expect(navItem(app, rust.name).locator(".n")).toHaveText(String(members(rust.id).length + 1));
  await expect(picker(app).getByRole("option", { name: new RegExp(rust.name) }), "a picked group stays listed, checked").toHaveAttribute(
    "aria-selected",
    "true",
  );

  await picker(app).getByRole("combobox").fill("卒論");
  await app.keyboard.press("Enter");
  await expect(chips.locator(".chip", { hasText: "卒論" })).toBeVisible();
  await expect(navItem(app, "卒論").locator(".n")).toHaveText("1");
  await expect(picker(app).getByRole("combobox")).toHaveValue("");
  await expect(picker(app).getByRole("option", { name: /卒論/ }), "the group just made is listed, checked, once the search clears").toHaveAttribute(
    "aria-selected",
    "true",
  );
  await app.keyboard.press("Escape");
  await expect(picker(app)).toBeHidden();

  await chips.getByRole("button", { name: `グループ「${mvcc.name}」から外す` }).click();
  await expect(chips.locator(".chip", { hasText: mvcc.name })).toHaveCount(0);
  await expect.poll(() => callsOf(app, "group_remove")).toEqual([{ id: mvcc.id, articles: [a.id] }]);
});

test("the Reader's group picker opens under its chip, and moves with it when the article scrolls and the window narrows", async ({ app }) => {
  await app.setViewportSize({ width: 1440, height: 600 });
  await list(app)
    .locator(".row", { hasText: members(mvcc.id)[0].title! })
    .click();
  const chip = app.locator(".art-chips").getByRole("button", { name: "＋ グループ" });
  await chip.click();
  await expect(picker(app)).toBeInViewport();
  const under = async () => {
    const c = (await chip.boundingBox())!;
    const p = (await picker(app).boundingBox())!;
    return {
      gap: Math.round(p.y - c.y - c.height),
      overlaps: p.x < c.x + c.width && c.x < p.x + p.width,
      inWindow: p.x + p.width <= app.viewportSize()!.width,
    };
  };
  const right = { gap: 4, overlaps: true, inWindow: true };
  await expect.poll(under, "it opens just under its chip").toEqual(right);

  await app.locator(".art-title").hover();
  await app.mouse.wheel(0, 120);
  await expect
    .poll(() =>
      app
        .locator(".doc-scroll")
        .first()
        .evaluate((e) => e.scrollTop),
    )
    .toBeGreaterThan(0);
  await expect.poll(under, "the article scrolls it with the chip").toEqual(right);

  const wide = (await chip.boundingBox())!.x;
  await app.setViewportSize({ width: 1100, height: 600 });
  await expect.poll(async () => (await chip.boundingBox())!.x, "the narrower window moves the chip").not.toBe(wide);
  await expect.poll(under, "and the picker with it").toEqual(right);
});

test("picks that rewrap the Reader's chips at the top of the view leave its group picker where it was", async ({ app }) => {
  await app.setViewportSize({ width: 900, height: 400 });
  await list(app)
    .locator(".row", { hasText: members(mvcc.id)[0].title! })
    .click();
  const add = app.locator(".art-chips").getByRole("button", { name: "＋ グループ" });
  // What is at the top of the view is what Chromium holds in place as the chips above and around it rewrap.
  await add.evaluate((el) => {
    const box = el.closest(".doc-scroll")!;
    box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top;
  });
  const edge = await add.evaluate((el) => Math.round(el.getBoundingClientRect().top - el.closest(".doc-scroll")!.getBoundingClientRect().top));
  expect(edge, "the article scrolls far enough to put ＋ at the top of the view").toBe(0);
  await add.click();
  await expect(picker(app)).toBeInViewport();
  const { x, y } = (await picker(app).boundingBox())!;
  const before = (await add.boundingBox())!.y;
  for (const g of [rust, empty]) {
    await picker(app)
      .getByRole("option", { name: new RegExp(g.name) })
      .click();
    await expect(app.locator(".art-chips .chip", { hasText: g.name })).toBeVisible();
    await frames(app);
    expect((await picker(app).boundingBox())!, `picking ${g.name} leaves the picker where it was`).toMatchObject({ x, y });
  }
  expect((await add.boundingBox())!.y, "the picks moved the ＋ button down a line").toBeGreaterThan(before);
});

test("closing the Reader's group picker gives the article its scroll anchoring back", async ({ app }) => {
  await app.setViewportSize({ width: 900, height: 400 });
  const a = members(mvcc.id)[0];
  await list(app).locator(".row", { hasText: a.title! }).click();
  await app.locator(".art-chips").getByRole("button", { name: "＋ グループ" }).click();
  await expect(picker(app)).toBeVisible();
  await app.keyboard.press("Escape");
  await expect(picker(app)).toBeHidden();
  const doc = app.locator(".doc-scroll").first();
  await doc.evaluate((e) => (e.scrollTop = e.scrollHeight / 2));
  await expect.poll(() => storedPlace(app, a.id), "the place is saved once scrolling rests").not.toBeNull();
  /** The block at the top of the article's view, and how far the view starts into it. */
  const read = () =>
    doc.evaluate((view) => {
      const top = view.getBoundingClientRect().top;
      const el = [...view.querySelectorAll("[id^='b-']")].find((b) => b.getBoundingClientRect().bottom > top)!;
      return { block: el.id, into: top - el.getBoundingClientRect().top };
    });
  const was = await read();
  // A translation arriving above the place read makes a block there taller.
  await doc
    .locator("[id^='b-']")
    .first()
    .evaluate((el) => (el.style.paddingBottom = "150px"));
  await frames(app);
  const now = await read();
  expect({ block: now.block, near: Math.abs(now.into - was.into) <= 1 }, "the text stays where it was read").toEqual({ block: was.block, near: true });
});

/** The reading place stored for article `id`. */
const storedPlace = (app: Page, id: number) =>
  app.evaluate(
    (key) =>
      (JSON.parse(localStorage.getItem("lattice.readingPlaces") ?? "[]") as [string, { block: number; at: number }][]).find(([k]) => k === key)?.[1] ?? null,
    String(id),
  );

/** Opens the group picker from the palette's この記事をグループに追加…. */
async function addFromPalette(app: Page) {
  await app.keyboard.press("Control+p");
  await app.keyboard.type("この記事をグループに追加");
  await app.getByRole("option", { name: "この記事をグループに追加…" }).click();
  await expect(picker(app)).toBeInViewport();
}

test("the palette's この記事をグループに追加… opens the picker under the Reader's toolbar, and leaves the article and the focus where they were", async ({
  app,
}) => {
  await app.setViewportSize({ width: 900, height: 400 });
  const a = members(mvcc.id)[0];
  await list(app).locator(".row", { hasText: a.title! }).click();
  const doc = app.locator(".doc-scroll").first();
  await doc.evaluate((e) => (e.scrollTop = e.scrollHeight / 2));
  const chips = app.locator(".art-chips");
  await expect(chips).not.toBeInViewport();
  await expect.poll(() => storedPlace(app, a.id), "the place is saved once scrolling rests").not.toBeNull();
  /** The block at the top of the article's view, and how far the view starts into it. */
  const read = () =>
    doc.evaluate((view) => {
      const top = view.getBoundingClientRect().top;
      const el = [...view.querySelectorAll("[id^='b-']")].find((b) => b.getBoundingClientRect().bottom > top)!;
      return { block: el.id, into: top - el.getBoundingClientRect().top };
    });
  const was = await read();
  const kept = async () => {
    const now = await read();
    return { block: now.block, near: Math.abs(now.into - was.into) <= 1 };
  };
  const top = await doc.evaluate((e) => e.scrollTop);
  const focused = await app.evaluateHandle(() => document.activeElement);
  const high = (await chips.boundingBox())!.height;

  await addFromPalette(app);
  const bar = app.locator(".docbar").first();
  await expect
    .poll(async () => {
      const b = (await bar.boundingBox())!;
      const p = (await picker(app).boundingBox())!;
      return { gap: Math.round(p.y - b.y - b.height), overlaps: p.x < b.x + b.width && b.x < p.x + p.width };
    }, "under the toolbar")
    .toEqual({ gap: 4, overlaps: true });
  expect(await doc.evaluate((e) => e.scrollTop), "without scrolling the article to its chips").toBe(top);
  await expect(picker(app).getByRole("combobox")).toBeFocused();
  await picker(app)
    .getByRole("option", { name: new RegExp(rust.name) })
    .click();
  await expect.poll(async () => (await chips.boundingBox())!.height, "the new chip takes another line, above the view").toBeGreaterThan(high);
  await app.keyboard.press("Escape");
  await expect(picker(app)).toBeHidden();
  await expect.poll(kept, "the text stays where it was read").toEqual({ block: was.block, near: true });
  expect(await app.evaluate((el) => document.activeElement === el, focused), "and the focus goes back where the palette left it").toBe(true);
});

test("a press on the chat's question box while the palette's group picker is open keeps the keyboard there", async ({ app }) => {
  await app.setViewportSize({ width: 1440, height: 600 });
  await nav(app).getByRole("button", { name: "対話" }).click();
  const q = app.getByRole("textbox", { name: "質問", exact: true });
  await expect(q).toBeVisible();
  await list(app)
    .locator(".row", { hasText: members(mvcc.id)[0].title! })
    .click();
  await addFromPalette(app);
  await q.click();
  await expect(picker(app)).toBeHidden();
  await app.keyboard.type("abc");
  await expect(q).toHaveValue("abc");
  await expect(q).toBeFocused();
});

test("picks that take the row out of the list, scrolled to its end, and bring it back leave the group picker where it was", async ({ app }) => {
  await app.setViewportSize({ width: 1440, height: 420 });
  await navItem(app, mvcc.name).click();
  const body = list(app).locator(".list-body");
  await body.evaluate((e) => (e.scrollTop = e.scrollHeight));
  const last = list(app).locator(".row").last();
  const title = (await last.locator(".t").textContent())!;
  await last.click({ button: "right" });
  await app.getByRole("menu", { name: "記事のメニュー" }).getByRole("menuitem", { name: "グループに追加…" }).click();
  await expect(picker(app)).toBeInViewport();
  const { x, y } = (await picker(app).boundingBox())!;
  const top = await body.evaluate((e) => e.scrollTop);
  await picker(app)
    .getByRole("option", { name: new RegExp(mvcc.name) })
    .click();
  await expect(list(app).locator(".row", { hasText: title })).toHaveCount(0);
  await expect.poll(() => body.evaluate((e) => e.scrollTop), "the shorter list pulls its scroll back").toBeLessThan(top);
  await frames(app);
  expect((await picker(app).boundingBox())!, "that is the pick's doing, not the reader's: the picker stays").toMatchObject({ x, y });

  await picker(app)
    .getByRole("option", { name: new RegExp(mvcc.name) })
    .click();
  await expect(list(app).locator(".row", { hasText: title })).toHaveCount(1);
  await frames(app);
  expect((await picker(app).boundingBox())!, "and the row coming back leaves it there too").toMatchObject({ x, y });
});

test("an empty scope shows no filters, sort or Select", async ({ app }) => {
  await navItem(app, empty.name).click();
  await expect(list(app).locator(".empty")).toBeVisible();
  await expect(list(app).locator(".chips, .list-tools")).toHaveCount(0);
});

test("list rows picked with 選択 and Shift+click go into a group together", async ({ app }) => {
  const rows = list(app).locator(".row");
  const ids = await rows.evaluateAll((els) => els.slice(0, 4).map((e) => Number((e as HTMLElement).dataset.id)));
  await list(app).getByRole("button", { name: "選択", exact: true }).click();
  await rows.nth(0).click();
  await rows.nth(2).click({ modifiers: ["Shift"] });
  await rows.nth(1).click();
  await expect(list(app).getByRole("toolbar")).toContainText("2件を選択");
  await expect(app.locator(".art-title")).toHaveCount(0);

  await list(app).getByRole("button", { name: "グループに追加" }).click();
  await picker(app)
    .getByRole("option", { name: new RegExp(empty.name) })
    .click();
  await expect.poll(() => callsOf(app, "group_add")).toEqual([{ id: empty.id, articles: [ids[0], ids[2]] }]);
  await expect(navItem(app, empty.name).locator(".n")).toHaveText("2");

  await list(app).getByRole("button", { name: "選択を終了" }).click();
  await rows.nth(3).click({ modifiers: ["Shift"] });
  await expect(list(app).getByRole("toolbar")).toContainText("1件を選択");
  await app.keyboard.press("Escape");
  await expect(list(app).getByRole("toolbar")).toHaveCount(0);
  await expect(list(app).getByRole("button", { name: "選択", exact: true })).toBeVisible();
});

test("a group is a facet, a search scope and a chat scope (このグループ)", async ({ app }) => {
  await list(app).getByRole("button", { name: "グループ", exact: true }).click();
  await app
    .getByRole("dialog", { name: "グループで絞り込む" })
    .getByRole("button", { name: new RegExp(rust.name) })
    .click();
  await expect(listCount(app)).toHaveText(`${members(rust.id).length} / ${all}`);
  await app.keyboard.press("Escape");

  await navItem(app, mvcc.name).click();
  await app.locator(".nav").getByRole("button", { name: "対話" }).click();
  await chatScope(app).click();
  const scopes = scopeDialog(app).getByRole("option");
  await expect(scopes).toContainText([`このグループ: ${mvcc.name}`, ...GROUPS.map((g) => `${g.name}(${members(g.id).length}件)`)]);
  await scopeDialog(app)
    .getByRole("option", { name: `このグループ: ${mvcc.name}` })
    .click();
  await expect(chatScope(app)).toHaveText(`このグループ: ${mvcc.name}`);
  await chatScope(app).click();
  const selected = scopeDialog(app).locator("[role=option][aria-selected=true]");
  await expect(selected, "listed twice, selected once").toHaveCount(1);
  await expect(selected).toHaveAccessibleName(`このグループ: ${mvcc.name}`);
  await expect(scopeDialog(app).locator(".check", { hasText: "✓" })).toHaveCount(1);
  await app.keyboard.press("Escape");
  await app.getByLabel("質問", { exact: true }).fill("MVCCとは？");
  await app.getByRole("button", { name: "送信" }).click();
  await expect
    .poll(async () => (await callsOf(app, "chat_ask")).map((c) => (c as { scope: unknown }).scope))
    .toEqual([{ kind: "filter", filter: { kind: "group", id: mvcc.id } }]);

  await app.keyboard.press("Control+p");
  await app.keyboard.type("?vacuum");
  await app.keyboard.press("Enter");
  await expect
    .poll(async () => (await callsOf(app, "search_blocks")).at(-1))
    .toEqual({
      query: "vacuum",
      articles: members(mvcc.id)
        .map((a) => a.id)
        .sort((a, b) => a - b),
    });
});

test("imports land in the chosen groups; the list's group is chosen first", async ({ app }) => {
  await navItem(app, rust.name).click();
  await app.keyboard.press("Control+p");
  await app.keyboard.type(">一括");
  await app.keyboard.press("Enter");
  const field = app.locator(".import-groups");
  await expect(field.getByRole("button")).toHaveText(rust.name);
  await field.getByRole("button").click();
  await picker(app)
    .getByRole("option", { name: new RegExp(rust.name) })
    .click();
  await picker(app)
    .getByRole("option", { name: new RegExp(empty.name) })
    .click();
  await app.keyboard.press("Escape");
  await expect(field.getByRole("button")).toHaveText(empty.name);

  const existing = ARTICLES[0].original_url;
  const text = app.getByRole("textbox", { name: "インポートするテキスト" });
  await text.fill(`${existing}\nhttps://example.com/new-post\nftp://example.com/file\nnot-a-url at all`);
  await app.getByRole("button", { name: "インポート", exact: true }).click();
  await expect(app.getByRole("status")).toContainText("2件中1件");
  await expect(app.getByRole("status")).toContainText("・1行はhttp(s)でないため無視・1行はURLがないため無視");
  await expect(text).toHaveValue("");
  const [call] = (await callsOf(app, "group_add")) as { id: number; articles: number[] }[];
  expect(call.id).toBe(empty.id);
  expect(call.articles[0]).toBe(ARTICLES[0].id);
  expect(call.articles).toHaveLength(2);
  await expect(navItem(app, empty.name).locator(".n")).toHaveText("2");
});

test("the palette opens a group, adds the open article to one, and saves a URL into the list's group", async ({ app }) => {
  await app.keyboard.press("Control+p");
  await app.keyboard.type("グループ rust");
  await app.getByRole("option", { name: `グループ: ${rust.name}` }).click();
  await expect(list(app).locator("h1")).toHaveText(rust.name);

  await list(app).locator(".row").first().click();
  await app.keyboard.press("Control+p");
  await app.keyboard.type("この記事をグループに追加");
  await app.getByRole("option", { name: "この記事をグループに追加…" }).click();
  await expect(picker(app)).toBeVisible();
  await app.keyboard.press("Escape");

  await app.keyboard.press("Control+p");
  await app.keyboard.type("https://example.com/into-group");
  await app.getByRole("option", { name: `ライブラリに保存してグループ「${rust.name}」に入れる` }).click();
  await expect.poll(() => callsOf(app, "group_add")).toHaveLength(1);
  const [call] = (await callsOf(app, "group_add")) as { id: number; articles: number[] }[];
  expect(call.id).toBe(rust.id);
  await expect(navItem(app, rust.name).locator(".n")).toHaveText(String(members(rust.id).length + 1));
});

test("the JSON export can be limited to a group", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  await app.getByRole("navigation", { name: "設定カテゴリ" }).getByText("エクスポート", { exact: true }).click();
  await app.getByLabel("エクスポートする範囲").selectOption({ label: `グループ: ${mvcc.name}` });
  await app
    .locator(".set", { has: app.getByLabel("エクスポートする範囲") })
    .getByRole("button", { name: "エクスポート", exact: true })
    .click();
  await expect.poll(() => callsOf(app, "export_json")).toEqual([{ group: mvcc.id }]);
});
