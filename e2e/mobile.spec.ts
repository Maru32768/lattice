// The phone page against a stand-in for its API (the server has its own tests in crates/lattice-server).
import { expect, test, type Page } from "@playwright/test";

const row = (id: number, title: string, more: Record<string, unknown> = {}) => ({
  id,
  title,
  original_url: `https://example.com/${id}`,
  domain: "example.com",
  site_name: "Example",
  feed_title: null,
  saved_at: "2026-11-01T00:00:00Z",
  read_status: "unread",
  favorite: false,
  ...more,
});

const ARTICLE = {
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

async function start(page: Page, opts: { token?: boolean; index?: unknown } = {}) {
  const seen: { path: string; auth: string | null }[] = [];
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    const auth = route.request().headers()["authorization"] ?? null;
    seen.push({ path: url.pathname, auth });
    if (auth !== "Bearer secret") {
      return route.fulfill({ status: 401, json: { error: "unauthorized" } });
    }
    if (url.pathname.endsWith("/api/index")) {
      return route.fulfill({
        json: opts.index ?? {
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
  await expect(page.getByRole("alert")).toHaveText("読み込めませんでした。");
  await expect(page.getByRole("alert")).toBeInViewport();
  await expect(page.getByText("First article")).toBeVisible();
});

test("the list filters by state and title, and keeps its place after reading", async ({ page }) => {
  await start(page);
  await expect(page.getByRole("link")).toHaveCount(1);
  await page.getByRole("button", { name: "すべて" }).click();
  await expect(page.getByRole("link")).toHaveCount(3);
  await page.getByRole("button", { name: "お気に入り" }).click();
  await expect(page.getByRole("link", { name: /Liked article/ })).toBeVisible();
  await expect(page.getByRole("link")).toHaveCount(1);
  await page.getByRole("button", { name: "すべて" }).click();
  await page.getByRole("searchbox").fill("read");
  await expect(page.getByRole("link")).toHaveCount(1);
  await page.getByRole("link", { name: /Read article/ }).waitFor();
  await page.getByRole("searchbox").fill("");
  await page.getByRole("link", { name: /First article/ }).click();
  await expect(page.getByRole("heading", { name: "First article" })).toBeVisible();
  await page.getByRole("link", { name: "一覧" }).click();
  await expect(page.getByRole("link")).toHaveCount(3);
});

test("a long list draws a page at a time", async ({ page }) => {
  const articles = Array.from({ length: 150 }, (_, i) => row(i + 1, `Article ${i + 1}`));
  await start(page, { index: { generated_at: 1, ui_language: "ja", articles } });
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
      [...document.querySelectorAll("button")].flatMap((b) => {
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
