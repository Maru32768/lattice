// The phone page against a stand-in for its API (the server has its own tests in crates/lattice-server).
import { showScope } from "./phone.ts";
import { expect, test, type Page } from "@playwright/test";

const row = (id: number, title: string, more: Record<string, unknown> = {}) => ({
  id,
  title,
  original_url: `https://example.com/${id}`,
  domain: "example.com",
  site_name: "Example",
  feed_title: null,
  tags: [],
  groups: [],
  saved_at: "2026-11-01T00:00:00Z",
  read_status: "unread",
  favorite: false,
  ...more,
});

const ARTICLE = {
  format: 1,
  article: row(1, "First article"),
  target_language: "ja",
  summary: { text: "A short summary.", created_at: "2026-11-01T00:00:00Z", stale: false },
  blocks: [
    {
      id: 10,
      ordinal: 0,
      kind: "heading",
      text: "A heading",
      attrs: { level: 2 },
      translation: "見出し",
      units: [{ source: "A heading", translation: "見出し" }],
    },
    {
      id: 11,
      ordinal: 1,
      kind: "paragraph",
      text: "First sentence. Second sentence.",
      attrs: {},
      translation: "一文目。二文目。",
      units: [
        { source: "First sentence.", translation: "一文目。" },
        { source: "Second sentence.", translation: "二文目。" },
      ],
    },
    { id: 12, ordinal: 2, kind: "image", text: "A figure", attrs: { src: "https://example.com/figure.png" }, translation: null },
    {
      id: 13,
      ordinal: 3,
      kind: "paragraph",
      text: "See the link.",
      inlines: [{ t: "link", v: "See the link.", href: "https://example.com/more" }],
      attrs: {},
      translation: null,
    },
  ],
};

interface Op {
  id: string;
  op: { kind: string; [key: string]: unknown };
}

/** The operations the page sent. */
const sentOps = (seen: { path: string; body?: Op }[]) => seen.filter((r) => r.path.endsWith("/api/ops")).map((r) => r.body!);

async function start(page: Page, opts: { token?: boolean; index?: unknown } = {}) {
  const seen: { path: string; auth: string | null; body?: Op }[] = [];
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    const auth = route.request().headers()["authorization"] ?? null;
    seen.push({ path: url.pathname, auth, body: route.request().postDataJSON() as Op | undefined });
    if (auth !== "Bearer secret") {
      return route.fulfill({ status: 401, json: { error: "unauthorized" } });
    }
    if (url.pathname.endsWith("/api/ops")) {
      return route.fulfill({ json: { status: "applied" } });
    }
    if (url.pathname.endsWith("/api/index")) {
      return route.fulfill({
        json: opts.index ?? {
          format: 1,
          generated_at: 1,
          ui_language: "ja",
          articles: [
            row(1, "First article"),
            row(2, "Read article", { read_status: "read" }),
            row(3, "Liked article", { read_status: "read", favorite: true }),
          ],
        },
      });
    }
    if (url.pathname.endsWith("/api/articles/1")) {
      return route.fulfill({ json: ARTICLE });
    }
    return route.fulfill({ status: 404, json: { error: "no such article" } });
  });
  await page.goto(opts.token === false ? "/mobile.html" : "/mobile.html#t=secret");
  return seen;
}

test.use({ viewport: { width: 390, height: 844 }, locale: "ja-JP" });

test("the token from the QR code leaves the address and stays for the next visit", async ({ page }) => {
  const seen = await start(page);
  await expect(page.getByText("First article")).toBeVisible();
  expect(page.url()).not.toContain("secret");
  await page.reload();
  await expect(page.getByText("First article")).toBeVisible();
  expect(seen.every((r) => r.auth === "Bearer secret")).toBe(true);
});

test("without a token the page says where to get one, and asks the server nothing", async ({ page }) => {
  const seen = await start(page, { token: false });
  await expect(page.getByText("QRコードを読み取ってください")).toBeVisible();
  expect(seen).toEqual([]);
});

test("a token the server no longer takes sends the reader back to the QR code", async ({ page }) => {
  await start(page);
  await page.getByText("First article").waitFor();
  await page.unroute("**/api/**");
  await page.route("**/api/**", (route) => route.fulfill({ status: 401, json: { error: "unauthorized" } }));
  await page.getByRole("button", { name: "更新" }).click();
  await expect(page.getByText("QRコードを読み取ってください")).toBeVisible();
  await page.reload();
  await expect(page.getByText("QRコードを読み取ってください")).toBeVisible();
});

test("a token the server turns away stays stored: it may have been another server on the port", async ({ page }) => {
  await start(page);
  await page.getByText("First article").waitFor();
  await page.unroute("**/api/**");
  await page.route("**/api/**", (route) => route.fulfill({ status: 401, json: {} }));
  await page.reload();
  await expect(page.getByText("QRコードを読み取ってください")).toBeVisible();
  await page.unroute("**/api/**");
  await start(page, { token: false });
  await expect(page.getByText("First article")).toBeVisible();
});

test("a new QR code opened in the same tab is taken without a reload", async ({ page }) => {
  await start(page, { token: false });
  await expect(page.getByText("QRコードを読み取ってください")).toBeVisible();
  await page.evaluate(() => (location.hash = "#t=secret"));
  await expect(page.getByText("First article")).toBeVisible();
  expect(page.url()).not.toContain("secret");
});

test("a failed refresh leaves the list on screen", async ({ page }) => {
  await start(page);
  await page.getByText("First article").waitFor();
  await page.unroute("**/api/**");
  await page.route("**/api/**", (route) => route.abort());
  await page.getByRole("button", { name: "更新" }).click();
  await expect(page.getByRole("alert")).toHaveText("接続できないので、保存した内容を表示しています");
  await expect(page.getByRole("alert")).toBeInViewport();
  await expect(page.getByText("First article")).toBeVisible();
});

test("the list filters by state and title", async ({ page }) => {
  await start(page);
  await expect(page.getByRole("link")).toHaveCount(1);
  await showScope(page, "すべての記事");
  await expect(page.getByRole("link")).toHaveCount(3);
  await showScope(page, "お気に入り");
  await expect(page.getByRole("link", { name: /Liked article/ })).toBeVisible();
  await expect(page.getByRole("link")).toHaveCount(1);
  await showScope(page, "すべての記事");
  await page.getByRole("searchbox").fill("read");
  await expect(page.getByRole("link")).toHaveCount(1);
  await page.getByRole("link", { name: /Read article/ }).waitFor();
});

test("the filter sheet narrows the list as the PC's filters do, and the bar says what is on", async ({ page }) => {
  await start(page, {
    index: {
      format: 1,
      generated_at: 1,
      ui_language: "ja",
      applied_ops: [],
      groups: [{ id: 7, name: "あとで読む", created_at: "2026-11-01T00:00:00Z", count: 1 }],
      articles: [
        row(1, "Postgres MVCC", { genre: "データベース", tags: ["postgres", "mvcc"], groups: [7] }),
        row(2, "SQLite WAL", { genre: "データベース", tags: ["sqlite"] }),
        row(3, "CSS grid", { genre: "フロントエンド", tags: ["css"], read_status: "read" }),
      ],
    },
  });
  await expect(page.getByRole("link")).toHaveCount(2);
  await page.getByRole("button", { name: "絞り込み", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "絞り込み" });
  await sheet.getByRole("region", { name: "表示" }).getByRole("button", { name: "すべての記事", exact: true }).click();
  await sheet
    .getByRole("region", { name: "ジャンル" })
    .getByRole("button", { name: /データベース/ })
    .click();
  await expect(sheet.getByRole("button", { name: "2件を表示" })).toBeVisible();
  await expect(
    sheet.getByRole("region", { name: "ジャンル" }).getByRole("button", { name: /フロントエンド/ }),
    "its own choice does not hide the others",
  ).toContainText("1");
  await sheet
    .getByRole("region", { name: "グループ" })
    .getByRole("button", { name: /あとで読む/ })
    .click();
  await sheet.getByRole("button", { name: "1件を表示" }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole("link")).toHaveCount(1);
  await expect(page.getByRole("link", { name: /Postgres MVCC/ })).toBeVisible();
  await expect(page.getByRole("banner")).toContainText("すべての記事 · データベース · あとで読む · 1件");
  await page.getByRole("button", { name: "絞り込み", exact: true }).click();
  await sheet.getByRole("button", { name: "絞り込みを解除" }).click();
  await sheet.getByRole("button", { name: "閉じる" }).click();
  await expect(page.getByRole("link")).toHaveCount(3);
});

test("an article read from 未読 stays in the list until the view changes", async ({ page }) => {
  await start(page);
  await page.getByRole("link", { name: /First article/ }).click();
  await page.getByRole("link", { name: "一覧" }).click();
  await expect(page.getByRole("link", { name: /First article/ })).toBeVisible();
  await showScope(page, "すべての記事");
  await showScope(page, "未読");
  await expect(page.getByRole("link", { name: /First article/ })).toHaveCount(0);
});

test("on iOS, the home screen's page, which has storage of its own, gets the token from the address", async ({ page, browser }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "standalone", { value: false }));
  await start(page);
  await page.getByText("First article").waitFor();
  expect(page.url()).not.toContain("secret");
  await page.getByRole("button", { name: "ホーム画面に追加" }).click();
  await expect(page.getByRole("status")).toContainText("共有メニュー");
  const saved = page.url();
  expect(saved).toContain("#t=secret");
  const home = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: "ja-JP" });
  await start(home, { token: false });
  await home.goto(saved);
  await expect(home.getByText("First article")).toBeVisible();
  expect(home.url()).not.toContain("secret");
  await expect(home.getByRole("button", { name: "ホーム画面に追加" }), "nowhere but in Safari").toHaveCount(0);
  await home.close();
});

const LONG = {
  format: 1,
  generated_at: 1,
  ui_language: "ja",
  applied_ops: [],
  articles: Array.from({ length: 150 }, (_, i) => (i === 60 ? row(1, "First article") : row(i + 100, `Article ${i}`))),
};

test("going back from an article returns to the same place, and adds nothing to history", async ({ page }) => {
  await start(page, { index: LONG });
  await showScope(page, "すべての記事");
  await page.getByRole("link", { name: /First article/ }).scrollIntoViewIfNeeded();
  const place = await page.evaluate(() => scrollY);
  expect(place).toBeGreaterThan(500);
  const before = await page.evaluate(() => history.length);
  await page.getByRole("link", { name: /First article/ }).click();
  await expect(page.getByRole("heading", { name: "First article" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await page.getByRole("link", { name: "一覧" }).click();
  await expect(page.getByRole("link", { name: /First article/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(place);
  expect(await page.evaluate(() => history.length), "the article is the only new entry").toBe(before + 1);
  await page.goBack();
  await expect(page.getByRole("link", { name: /First article/ })).toHaveCount(0);
});

test("the phone's back button also returns to the same place", async ({ page }) => {
  await start(page, { index: LONG });
  await showScope(page, "すべての記事");
  await page.getByRole("link", { name: /First article/ }).scrollIntoViewIfNeeded();
  const place = await page.evaluate(() => scrollY);
  await page.getByRole("link", { name: /First article/ }).click();
  await expect(page.getByRole("heading", { name: "First article" })).toBeVisible();
  await page.goBack();
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(place);
});

test("a different list starts at its top", async ({ page }) => {
  await start(page, { index: LONG });
  await page.getByRole("link", { name: /First article/ }).scrollIntoViewIfNeeded();
  await showScope(page, "すべての記事");
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
});

test("the answer to the latest request wins, whatever order they come back in", async ({ page }) => {
  await start(page);
  await page.getByText("First article").waitFor();
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  await page.unroute("**/api/**");
  await page.route("**/api/index", async (route) => {
    calls++;
    if (calls === 1) {
      await held;
      return route.fulfill({ status: 401, json: {} });
    }
    return route.fulfill({ json: { format: 1, generated_at: 2, ui_language: "ja", applied_ops: [], articles: [row(9, "Newer article")] } });
  });
  await page.getByRole("button", { name: "更新" }).click();
  await expect.poll(() => calls).toBe(1);
  await page.evaluate(() => (location.hash = "#t=secret"));
  await expect(page.getByText("Newer article")).toBeVisible();
  release();
  await page.waitForTimeout(100);
  await expect(page.getByText("Newer article")).toBeVisible();
  await expect(page.getByText("QRコードを読み取ってください")).toHaveCount(0);
});

test("a summary made before the article changed says so", async ({ page }) => {
  await start(page);
  await page.route("**/api/articles/1", (route) => route.fulfill({ json: { ...ARTICLE, summary: { ...ARTICLE.summary, stale: true } } }));
  await page.getByRole("link", { name: /First article/ }).click();
  await page.getByText("要約", { exact: true }).click();
  await expect(page.getByText("A short summary.")).toBeVisible();
  await expect(page.locator(".m-summary .m-note")).toBeVisible();
});

test("a long list draws a page at a time", async ({ page }) => {
  const articles = Array.from({ length: 150 }, (_, i) => row(i + 1, `Article ${i + 1}`));
  await start(page, { index: { format: 1, generated_at: 1, ui_language: "ja", applied_ops: [], articles } });
  await expect(page.getByRole("link")).toHaveCount(100);
  await page.getByRole("button", { name: "もっと見る(残り50件)" }).click();
  await expect(page.getByRole("link")).toHaveCount(150);
});

test("the article shows original, translated and mixed text, and remembers the choice", async ({ page }) => {
  await start(page);
  await page.getByRole("link", { name: /First article/ }).click();
  await expect(page.getByText("一文目。")).toBeVisible();
  await expect(page.getByRole("heading", { name: "見出し" })).toBeVisible();
  await page.getByRole("button", { name: "原文" }).click();
  await expect(page.getByText("First sentence.")).toBeVisible();
  await expect(page.getByText("一文目。")).toHaveCount(0);
  await page.getByRole("button", { name: "混在" }).click();
  await expect(page.getByText("50%")).toBeVisible();
  await page.getByRole("button", { name: "日本語の割合を上げる" }).click();
  await expect(page.getByText("60%")).toBeVisible();
  await page.reload();
  await expect(page.getByText("60%")).toBeVisible();
});

test("tapping a sentence shows its other language, and a selection leaves it alone", async ({ page }) => {
  await start(page);
  await page.getByRole("link", { name: /First article/ }).click();
  await page.getByText("一文目。").click();
  await expect(page.getByText("First sentence.")).toBeVisible();
  await expect(page.getByText("二文目。")).toBeVisible();
  await page.getByRole("button", { name: "原文" }).click();
  await expect(page.getByText("一文目。")).toHaveCount(0);
  await expect(page.getByText("First sentence.")).toBeVisible();
  await page.getByRole("button", { name: "訳文" }).click();
  await expect(page.getByText("一文目。")).toBeVisible();
  await page.evaluate(() => {
    const el = [...document.querySelectorAll(".sent")].find((e) => e.textContent === "一文目。")!;
    getSelection()!.selectAllChildren(el);
  });
  await page.getByText("一文目。").dispatchEvent("click");
  await expect(page.getByText("一文目。")).toBeVisible();
});

test("an article with nothing to translate says so, not that it waits for a translation", async ({ page }) => {
  await start(page);
  await page.route("**/api/articles/1", (route) =>
    route.fulfill({ json: { ...ARTICLE, blocks: [{ id: 20, ordinal: 0, kind: "code", text: "let x = 1;", attrs: {}, translation: null }] } }),
  );
  await page.getByRole("link", { name: /First article/ }).click();
  await expect(page.getByText("let x = 1;")).toBeVisible();
  await expect(page.getByText("まだ翻訳されていません")).toHaveCount(0);
});

test("article content cannot run or load anything", async ({ page }) => {
  const remote: string[] = [];
  page.on("request", (r) => {
    if (!r.url().includes("localhost")) {
      remote.push(r.url());
    }
  });
  await start(page);
  await page.getByRole("link", { name: /First article/ }).click();
  await expect(page.getByRole("link", { name: "画像: A figure" })).toBeVisible();
  expect(remote).toEqual([]);
  await expect(page.locator("img")).toHaveCount(0);
});

test("the page fits the phone's width", async ({ page }) => {
  await start(page);
  await page.getByRole("link", { name: /First article/ }).click();
  await expect(page.getByText("一文目。")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("every button can be tapped over its whole height", async ({ page }) => {
  await start(page);
  await page.getByText("First article").waitFor();
  const small = async () =>
    page.evaluate(() =>
      // Not those in the closed filter sheet.
      [...document.querySelectorAll("button")]
        .filter((b) => b.checkVisibility())
        .flatMap((b) => {
          const r = b.getBoundingClientRect();
          const hit = (y: number) => document.elementFromPoint(r.left + r.width / 2, y) === b;
          return r.height >= 40 && hit(r.top + 1) && hit(r.bottom - 1) ? [] : [b.textContent];
        }),
    );
  expect(await small()).toEqual([]);
  await page.getByRole("link", { name: /First article/ }).click();
  await page.getByRole("button", { name: "混在" }).click();
  expect(await small()).toEqual([]);
});

test("opening an article marks it read, here at once and on the PC by an operation", async ({ page }) => {
  const seen = await start(page);
  await page.getByRole("link", { name: /First article/ }).click();
  await expect(page.getByRole("button", { name: "未読に戻す" })).toBeVisible();
  await expect.poll(() => sentOps(seen).map((o) => o.op)).toEqual([{ kind: "set_read", article_id: 1, read: true }]);
  await page.getByRole("link", { name: "一覧" }).click();
  await expect(page.getByRole("link", { name: /First article/ }), "kept where it was read, as on the PC").toBeVisible();
});

test("an article already read is not marked again", async ({ page }) => {
  const seen = await start(page);
  await page.route("**/api/articles/2", (route) => route.fulfill({ json: { ...ARTICLE, article: row(2, "Read article", { read_status: "read" }) } }));
  await showScope(page, "すべての記事");
  await page.getByRole("link", { name: /Read article/ }).click();
  await expect(page.getByRole("button", { name: "未読に戻す" })).toBeVisible();
  expect(sentOps(seen)).toEqual([]);
});

test("favorites and read state can be changed from the article", async ({ page }) => {
  const seen = await start(page);
  await page.getByRole("link", { name: /First article/ }).click();
  await page.getByRole("button", { name: "お気に入りに追加" }).click();
  await page.getByRole("button", { name: "お気に入りから外す" }).waitFor();
  await page.getByRole("button", { name: "未読に戻す" }).click();
  await page.getByRole("button", { name: "既読にする" }).waitFor();
  await expect
    .poll(() => sentOps(seen).map((o) => o.op))
    .toEqual([
      { kind: "set_read", article_id: 1, read: true },
      { kind: "set_favorite", article_id: 1, favorite: true },
      { kind: "set_read", article_id: 1, read: false },
    ]);
  expect(new Set(sentOps(seen).map((o) => o.id)).size).toBe(3);
});

test("what cannot be sent waits on the phone, across a reload, and goes when it can", async ({ page }) => {
  const seen = await start(page);
  await page.getByText("First article").waitFor();
  await page.route("**/api/ops", (route) => route.abort());
  await page.getByRole("link", { name: /First article/ }).click();
  await page.getByRole("button", { name: "未読に戻す" }).waitFor();
  await page.getByRole("link", { name: "一覧" }).click();
  await expect(page.getByText("未送信1件")).toBeVisible();
  await page.reload();
  await expect(page.getByText("未送信1件")).toBeVisible();
  await expect(page.getByRole("link", { name: /First article/ }), "still shown as read").toHaveCount(0);
  await page.unroute("**/api/ops");
  await page.getByRole("button", { name: "更新" }).click();
  await expect(page.getByText("未送信1件")).toHaveCount(0);
  expect(sentOps(seen).at(-1)?.op).toEqual({ kind: "set_read", article_id: 1, read: true });
});

test("an operation the list reflects stops being kept, and sending it never happens twice", async ({ page }) => {
  const seen = await start(page);
  await page.getByText("First article").waitFor();
  await showScope(page, "すべての記事");
  await page.getByRole("link", { name: /First article/ }).click();
  await page.getByRole("button", { name: "未読に戻す" }).waitFor();
  await expect.poll(() => sentOps(seen).length).toBe(1);
  const id = sentOps(seen)[0].id;
  await page.getByRole("link", { name: "一覧" }).click();
  await page.route("**/api/index", (route) =>
    route.fulfill({ json: { format: 1, generated_at: 2, ui_language: "ja", applied_ops: [id], articles: [row(1, "First article")] } }),
  );
  await page.getByRole("button", { name: "更新" }).click();
  await expect(page.locator("a.unread"), "the server's word now counts: it says unread").toHaveCount(1);
  await page.reload();
  await expect(page.locator("a.unread")).toHaveCount(1);
  expect(sentOps(seen).length).toBe(1);
});

test("an operation the server refuses is dropped, and the reader is told which and why", async ({ page }) => {
  await start(page);
  await page.getByText("First article").waitFor();
  await page.route("**/api/ops", (route) => route.fulfill({ status: 422, json: { error: '{"code":"mobile.badUrl","params":{}}' } }));
  await page.getByLabel("URLを保存").fill("https://example.com/one");
  await page.getByRole("button", { name: "URLを保存" }).click();
  await page.getByLabel("URLを保存").fill("https://example.com/two");
  await page.getByRole("button", { name: "URLを保存" }).click();
  await expect(page.getByRole("alert")).toContainText("https://example.com/one");
  await expect(page.getByRole("alert")).toContainText("https://example.com/two");
  await expect(page.getByRole("alert")).toContainText("http://かhttps://");
  await expect(page.getByText("未送信")).toHaveCount(0);
});

for (const [name, answer] of [
  ["a proxy's 403 page", { status: 403, contentType: "text/html", body: "<h1>Forbidden</h1>" }],
  ["a captive portal's 200 page", { status: 200, contentType: "text/html", body: "<h1>Sign in to this Wi-Fi</h1>" }],
  ["a read-only server", { status: 403, json: { error: '{"code":"mobile.readOnly","params":{}}' } }],
  ["a tunnel with the PC off", { status: 502, contentType: "text/html", body: "Bad gateway" }],
] as const) {
  test(`an operation answered by ${name} is kept and goes later`, async ({ page }) => {
    const seen = await start(page);
    await page.getByText("First article").waitFor();
    await page.route("**/api/ops", (route) => route.fulfill(answer));
    await page.getByLabel("URLを保存").fill("https://example.com/kept");
    await page.getByRole("button", { name: "URLを保存" }).click();
    await expect(page.getByText("未送信1件")).toBeVisible();
    await page.unroute("**/api/ops");
    await page.reload();
    await expect(page.getByText("未送信1件")).toHaveCount(0);
    expect(sentOps(seen).at(-1)?.op).toEqual({ kind: "save_url", url: "https://example.com/kept" });
  });
}

test("what can never get through can be discarded", async ({ page }) => {
  const seen = await start(page);
  await page.getByText("First article").waitFor();
  await page.route("**/api/ops", (route) => route.abort());
  await page.getByLabel("URLを保存").fill("https://example.com/stuck");
  await page.getByRole("button", { name: "URLを保存" }).click();
  await expect(page.getByText("未送信1件")).toBeVisible();
  page.on("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "破棄" }).click();
  await expect(page.getByText("未送信")).toHaveCount(0);
  await page.unroute("**/api/ops");
  await page.reload();
  await page.getByText("First article").waitFor();
  expect(sentOps(seen)).toEqual([]);
});

test("two tabs share what waits: one does not erase the other's", async ({ page, context }) => {
  await start(page);
  await page.getByText("First article").waitFor();
  await page.route("**/api/ops", (route) => route.abort());
  const other = await context.newPage();
  await start(other, { token: false });
  await other.route("**/api/ops", (route) => route.abort());
  await other.getByText("First article").waitFor();
  await other.getByLabel("URLを保存").fill("https://example.com/other");
  await other.getByRole("button", { name: "URLを保存" }).click();
  await expect(other.getByText("未送信1件")).toBeVisible();
  await expect(page.getByText("未送信1件"), "the first tab sees it too").toBeVisible();
  await other.close();
  await page.getByLabel("URLを保存").fill("https://example.com/first");
  await page.getByRole("button", { name: "URLを保存" }).click();
  await expect(page.getByText("未送信2件")).toBeVisible();
  await page.reload();
  await expect(page.getByText("未送信2件")).toBeVisible();
});

test("what waits goes when the reader comes back to the page", async ({ page }) => {
  const seen = await start(page);
  await page.getByText("First article").waitFor();
  await page.route("**/api/ops", (route) => route.abort());
  await page.getByLabel("URLを保存").fill("https://example.com/later");
  await page.getByRole("button", { name: "URLを保存" }).click();
  await expect(page.getByText("未送信1件")).toBeVisible();
  await page.unroute("**/api/ops");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByText("未送信1件")).toHaveCount(0);
  expect(sentOps(seen).at(-1)?.op).toEqual({ kind: "save_url", url: "https://example.com/later" });
});

test("a read-only server offers no operations and marks nothing", async ({ page }) => {
  const seen = await start(page, {
    index: { format: 1, generated_at: 1, ui_language: "ja", applied_ops: [], read_only: true, articles: [row(1, "First article")] },
  });
  await expect(page.getByLabel("URLを保存")).toHaveCount(0);
  await page.getByRole("link", { name: /First article/ }).click();
  await page.getByRole("heading", { name: "First article" }).waitFor();
  await expect(page.getByRole("button", { name: /お気に入り|未読|既読/ })).toHaveCount(0);
  await page.getByRole("button", { name: "原文" }).click();
  await page.evaluate(() => {
    const text = [...document.querySelectorAll(".sent")].find((e) => e.textContent === "Second sentence.")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, "Second".length);
    getSelection()!.addRange(range);
  });
  await page.waitForTimeout(100);
  await expect(page.getByRole("button", { name: /単語を登録/ })).toHaveCount(0);
  expect(sentOps(seen)).toEqual([]);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("reloading on an article does not undo marking it unread", async ({ page }) => {
  const seen = await start(page);
  await page.getByRole("link", { name: /First article/ }).click();
  await page.getByRole("button", { name: "未読に戻す" }).click();
  await page.getByRole("button", { name: "既読にする" }).waitFor();
  await expect.poll(() => sentOps(seen).length).toBe(2);
  await page.reload();
  await page.getByRole("button", { name: "既読にする" }).waitFor();
  expect(sentOps(seen).length).toBe(2);
});

test("the open article follows the list once the list has settled what was done", async ({ page }) => {
  const seen = await start(page);
  await showScope(page, "すべての記事");
  await page.getByRole("link", { name: /First article/ }).click();
  await page.getByRole("button", { name: "未読に戻す" }).waitFor();
  await expect.poll(() => sentOps(seen).length).toBe(1);
  await page.route("**/api/index", (route) =>
    route.fulfill({
      json: { format: 1, generated_at: 2, ui_language: "ja", applied_ops: [sentOps(seen)[0].id], articles: [row(1, "First article", { read_status: "read" })] },
    }),
  );
  await page.reload();
  await expect(page.getByRole("button", { name: "未読に戻す" }), "its own copy still says unread; the list knows better").toBeVisible();
});

test("another library's QR code clears what waits; a new token of this one keeps it", async ({ page }) => {
  const seen = await start(page, { token: false });
  await page.goto("/mobile.html#t=secret&l=first");
  await page.getByText("First article").waitFor();
  await page.route("**/api/ops", (route) => route.abort());
  await page.getByLabel("URLを保存").fill("https://example.com/waiting");
  await page.getByRole("button", { name: "URLを保存" }).click();
  await expect(page.getByText("未送信1件")).toBeVisible();
  await page.evaluate(() => (location.hash = "#t=secret&l=first"));
  await expect(page.getByText("未送信1件")).toBeVisible();
  await page.evaluate(() => (location.hash = "#t=secret&l=another"));
  await expect(page.getByText("未送信")).toHaveCount(0);
  await page.unroute("**/api/ops");
  await page.reload();
  await page.getByText("First article").waitFor();
  expect(sentOps(seen)).toEqual([]);
});

test("a URL can be saved from the list, by the button or the keyboard's Go", async ({ page }) => {
  const seen = await start(page);
  await page.getByText("First article").waitFor();
  const box = page.getByLabel("URLを保存");
  const button = page.getByRole("button", { name: "URLを保存" });
  await expect(button).toBeDisabled();
  await box.fill("example.com/no-scheme");
  await expect(button, "refused while the text is there to correct").toBeDisabled();
  await box.press("Enter");
  await expect(box).toHaveValue("example.com/no-scheme");
  await box.fill(" https://example.com/new ");
  await button.click();
  await expect(box).toHaveValue("");
  await expect(page.getByRole("status")).toContainText("受け付けました");
  await box.fill("https://example.com/go");
  await box.press("Enter");
  await expect(box).toHaveValue("");
  await expect
    .poll(() => sentOps(seen).map((o) => o.op))
    .toEqual([
      { kind: "save_url", url: "https://example.com/new" },
      { kind: "save_url", url: "https://example.com/go" },
    ]);
});

test("a selected word can be saved with its sentence and source", async ({ page }) => {
  const seen = await start(page);
  await page.getByRole("link", { name: /First article/ }).click();
  await page.getByRole("button", { name: "原文" }).click();
  await page.evaluate(() => {
    const el = [...document.querySelectorAll(".sent")].find((e) => e.textContent === "Second sentence.")!;
    const text = el.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, "Second".length);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  });
  await page.getByRole("button", { name: "単語を登録: Second" }).click();
  await expect(page.getByRole("status")).toHaveText("単語を受け付けました");
  await expect(page.getByRole("button", { name: /単語を登録/ }), "the selection does not offer it again").toHaveCount(0);
  await expect
    .poll(() => sentOps(seen).at(-1)?.op)
    .toEqual({
      kind: "vocab_add",
      capture: { surface: "Second", sentence: "Second sentence.", article_id: 1, block_id: 11, url: "https://example.com/1" },
    });
});

test("Japanese or a long selection offers no word", async ({ page }) => {
  await start(page);
  await page.getByRole("link", { name: /First article/ }).click();
  await page.evaluate(() => getSelection()!.selectAllChildren([...document.querySelectorAll(".sent")].find((e) => e.textContent === "一文目。")!));
  await page.waitForTimeout(100);
  await expect(page.getByRole("button", { name: /単語を登録/ })).toHaveCount(0);
});

test("a tap that collapses the selection first still saves the word", async ({ page }) => {
  const seen = await start(page);
  await page.getByRole("link", { name: /First article/ }).click();
  await page.getByRole("button", { name: "原文" }).click();
  await page.evaluate(() => {
    const text = [...document.querySelectorAll(".sent")].find((e) => e.textContent === "Second sentence.")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, "Second".length);
    getSelection()!.addRange(range);
  });
  const button = page.getByRole("button", { name: "単語を登録: Second" });
  await button.waitFor();
  await page.evaluate(() => getSelection()!.removeAllRanges());
  await button.click();
  await expect.poll(() => sentOps(seen).at(-1)?.op.kind).toBe("vocab_add");
  await page.waitForTimeout(600);
  await expect(page.getByRole("button", { name: /単語を登録/ })).toHaveCount(0);
});

test("a selection given up on takes its button with it", async ({ page }) => {
  await start(page);
  await page.getByRole("link", { name: /First article/ }).click();
  await page.getByRole("button", { name: "原文" }).click();
  await page.evaluate(() => {
    const text = [...document.querySelectorAll(".sent")].find((e) => e.textContent === "Second sentence.")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, "Second".length);
    getSelection()!.addRange(range);
  });
  await page.getByRole("button", { name: "単語を登録: Second" }).waitFor();
  await page.evaluate(() => getSelection()!.removeAllRanges());
  await expect(page.getByRole("button", { name: /単語を登録/ })).toHaveCount(0);
});

test("a document of another format asks for a reload instead of going blank", async ({ page }) => {
  await start(page, { index: { format: 2, generated_at: 1, ui_language: "ja", applied_ops: [], articles: "not what this page knows" } });
  await expect(page.getByRole("alert")).toContainText("読み込み直してください");
  await expect(page.getByRole("button", { name: "読み込み直す" })).toBeVisible();
});

test("something the page cannot draw asks for a reload instead of going blank", async ({ page }) => {
  await start(page, { index: { format: 1, generated_at: 1, ui_language: "ja", applied_ops: [], articles: "not a list" } });
  await expect(page.getByRole("alert")).toContainText("読み込み直してください");
});

test("a login page answered in place of the list is not taken for it", async ({ page }) => {
  await start(page, { token: true });
  await page.getByText("First article").waitFor();
  await page.route("**/api/index", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<h1>Sign in</h1>" }));
  await page.getByRole("button", { name: "更新" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByText("First article")).toBeVisible();
});

test("an operation past its time is never sent", async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("seeded")) {
      localStorage.setItem("seeded", "1");
      const old = Date.now() - 61 * 24 * 60 * 60 * 1000;
      localStorage.setItem("lattice.mobile.ops", JSON.stringify([{ id: "old", op: { kind: "set_read", article_id: 1, read: true }, at: old, sent: false }]));
    }
  });
  const seen = await start(page);
  await page.getByText("First article").waitFor();
  await page.waitForTimeout(200);
  expect(sentOps(seen)).toEqual([]);
});

test("a token the server turns away can be tried again without a new QR code", async ({ page }) => {
  await start(page);
  await page.getByText("First article").waitFor();
  await page.route("**/api/index", (route) => route.fulfill({ status: 401, json: { error: "unauthorized" } }));
  await page.getByRole("button", { name: "更新" }).click();
  await expect(page.getByText("QRコードを読み取ってください")).toBeVisible();
  await page.unroute("**/api/index");
  await page.getByRole("button", { name: "もう一度" }).click();
  await expect(page.getByText("First article")).toBeVisible();
});
