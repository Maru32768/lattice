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

async function start(page: Page, opts: { token?: boolean; index?: unknown; icons?: Record<string, string> } = {}) {
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
    if (url.pathname.endsWith("/api/icons")) {
      return route.fulfill({ json: { format: 1, icons: opts.icons ?? {} } });
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

/** The QR code of https://lattice.example.ts.net/#t=secret&l=lib, as the settings screen draws it (the qrcode crate). */
const QR = [
  "111111100000111011111001001111111",
  "100000100000111111000100001000001",
  "101110101101110111100110101011101",
  "101110101001001110001011101011101",
  "101110101101000101100101001011101",
  "100000101011001110001000101000001",
  "111111101010101010101010101111111",
  "000000001111000100100110000000000",
  "101111100110110101001011101111100",
  "001000001100100010111101001101111",
  "110000100110100100101000110010100",
  "110000010100001010001100010011100",
  "100100101011100000110100110111010",
  "011110011010011110001101011001011",
  "001010110011011000010110011111110",
  "110101010010010010011110011101100",
  "100101110010101001110001010111001",
  "010100000011001011111001001101111",
  "011001110000011101001010110110110",
  "110011011101111011100000000111111",
  "111100110001010010001110000011000",
  "111100001100110101100001101000101",
  "100000101001000111001010111011010",
  "100000010011010100100100000101101",
  "100110110110110101000011111110011",
  "000000001001010000011101100010101",
  "111111100110111110100101101010100",
  "100000101111101000000111100011111",
  "101110101011111100110100111111011",
  "101110101001000110001111110011101",
  "101110101011011000010110101101100",
  "100000100110000010111110010011100",
  "111111101010010011011011101100010",
];

test("the page that asks for the QR code reads it with the camera: on iOS the home screen's page cannot be opened by it", async ({ page }) => {
  await page.addInitScript((rows: string[]) => {
    const canvas = document.createElement("canvas");
    const size = 8;
    canvas.width = canvas.height = (rows.length + 8) * size;
    const ctx = canvas.getContext("2d")!;
    const draw = () => {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#000";
      rows.forEach((row, y) => [...row].forEach((c, x) => c === "1" && ctx.fillRect((x + 4) * size, (y + 4) * size, size, size)));
    };
    draw();
    // A canvas stream sends a frame only when the canvas is drawn.
    setInterval(draw, 100);
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: () => Promise.resolve(canvas.captureStream(10)) } });
  }, QR);
  await start(page, { token: false });
  await page.getByRole("button", { name: "QRコードを読み取る" }).click();
  await expect(page.getByText("First article")).toBeVisible();
  expect(page.url()).not.toContain("secret");
});

test("without a camera the page that asks for the QR code offers the pasted link alone", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "mediaDevices", { value: undefined }));
  await start(page, { token: false });
  await expect(page.getByRole("textbox", { name: "接続用のリンク" })).toBeVisible();
  await expect(page.getByRole("button", { name: "QRコードを読み取る" })).toHaveCount(0);
});

test("a link pasted where the QR code is asked for connects, and one without a token says so", async ({ page }) => {
  await start(page, { token: false });
  const field = page.getByRole("textbox", { name: "接続用のリンク" });
  await field.fill("https://example.com/");
  await page.getByRole("button", { name: "接続" }).click();
  await expect(page.getByRole("alert")).toHaveText("このリンクには接続用のトークンがありません。");
  await field.fill("#t=secret&l=lib");
  await page.getByRole("button", { name: "接続" }).click();
  await expect(page.getByText("First article"), "a bare fragment is no URL, and is taken too").toBeVisible();
});

test("a row shows its site's icon, from one document of them all", async ({ page }) => {
  const dot = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  await start(page, { icons: { "example.com": dot } });
  const icon = page.getByRole("link", { name: /First article/ }).locator("img");
  await expect(icon).toHaveAttribute("src", dot);
  await expect.poll(() => icon.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
});

test("a row shows what the PC's row shows", async ({ page }) => {
  await start(page, {
    index: {
      format: 1,
      generated_at: Math.floor(Date.now() / 1000),
      ui_language: "ja",
      applied_ops: [],
      articles: [
        row(1, "First article", { feed_title: "Rust Blog", difficulty: 3, relevance: 5, favorite: true, tags: ["rust", "async"], fetch_status: "failed" }),
      ],
    },
  });
  const link = page.getByRole("link", { name: /First article/ });
  await expect(link).toContainText("Rust Blog");
  await expect(link).toContainText("11/01");
  await expect(link.getByRole("img", { name: /難易度/ })).toBeVisible();
  await expect(link).toContainText("重要5");
  await expect(link).toContainText("★");
  await expect(link).toContainText("取得失敗");
  await expect(link).toContainText("rust · async");
});

test("a dimension with many values can be searched in the sheet, prefix matches first", async ({ page }) => {
  const tags = Array.from({ length: 40 }, (_, i) => `tag${i}`).concat(["postgres", "mypostgres"]);
  await start(page, {
    index: {
      format: 1,
      generated_at: 1,
      ui_language: "ja",
      applied_ops: [],
      articles: [row(1, "First article", { tags }), row(2, "Second", { tags: ["postgres"] })],
    },
  });
  await page.getByRole("button", { name: "絞り込み", exact: true }).click();
  const region = page.getByRole("dialog").getByRole("region", { name: "タグ" });
  await expect(region.getByRole("button", { name: /^tag\d+/ })).not.toHaveCount(40);
  await region.getByRole("searchbox", { name: "タグで絞り込む" }).fill("postgres");
  await expect(region.locator(".m-chip")).toHaveText([/^postgres/, /^mypostgres/]);
  await region.getByRole("button", { name: /^postgres/ }).click();
  await region.getByRole("searchbox", { name: "タグで絞り込む" }).fill("tag1");
  await expect(region.getByRole("button", { name: /^postgres/ }), "the chosen one stays in view").toHaveAttribute("aria-pressed", "true");
});

test("an image the PC stored shows in the text, fetched with the token; one it has not stays a link", async ({ page }) => {
  const asked: (string | undefined)[] = [];
  await start(page);
  await page.route("**/api/images/12", (route) => {
    asked.push(route.request().headers()["authorization"]);
    return route.fulfill({
      body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"),
      headers: { "content-type": "image/png" },
    });
  });
  await page.getByRole("link", { name: /First article/ }).click();
  const img = page.getByRole("img", { name: "A figure" });
  await expect(img).toHaveAttribute("src", /^blob:/);
  expect(asked).toEqual(["Bearer secret"]);
  await page.unroute("**/api/images/12");
  await page.route("**/api/images/12", (route) => route.fulfill({ status: 200, body: "<html>login</html>", headers: { "content-type": "text/html" } }));
  await page.reload();
  await expect(page.getByRole("link", { name: "画像: A figure" }), "a tunnel's page in place of the image").toBeVisible();
  await page.unroute("**/api/images/12");
  await page.route("**/api/images/12", (route) => route.fulfill({ body: "not an image", headers: { "content-type": "image/png" } }));
  await page.reload();
  await expect(page.getByRole("link", { name: "画像: A figure" }), "an image that does not render").toBeVisible();
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
