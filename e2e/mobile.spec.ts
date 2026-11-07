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

test("the list filters by state and title", async ({ page }) => {
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
});

const LONG = {
  generated_at: 1,
  ui_language: "ja",
  applied_ops: [],
  articles: Array.from({ length: 150 }, (_, i) => (i === 60 ? row(1, "First article") : row(i + 100, `Article ${i}`))),
};

test("going back from an article returns to the same place, and adds nothing to history", async ({ page }) => {
  await start(page, { index: LONG });
  await page.getByRole("button", { name: "すべて" }).click();
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
  await page.getByRole("button", { name: "すべて" }).click();
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
  await page.getByRole("button", { name: "すべて" }).click();
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
    return route.fulfill({ json: { generated_at: 2, ui_language: "ja", applied_ops: [], articles: [row(9, "Newer article")] } });
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
  await start(page, { index: { generated_at: 1, ui_language: "ja", applied_ops: [], articles } });
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

test("opening an article marks it read, here at once and on the PC by an operation", async ({ page }) => {
  const seen = await start(page);
  await page.getByRole("link", { name: /First article/ }).click();
  await expect(page.getByRole("button", { name: "未読に戻す" })).toBeVisible();
  await expect.poll(() => sentOps(seen).map((o) => o.op)).toEqual([{ kind: "set_read", article_id: 1, read: true }]);
  await page.getByRole("link", { name: "一覧" }).click();
  await expect(page.getByRole("link", { name: /First article/ }), "the unread list no longer has it").toHaveCount(0);
});

test("an article already read is not marked again", async ({ page }) => {
  const seen = await start(page);
  await page.route("**/api/articles/2", (route) => route.fulfill({ json: { ...ARTICLE, article: row(2, "Read article", { read_status: "read" }) } }));
  await page.getByRole("button", { name: "すべて" }).click();
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
  await page.getByRole("button", { name: "すべて" }).click();
  await page.getByRole("link", { name: /First article/ }).click();
  await page.getByRole("button", { name: "未読に戻す" }).waitFor();
  await expect.poll(() => sentOps(seen).length).toBe(1);
  const id = sentOps(seen)[0].id;
  await page.getByRole("link", { name: "一覧" }).click();
  await page.route("**/api/index", (route) =>
    route.fulfill({ json: { generated_at: 2, ui_language: "ja", applied_ops: [id], articles: [row(1, "First article")] } }),
  );
  await page.getByRole("button", { name: "更新" }).click();
  await expect(page.locator("a.unread"), "the server's word now counts: it says unread").toHaveCount(1);
  await page.reload();
  await expect(page.locator("a.unread")).toHaveCount(1);
  expect(sentOps(seen).length).toBe(1);
});

test("an operation the server refuses is dropped, and the reader is told why", async ({ page }) => {
  await start(page);
  await page.getByText("First article").waitFor();
  await page.route("**/api/ops", (route) => route.fulfill({ status: 422, json: { error: '{"code":"mobile.badUrl","params":{}}' } }));
  await page.getByLabel("URLを保存").fill("ftp://example.com/x");
  await page.getByRole("button", { name: "URLを保存" }).click();
  await expect(page.getByRole("alert")).toContainText("http://かhttps://");
  await expect(page.getByText("未送信")).toHaveCount(0);
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

test("a URL can be saved from the list", async ({ page }) => {
  const seen = await start(page);
  await page.getByText("First article").waitFor();
  await expect(page.getByRole("button", { name: "URLを保存" })).toBeDisabled();
  await page.getByLabel("URLを保存").fill(" https://example.com/new ");
  await page.getByRole("button", { name: "URLを保存" }).click();
  await expect(page.getByLabel("URLを保存")).toHaveValue("");
  await expect.poll(() => sentOps(seen).map((o) => o.op)).toEqual([{ kind: "save_url", url: "https://example.com/new" }]);
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
  await expect(page.getByRole("status")).toHaveText("送信しました");
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
