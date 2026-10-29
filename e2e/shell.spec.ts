// The title bar, the toolbars and the Reader / Page parity (H8–H14).
import { test, expect, list, callsOf } from "./harness.ts";
import { ARTICLES, SNAPSHOT_ID } from "./fixtures.ts";
import type { Page } from "@playwright/test";

const snapshot = ARTICLES.find((a) => a.id === SNAPSHOT_ID)!;

const more = (page: Page) => page.locator(".docbar [aria-haspopup=menu]").last();

/** Opens an article (the first one), then its Page view, and lets the page finish loading. */
async function openPage(app: Page, title?: string) {
  await (title ? list(app).locator(".row", { hasText: title }) : list(app).locator(".row").first()).click();
  await app.locator(".docbar").getByRole("button", { name: "Page" }).click();
  await expect.poll(async () => (await callsOf(app, "browser_open")).length).toBeGreaterThan(0);
  const { tab, url } = (await callsOf(app, "browser_open")).at(-1) as { tab: string; url: string };
  await app.evaluate((p) => window.__e2e.emit("browser-page", p), { tab, url, loading: false, can_go_back: false, can_go_forward: false });
}

/** Serialized into the page: check the actual face and glyph subsets, without loading them from the test. */
function firstMenuFonts(): Promise<boolean> {
  return new Promise((done) => {
    const frame = () => {
      const buttons = [...document.querySelectorAll(".menu button")];
      if (!buttons.length) {
        requestAnimationFrame(frame);
        return;
      }
      done(
        buttons.every((button) => {
          const style = getComputedStyle(button);
          const family = style.fontFamily.split(",")[0].trim().replaceAll('"', "");
          const loadedFace = [...document.fonts].some((face) => face.family.replaceAll('"', "") === family && face.status === "loaded");
          return loadedFace && document.fonts.check(`${style.fontWeight} ${style.fontSize} "${family}"`, button.textContent ?? "");
        }),
      );
    };
    requestAnimationFrame(frame);
  });
}

test("the ⋯ menu draws its text in the frame it first appears (H8)", async ({ app }) => {
  await list(app).locator(".row").first().click();
  // The UI's font subsets are fetched while idle after startup.
  await app.evaluate(async () => {
    await new Promise<void>((done) => requestIdleCallback(() => done()));
    await document.fonts.ready;
  });
  const first = app.evaluate(firstMenuFonts);
  await more(app).click();
  expect(await first, "the menu's glyphs were loaded when it was first drawn").toBe(true);
});

test("the menu font check rejects delayed font files on a cold page (H8)", async ({ shell }) => {
  let release = () => {};
  const gate = new Promise<void>((done) => {
    release = done;
  });
  let requests = 0;
  await shell.route(/\.(woff2?|ttf)(\?|$)/, async (route) => {
    requests++;
    await gate;
    await route.continue();
  });
  try {
    await shell.goto("/", { waitUntil: "domcontentloaded" });
    await expect.poll(() => requests).toBeGreaterThan(0);
    await list(shell).locator(".row").first().click();
    const first = shell.evaluate(firstMenuFonts);
    await more(shell).click();
    expect(await first, "the actual font is still unavailable").toBe(false);
  } finally {
    release();
    await shell.unrouteAll({ behavior: "wait" });
    await shell.evaluate(() => document.fonts.ready);
  }
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
  await expect(app.locator(".nav-rail").getByRole("button")).toHaveCount(5);
  await expect(app.locator(".nav-rail").getByRole("button", { name: /検索/ })).toHaveCount(0);
});

test("the chat window has no command center (H9)", async ({ shell }) => {
  await shell.goto("/?window=chat");
  await expect(shell.getByLabel("質問", { exact: true })).toBeVisible();
  await expect(commandCenter(shell)).toHaveCount(0);
});

test("the nav's ＋ holds the empty library's ways in, with PDF; the palette keeps them too", async ({ app }) => {
  await expect(app.locator(".nav-head").getByRole("button")).toHaveCount(2);
  const add = app.locator(".nav-head").getByRole("button", { name: "記事を追加" });
  const menu = app.getByRole("menu", { name: "記事を追加" });
  await add.click();
  await expect(menu.getByRole("menuitem")).toHaveText([
    /^URL を貼る/,
    /^フィードを登録/,
    /^一括インポート/,
    /^Markdown を取り込む/,
    /^PDF \(論文\) を取り込む/,
  ]);
  await menu.getByRole("menuitem", { name: /^URL を貼る/ }).click();
  await expect(palette(app)).toBeVisible();
  await app.keyboard.press("Escape");
  await add.click();
  await menu.getByRole("menuitem", { name: /^フィードを登録/ }).click();
  await expect(app.getByRole("heading", { name: "フィードを管理" })).toBeVisible();
  await add.click();
  await menu.getByRole("menuitem", { name: /^PDF/ }).click();
  await expect(app.getByRole("group", { name: "インポートの種類" }).getByRole("button", { name: "PDF" })).toHaveAttribute("aria-pressed", "true");
  await add.click();
  await menu.getByRole("menuitem", { name: /^一括インポート/ }).click();
  await expect(app.getByRole("group", { name: "インポートの種類" }).getByRole("button", { name: "URL 一覧" })).toHaveAttribute("aria-pressed", "true");

  await app.locator(".nav-head").getByRole("button", { name: "ナビゲーションを閉じる" }).click();
  await app.locator(".nav-rail").getByRole("button", { name: "記事を追加" }).click();
  await expect(menu.getByRole("menuitem")).toHaveCount(5);
  await app.keyboard.press("Escape");
  await commandCenter(app).click();
  await app.keyboard.type(">");
  for (const name of ["一括インポート", "Markdown を取り込む", "フィードを管理"]) {
    await expect(palette(app).getByRole("option", { name })).toHaveCount(1);
  }
});

test("the closed list is one button that opens it again; j / k still move the cursor (H11)", async ({ app }) => {
  await list(app).getByRole("button", { name: "記事一覧を閉じる" }).click();
  const rail = app.getByRole("region", { name: "記事一覧 (折りたたみ)" });
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
  // The URL bar has the keyboard with its URL selected: a pasted URL replaces it.
  const bar = app.locator("input.url-pill");
  await expect(bar).toBeFocused();
  await expect.poll(() => bar.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, "https://duckduckgo.com/".length]);
});

test("a saved article's summary shows in a strip above its page; it can be generated there (H13)", async ({ app }) => {
  await openPage(app, snapshot.title!);
  const toggle = app.locator(".docbar").getByRole("button", { name: "要約", exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const strip = app.locator(".page-summary");
  // Closed at first: the summary's first line, opened to the whole on a click.
  const row = strip.locator(".summary-row");
  await expect(row).toHaveAttribute("aria-expanded", "false");
  await row.click();
  await expect(strip).toContainText("write skew は防げない");
  // The strip sits above the placeholder the webview follows.
  expect((await strip.boundingBox())!.y).toBeLessThan((await app.locator(".page-host").boundingBox())!.y);

  await openPage(app, ARTICLES.find((a) => a.id !== SNAPSHOT_ID && a.fetch_status === "ok" && !a.original_url.startsWith("local:"))!.title!);
  await expect(app.locator(".docbar").getByRole("button", { name: "要約", exact: true })).toHaveAttribute("aria-pressed", "true");
  await app.locator(".page-summary").getByRole("button", { name: "要約を作成" }).click();
  await expect.poll(async () => (await callsOf(app, "summarize_article")).length).toBe(1);
});

test("an unsaved page has no summary (H13)", async ({ app }) => {
  await app.evaluate(() => window.__e2e.emit("main-request", { kind: "open", docs: [{ kind: "page", url: "https://example.com/unsaved" }] }));
  await expect(app.locator(".docbar").getByRole("button", { name: "Index に追加" })).toBeVisible();
  await expect(app.locator(".docbar").getByRole("button", { name: "要約", exact: true })).toHaveCount(0);
  await expect(app.locator(".page-summary")).toHaveCount(0);
});

/** The right end of the toolbar, and the ⋯ menu's items, by name. */
async function tools(app: Page) {
  const bar = app.locator(".docbar .docbar-r");
  const buttons = await bar.getByRole("button").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? e.textContent));
  await more(app).click();
  const items = await app.getByRole("menu").getByRole("menuitem").allTextContents();
  await app.keyboard.press("Escape");
  return { buttons, items };
}

test("the Reader and the Page toolbars carry the same article actions in the same order (H14)", async ({ app }) => {
  await list(app).locator(".row", { hasText: snapshot.title! }).click();
  const reader = await tools(app);
  await openPage(app, snapshot.title!);
  const page = await tools(app);
  expect(reader.buttons).toEqual([
    "お気に入り (s)",
    "既読にする (m)",
    "質問",
    "理解度チェック",
    "メモ",
    "フォーカスモード (f)",
    expect.stringMatching(/^その他/),
  ]);
  // Page adds its summary strip's toggle before フォーカス.
  expect(page.buttons).toEqual([...reader.buttons.slice(0, 5), "要約", ...reader.buttons.slice(5)]);
  expect(reader.items[1]).toBe("描画して取り込み直す");
  expect(page.items[1]).toBe("表示中のページで取り込み直す");
  expect(page.items.toSpliced(1, 1)).toEqual(reader.items.toSpliced(1, 1));
  expect(reader.items.slice(-2)).toEqual(["URL をコピー", "Index から削除…"]);

  // The quiz opens beside the page, as it does beside the Reader.
  await app.locator(".docbar").getByRole("button", { name: "理解度チェック" }).click();
  await expect(app.locator(".qz-panel")).toBeVisible();
  const host = (await app.locator(".page-host").boundingBox())!,
    panel = (await app.locator(".qz-panel").boundingBox())!;
  expect(host.x + host.width).toBeLessThanOrEqual(panel.x);
});

test("an unsaved page's ⋯ copies its URL (H14)", async ({ app }) => {
  await app.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await app.evaluate(() => window.__e2e.emit("main-request", { kind: "open", docs: [{ kind: "page", url: "https://example.com/unsaved" }] }));
  await more(app).click();
  await expect(app.getByRole("menu").getByRole("menuitem")).toHaveText(["URL をコピー"]);
  await app.getByRole("menuitem", { name: "URL をコピー" }).click();
  await expect.poll(() => app.evaluate(() => navigator.clipboard.readText())).toBe("https://example.com/unsaved");
});

test("a document window's tab strips are its title bar: they drag it, and the top-right one holds the window controls (H19)", async ({ shell }) => {
  const tabs = [{ kind: "page", id: 3, key: "k1", url: "https://example.com/p", title: "P" }];
  await shell.addInitScript(
    (l) => localStorage.setItem("lattice.window.doc-1", l),
    JSON.stringify({ root: { kind: "pane", id: 1, tabs, active: 3 }, focused: 1 }),
  );
  await shell.goto("/?window=doc-1");
  const strips = shell.locator(".dpane .tabs");
  await expect(strips).toHaveCount(1);
  await expect(shell.locator(".titlebar")).toHaveCount(0);
  await expect(shell.getByText("Lattice", { exact: true })).toHaveCount(0);
  const close = strips.getByRole("button", { name: "閉じる", exact: true });
  await expect(close).toBeVisible();
  // The controls sit at the window's top-right corner.
  const box = (await close.boundingBox())!;
  expect(box.y).toBe(0);
  expect(box.x + box.width).toBe(1440);

  const drags = async () => (await callsOf(shell, "plugin:window|start_dragging")).length;
  const maximizes = async () => (await callsOf(shell, "plugin:window|toggle_maximize")).length;
  const empty = strips.locator(".grow");
  await empty.click();
  expect(await drags()).toBe(1);
  await empty.dblclick();
  await expect.poll(maximizes).toBe(1);
  // A press on a tab is the tab's (activate, drag the tab), not the window's.
  const before = await drags();
  await strips.getByRole("tab").first().click();
  expect(await drags()).toBe(before);

  // Split side by side: both strips drag the window, and the controls move to the right one.
  await strips.getByRole("button", { name: "右に分割" }).click();
  await expect(strips).toHaveCount(2);
  await expect(strips.nth(0).getByRole("button", { name: "閉じる", exact: true })).toHaveCount(0);
  await expect(strips.nth(1).getByRole("button", { name: "閉じる", exact: true })).toBeVisible();
  await strips.nth(0).locator(".grow").click();
  expect(await drags()).toBe(before + 1);
});

test("the main window keeps its title bar and its strips do not drag the window (H19)", async ({ app }) => {
  expect(await callsOf(app, "window_ready"), "main is not waiting for a ready command").toEqual([]);
  await list(app).locator(".row").first().click();
  await expect(app.locator(".titlebar")).toHaveCount(1);
  await expect(app.locator(".dpane .tabs .caps")).toHaveCount(0);
  await app.locator(".dpane .tabs .grow").click();
  expect(await callsOf(app, "plugin:window|start_dragging")).toHaveLength(0);
});
