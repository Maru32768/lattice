import { test, expect, navItem, list, listCount, callsOf } from "./harness.ts";
import type { Page } from "@playwright/test";
import { ARTICLES } from "./fixtures.ts";

const nav = (app: Page) => app.locator(".nav");
const unreadIn = (feeds: number[]) => ARTICLES.filter((a) => a.feed_id != null && feeds.includes(a.feed_id) && a.read_status === "unread").length;
const totalIn = (feeds: number[]) => ARTICLES.filter((a) => a.feed_id != null && feeds.includes(a.feed_id)).length;

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

test("feeds move into a folder; the nav shows it as a scope over its feeds, with their unread summed", async ({ app }) => {
  await openFeeds(app);
  await createFolder(app, "TechFeed");
  await app.getByLabel("Postgres Weekly のフォルダ").selectOption({ label: "TechFeed" });
  await expect(app.getByRole("status")).toHaveText("1 件を「TechFeed」へ移動しました");

  await app.getByLabel("Netflix TechBlog を選択").check();
  await app.getByLabel("web.dev を選択").check();
  await app.getByRole("group", { name: "2 件を選択中" }).getByLabel("フォルダへ移動…").selectOption({ label: "TechFeed" });
  await expect(app.getByRole("status")).toHaveText("2 件を「TechFeed」へ移動しました");
  await expect(app.getByLabel("web.dev のフォルダ")).toHaveValue(/\d+/);
  await expect(app.getByRole("region", { name: "フォルダ" })).toContainText("3 件のフィード");

  const folder = navItem(app, "TechFeed");
  await expect(folder.locator(".n")).toHaveText(String(unreadIn([1, 2, 3])));
  await expect(folder).toHaveAttribute("title", `未読 ${unreadIn([1, 2, 3])} 件 / 全 ${totalIn([1, 2, 3])} 件`);
  const inside = nav(app).locator(".nav-folder .nav-sub .label");
  await expect(inside).toHaveText(["Postgres Weekly", "Netflix TechBlog", "web.dev"]);
  await expect(navItem(app, "Zenn")).toBeVisible();
  await expect(nav(app).locator(".nav-folder", { has: navItem(app, "Zenn") })).toHaveCount(0);

  await folder.click();
  await expect(list(app).locator("h1")).toHaveText("TechFeed");
  await expect(listCount(app)).toHaveText(`${totalIn([1, 2, 3])} / ${totalIn([1, 2, 3])}`);

  const toggle = nav(app).getByRole("button", { name: "TechFeed を開閉" });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(inside).toHaveCount(0);
  expect(await app.evaluate(() => localStorage.getItem("lattice.feedFolders.collapsed"))).toMatch(/^\[\d+\]$/);
  await toggle.click();
  await expect(inside).toHaveCount(3);

  await openFeeds(app);
  await app.getByLabel("Netflix TechBlog のフォルダ").selectOption({ label: "フォルダなし" });
  await expect(app.getByRole("status")).toHaveText("1 件をフォルダから出しました");
  await expect(inside).toHaveText(["Postgres Weekly", "web.dev"]);
});

test("several feed URLs, one per line, are subscribed into the chosen folder", async ({ app }) => {
  await openFeeds(app);
  await createFolder(app, "TechFeed");
  const urls = ["https://techfeed.io/feeds/categories/rust", "https://techfeed.io/feeds/categories/go", "https://techfeed.io/feeds/categories/db"];
  const field = app.getByLabel("サイトまたは記事の URL からフィードを検出");
  await field.fill(urls.join("\n") + "\n\n");
  await app.getByLabel("追加先のフォルダ").selectOption({ label: "TechFeed" });
  await app.getByRole("button", { name: "3 件を登録" }).click();
  await expect(app.getByRole("status")).toHaveText("3 件中 3 件を登録");
  await expect(field).toHaveValue("");
  const calls = await callsOf(app, "add_feed");
  expect(calls.map((c) => (c as { url: string }).url)).toEqual(urls);
  const folderId = (calls[0] as { folder: number }).folder;
  expect(calls.every((c) => (c as { folder: number }).folder === folderId)).toBe(true);
  await expect(app.getByRole("region", { name: "フォルダ" })).toContainText("3 件のフィード");
  await expect(nav(app).locator(".nav-folder .nav-sub .ni")).toHaveCount(3);

  // One URL still finds the feeds of a page first.
  await field.fill("https://example.com/");
  await field.press("Enter");
  await app.getByRole("button", { name: "登録して最新 20 件を取り込む" }).click();
  await expect(app.getByRole("status")).toContainText("Discovered feed");
  expect((await callsOf(app, "add_feed")).at(-1)).toEqual({ url: "https://example.com/feed.xml", folder: folderId });
});

test("a nav folder's context menu renames it and deletes it, keeping its feeds", async ({ app }) => {
  await openFeeds(app);
  await createFolder(app, "News");
  await app.getByLabel("LWN.net のフォルダ").selectOption({ label: "News" });
  await expect(app.getByRole("status")).toHaveText("1 件を「News」へ移動しました");
  await navItem(app, "News").click();

  await navItem(app, "News").click({ button: "right" });
  await app.getByRole("menuitem", { name: "名前を変更" }).click();
  const name = nav(app).getByLabel("フォルダ名");
  await name.fill("Linux");
  await name.press("Enter");
  await expect(list(app).locator("h1")).toHaveText("Linux");

  await navItem(app, "Linux").click({ button: "right" });
  await app.getByRole("menuitem", { name: "削除" }).click();
  const dialog = app.getByRole("alertdialog", { name: "フォルダ「Linux」を削除しますか？" });
  await expect(dialog).toContainText("中のフィードは残り、フォルダなしになります。");
  await dialog.getByRole("button", { name: "削除", exact: true }).click();
  await expect(navItem(app, "Linux")).toHaveCount(0);
  await expect(list(app).locator("h1")).toHaveText("すべての記事");
  await openFeeds(app);
  await expect(app.getByLabel("LWN.net のフォルダ")).toHaveValue("");
});

test("OPML outlines become folders on import; the palette finds folders", async ({ app }) => {
  await openFeeds(app);
  const opml = `<?xml version="1.0"?><opml version="2.0"><body>
    <outline text="TechFeed"><outline text="Rust" xmlUrl="https://techfeed.io/feeds/rust"/><outline text="Go" xmlUrl="https://techfeed.io/feeds/go"/></outline>
    <outline text="Loose" xmlUrl="https://loose.dev/feed"/></body></opml>`;
  await app.locator("label", { hasText: "OPML を読み込む" }).locator("input").setInputFiles({ name: "techfeed.opml", mimeType: "text/xml", buffer: Buffer.from(opml) });
  await expect(app.getByRole("status")).toHaveText("3 件中 3 件を登録");
  const calls = await callsOf(app, "add_feed");
  expect(calls.map((c) => (c as { folder: number | null }).folder === null)).toEqual([false, false, true]);
  await expect(navItem(app, "TechFeed")).toBeVisible();

  await app.getByRole("button", { name: "OPML に書き出す" }).click();
  await expect(app.getByRole("status")).toContainText("lattice-feeds-");

  await app.keyboard.press("Control+k");
  await app.keyboard.type("@Tech");
  const found = app.getByRole("dialog", { name: "コマンドパレット" }).getByRole("option", { name: /TechFeed/ });
  await expect(found.first()).toContainText("フォルダ");
  await found.first().click();
  await expect(list(app).locator("h1")).toHaveText("TechFeed");
});
