// The title bar, the toolbars and the Reader / Page parity (H8–H14).
import { test, expect, list, callsOf } from "./harness.ts";
import type { Page } from "@playwright/test";

const more = (page: Page) => page.locator(".docbar [aria-haspopup=menu]").last();

/** Opens the first article, then its Page view, and lets the page finish loading. */
async function openPage(app: Page) {
  await list(app).locator(".row").first().click();
  await app.locator(".docbar").getByRole("button", { name: "Page" }).click();
  await expect.poll(async () => (await callsOf(app, "browser_open")).length).toBeGreaterThan(0);
  const { tab, url } = (await callsOf(app, "browser_open")).at(-1) as { tab: string; url: string };
  await app.evaluate((p) => window.__e2e.emit("browser-page", p), { tab, url, loading: false, can_go_back: false, can_go_forward: false });
}

test("the ⋯ menu draws its text in the frame it first appears (H8)", async ({ app }) => {
  await list(app).locator(".row").first().click();
  // The UI's font subsets are fetched while idle after startup.
  await app.evaluate(() => document.fonts.ready);
  await app.waitForTimeout(500);
  const first = app.evaluate(() => new Promise<boolean>((done) => {
    const frame = () => {
      const m = document.querySelector(".menu");
      if (!m) return requestAnimationFrame(frame);
      done([...m.querySelectorAll("button")].every((b) => document.fonts.check(`12px "IBM Plex Sans JP"`, b.textContent ?? "")));
    };
    requestAnimationFrame(frame);
  }));
  await more(app).click();
  expect(await first, "the menu's glyphs were loaded when it was first drawn").toBe(true);
});

test("on Page, a still captured when the pointer reaches ⋯ lets the menu hide the webview without a new capture (H8)", async ({ app }) => {
  await openPage(app);
  await more(app).hover();
  await expect.poll(async () => (await callsOf(app, "browser_capture")).length).toBe(1);
  await more(app).click();
  await expect(app.getByRole("menu")).toBeVisible();
  await expect.poll(async () => (await callsOf(app, "browser_hide")).length).toBeGreaterThan(0);
  expect(await callsOf(app, "browser_capture")).toHaveLength(1);
  await expect(app.locator(".page-still")).toBeVisible();
});

const commandCenter = (page: Page) => page.getByRole("banner").getByRole("button", { name: "検索・コマンド・URL" });
const palette = (page: Page) => page.getByRole("dialog", { name: "コマンドパレット" });

test("the search and command box sits in the title bar, not in the nav (H9)", async ({ app }) => {
  await expect(app.locator(".nav").getByText("検索・コマンド・URL")).toHaveCount(0);
  await commandCenter(app).click();
  await expect(palette(app).getByRole("combobox")).toBeFocused();
  await app.keyboard.press("Escape");
  await expect(palette(app)).toBeHidden();

  // The box is centered on the window.
  const box = (await commandCenter(app).boundingBox())!;
  expect(Math.abs(box.x + box.width / 2 - 720)).toBeLessThan(2);

  await app.locator(".nav").getByRole("button", { name: "ナビゲーションを閉じる" }).click();
  await expect(app.locator(".nav-rail").getByRole("button")).toHaveCount(4);
  await expect(app.locator(".nav-rail").getByRole("button", { name: /検索/ })).toHaveCount(0);
});

test("a document window has the command center, the chat window does not (H9)", async ({ shell }) => {
  await shell.addInitScript(() => localStorage.setItem("lattice.window.doc-1", JSON.stringify({ root: { kind: "pane", id: 1, tabs: [{ kind: "page", id: 3, key: "k1", url: "https://example.com/p", title: "P" }], active: 3 }, focused: 1 })));
  await shell.goto("/?window=doc-1");
  await commandCenter(shell).click();
  await expect(palette(shell)).toBeVisible();
  await shell.goto("/?window=chat");
  await expect(shell.getByLabel("質問", { exact: true })).toBeVisible();
  await expect(commandCenter(shell)).toHaveCount(0);
});

test("the nav's top holds only its close button; what the ＋ opened is in the palette (H10)", async ({ app }) => {
  await expect(app.locator(".nav-top").getByRole("button")).toHaveCount(1);
  await expect(app.locator(".nav-top").getByRole("button")).toHaveAccessibleName("ナビゲーションを閉じる");
  await commandCenter(app).click();
  await app.keyboard.type(">");
  for (const name of ["一括インポート", "Markdown を取り込む", "フィードを管理"]) await expect(palette(app).getByRole("option", { name })).toHaveCount(1);
});

test("the closed list is one button that opens it again; j / k still move the cursor (H11)", async ({ app }) => {
  await list(app).getByRole("button", { name: "記事一覧を閉じる" }).click();
  const rail = app.getByRole("region", { name: "記事一覧（折りたたみ）" });
  await expect(rail.getByRole("button")).toHaveCount(1);
  await expect(rail).toHaveText("");
  await app.locator(".doc-area-wrap").click({ position: { x: 5, y: 200 } });
  await app.keyboard.press("j");
  await app.keyboard.press("j");
  await rail.getByRole("button", { name: "記事一覧を開く" }).click();
  await expect(list(app).locator(".row").nth(1)).toHaveClass(/(^| )cur( |$)/);
});

test("the tab strip's ＋ opens the search engine's start page in a new tab (H12)", async ({ app }) => {
  await list(app).locator(".row").first().click();
  await app.locator(".dpane").getByRole("button", { name: "新しいタブ" }).click();
  await expect(app.locator(".dpane").getByRole("tab")).toHaveCount(2);
  await expect(palette(app)).toBeHidden();
  await expect.poll(async () => ((await callsOf(app, "browser_open")).at(-1) as { url: string } | undefined)?.url).toBe("https://duckduckgo.com/");
});
