import { test, expect, navItem, callsOf } from "./harness.ts";
import type { Locator, Page } from "@playwright/test";

const nav = (app: Page) => app.locator(".nav");
const inFolder = (app: Page, name: string) =>
  nav(app).locator(".nav-folder").filter({ has: app.locator(".ni-row .label").getByText(name, { exact: true }) }).locator(".nav-sub .label");
/** The feeds in no folder: the sidebar's feed rows outside the folders. */
const loose = (app: Page) => nav(app).locator(".nav-sub:not(.nav-folder > .nav-sub) > .ni[data-feed] .label");

async function openFeeds(app: Page) {
  await nav(app).getByRole("button", { name: "管理", exact: true }).click();
  await expect(app.locator("main.manage h1")).toHaveText("フィードを管理");
}

async function createFolder(app: Page, name: string) {
  const folders = app.getByRole("region", { name: "フォルダ" });
  await folders.getByRole("textbox", { name: "フォルダ名" }).fill(name);
  await folders.getByRole("button", { name: "作成" }).click();
  await expect(folders.getByRole("textbox", { name: `フォルダ「${name}」の名前` })).toHaveValue(name);
}

async function moveTo(app: Page, feed: string, folder: string) {
  await app.getByLabel(`${feed} のフォルダ`).selectOption({ label: folder });
  await expect(app.getByRole("status")).toHaveText(`1 件を「${folder}」へ移動しました`);
}

/** A pointer drag in small steps, as a hand does: past the few pixels that start it, then onto the target's middle. */
async function drag(app: Page, from: Locator, to: Locator) {
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await app.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await app.mouse.down();
  await app.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + 8, { steps: 4 });
  await app.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await app.mouse.up();
}

test("dragging feeds in the sidebar reorders them and moves them between folders, without opening them", async ({ app }) => {
  await openFeeds(app);
  await createFolder(app, "TechFeed");
  await moveTo(app, "Postgres Weekly", "TechFeed");
  await moveTo(app, "Netflix TechBlog", "TechFeed");
  await expect(inFolder(app, "TechFeed")).toHaveText(["Postgres Weekly", "Netflix TechBlog"], { timeout: 15_000 });
  await expect(loose(app)).toHaveText(["web.dev", "Zenn", "Rust Blog", "LWN.net"]);

  await drag(app, navItem(app, "Netflix TechBlog"), navItem(app, "Postgres Weekly"));
  await expect(inFolder(app, "TechFeed")).toHaveText(["Netflix TechBlog", "Postgres Weekly"]);
  const folder = (await callsOf(app, "reorder_feeds"))[0] as { folder: number; ids: number[] };
  expect(folder.ids).toEqual([2, 1]);
  await expect(app.locator("main.manage h1"), "a drag is not a click: the scope did not open").toHaveText("フィードを管理");

  await drag(app, navItem(app, "Zenn"), navItem(app, "TechFeed"));
  await expect(inFolder(app, "TechFeed"), "onto a folder: last in it").toHaveText(["Netflix TechBlog", "Postgres Weekly", "Zenn"]);
  await drag(app, navItem(app, "Rust Blog"), navItem(app, "Postgres Weekly"));
  await expect(inFolder(app, "TechFeed"), "onto a feed: its slot").toHaveText(["Netflix TechBlog", "Rust Blog", "Postgres Weekly", "Zenn"]);
  await drag(app, navItem(app, "Netflix TechBlog"), navItem(app, "LWN.net"));
  await expect(loose(app), "out of the folder").toHaveText(["web.dev", "LWN.net", "Netflix TechBlog"]);
  expect((await callsOf(app, "reorder_feeds")).at(-1)).toEqual({ folder: null, ids: [3, 6, 2] });

  // The Feeds screen loads the feeds again: the same order, under folder headings.
  await nav(app).getByRole("button", { name: "Zenn" }).click();
  await openFeeds(app);
  const table = app.locator("main.manage .tbl tbody");
  // A feed's name cell starts with its icon's letter.
  const names = (ns: string[]) => ns.map((n) => new RegExp(`${n.replace(".", "\\.")}$`));
  await expect(table.locator("tr.grp, .fn")).toHaveText(names(["TechFeed", "Rust Blog", "Postgres Weekly", "Zenn", "フォルダなし", "web.dev", "LWN.net", "Netflix TechBlog"]));
  await expect(app.getByLabel("Rust Blog を上へ")).toBeDisabled();
  await app.getByLabel("Zenn を下へ").click();
  await expect(table.locator(".fn"), "down past the last in a folder: first in the next group").toHaveText(names(["Rust Blog", "Postgres Weekly", "Zenn", "web.dev", "LWN.net", "Netflix TechBlog"]));
  await expect(loose(app)).toHaveText(["Zenn", "web.dev", "LWN.net", "Netflix TechBlog"]);
  await app.getByLabel("Zenn を上へ").click();
  await expect(inFolder(app, "TechFeed"), "up past the first in none: last in the folder above").toHaveText(["Rust Blog", "Postgres Weekly", "Zenn"]);
});

test("Alt+↑ / ↓ move the focused feed or folder, across folders; folders drag too", async ({ app }) => {
  await openFeeds(app);
  await createFolder(app, "News");
  await createFolder(app, "Tech");
  await moveTo(app, "Postgres Weekly", "News");
  const folders = () => nav(app).locator(".nav-folder .ni[data-folder] .label");
  await expect(folders()).toHaveText(["News", "Tech"]);

  const pg = navItem(app, "Postgres Weekly");
  await pg.focus();
  await app.keyboard.press("Alt+ArrowDown");
  await expect(inFolder(app, "Tech")).toHaveText(["Postgres Weekly"]);
  await expect(pg).toBeFocused();
  await app.keyboard.press("Alt+ArrowDown");
  await expect(loose(app).first()).toHaveText("Postgres Weekly");
  await expect(pg).toBeFocused();
  await app.keyboard.press("Alt+ArrowDown");
  await expect(loose(app).nth(1)).toHaveText("Postgres Weekly");
  await app.keyboard.press("Alt+ArrowUp");
  await app.keyboard.press("Alt+ArrowUp");
  await expect(inFolder(app, "Tech")).toHaveText(["Postgres Weekly"]);
  await expect(app.locator("main.manage h1"), "the keys move, they do not open").toHaveText("フィードを管理");

  await navItem(app, "Tech").focus();
  await app.keyboard.press("Alt+ArrowUp");
  await expect(folders()).toHaveText(["Tech", "News"]);
  await expect(navItem(app, "Tech")).toBeFocused();
  expect((await callsOf(app, "reorder_feed_folders")).at(-1)).toEqual({ ids: [expect.any(Number), expect.any(Number)] });

  await drag(app, navItem(app, "News"), navItem(app, "Tech"));
  await expect(folders()).toHaveText(["News", "Tech"]);
  await expect(app.getByRole("region", { name: "フォルダ" }).locator("li input").first(), "the Feeds screen follows").toHaveValue("News");
});
