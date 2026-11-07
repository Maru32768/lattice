// The whole phone path with the real Worker code and the built page: a real service worker needs real
// servers. Here the "PC" (its server's API, without the Rust behind it) comes and goes as the test says.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
// @ts-expect-error -- plain JavaScript: Terraform uploads this very file.
import { handle } from "../infra/mobile/worker.js";

const TOKEN = "secret";
const DIST = new URL("../crates/lattice-server/mobile-dist/", import.meta.url);
const FILES = ["index.html", "mobile.js", "mobile.css", "manifest.webmanifest", "icon-256.png", "icon-512.png", "sw.js"];

const row = (id: number, title: string) => ({
  id,
  title,
  original_url: `https://example.com/${id}`,
  domain: "example.com",
  site_name: "Example",
  feed_title: null,
  saved_at: "2026-11-01T00:00:00Z",
  read_status: "read",
  favorite: false,
});
const article = (id: number, title: string, text: string) => ({
  article: row(id, title),
  target_language: "ja",
  summary: null,
  blocks: [{ id: id * 10, ordinal: 0, kind: "code", text, attrs: {}, translation: null }],
});

/** Serves a function of (method, path, headers, body) over HTTP. */
async function serve(handler: (request: Request) => Promise<Response> | Response): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") {
          headers.set(k, v);
        }
      }
      const hasBody = req.method !== "GET" && req.method !== "HEAD" && chunks.length > 0;
      const response = await handler(
        new Request(`http://localhost${req.url}`, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined }),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A bucket holding what the PC publishes. */
function snapshotBucket(generatedAt: number, liveOrigin: string | null) {
  const store = new Map<string, Uint8Array | string>([
    ["auth.json", JSON.stringify({ token_hash: createHash("sha256").update(TOKEN).digest("hex"), live_origin: liveOrigin })],
    [
      "index.json",
      gzipSync(
        JSON.stringify({
          generated_at: generatedAt,
          ui_language: "ja",
          applied_ops: [],
          read_only: false,
          live_url: liveOrigin,
          articles: [row(1, "Snapshot one"), row(2, "Snapshot two")],
        }),
      ),
    ],
    ["articles/1.json", gzipSync(JSON.stringify(article(1, "Snapshot one", "the snapshot's text")))],
    ["articles/2.json", gzipSync(JSON.stringify(article(2, "Snapshot two", "the second text")))],
  ]);
  for (const file of FILES) {
    const bytes = readFileSync(new URL(file, DIST));
    store.set(`page/${file}`, file.endsWith(".png") ? bytes : gzipSync(bytes));
  }
  return {
    store,
    get: (key: string) => {
      const value = store.get(key);
      return Promise.resolve(value == null ? null : { body: value, json: () => Promise.resolve(JSON.parse(value as string) as unknown) });
    },
    put: (key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    },
  };
}

type Bucket = ReturnType<typeof snapshotBucket>;
type Handle = (request: Request, bucket: Bucket, now: number) => Promise<Response>;
/** The Worker keeps `auth.json` for a minute per instance; each request here is later than that, as tests use different buckets. */
let clock = 0;

/** The PC's server as the page sees it across origins. */
function livePc(workerOrigin: () => string, ops: unknown[]) {
  return async (request: Request) => {
    const cors = { "access-control-allow-origin": workerOrigin(), "access-control-allow-headers": "authorization, content-type", vary: "origin" };
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
      return Response.json({ error: "unauthorized" }, { status: 401, headers: cors });
    }
    const { pathname } = new URL(request.url);
    if (pathname === "/api/ping") {
      return Response.json({}, { headers: cors });
    }
    if (pathname === "/api/index") {
      return Response.json(
        { generated_at: Math.floor(Date.now() / 1000), ui_language: "ja", applied_ops: [], read_only: false, live_url: null, articles: [row(1, "Live one")] },
        { headers: cors },
      );
    }
    if (pathname === "/api/articles/1") {
      return Response.json(article(1, "Live one", "the live text"), { headers: cors });
    }
    if (pathname === "/api/ops") {
      ops.push(await request.json());
      return Response.json({ status: "applied" }, { headers: cors });
    }
    return Response.json({ error: "not found" }, { status: 404, headers: cors });
  };
}

async function workerServer(bucket: Bucket) {
  return serve((request) => (handle as Handle)(request, bucket, (clock += 120_000)));
}

/** Waits until the service worker controls the page, so the next load can come from it. */
async function underServiceWorker(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
    }
  });
}

test.use({ viewport: { width: 390, height: 844 }, locale: "ja-JP" });

const showAll = async (page: Page) => {
  await page.getByRole("button", { name: "すべて" }).click();
};

async function context(browser: { newContext: (o: object) => Promise<BrowserContext> }) {
  return browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ja-JP" });
}

test("with the PC off the phone reads the snapshot, says how old it is, and leaves its operations in the inbox", async ({ browser }) => {
  const bucket = snapshotBucket(Math.floor(Date.now() / 1000) - 2 * 3600, null);
  const worker = await workerServer(bucket);
  const ctx = await context(browser);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") {
      errors.push(m.text());
    }
  });
  await page.goto(`${worker.origin}/#t=${TOKEN}`);
  await showAll(page);
  await expect(page.getByRole("link", { name: /Snapshot one/ })).toBeVisible();
  await expect(page.getByText("2 時間前の内容")).toBeVisible();
  await page.getByRole("link", { name: /Snapshot one/ }).click();
  await expect(page.getByText("the snapshot's text")).toBeVisible();
  await page.getByRole("button", { name: "お気に入りに追加" }).click();
  await page.getByRole("button", { name: "お気に入りから外す" }).waitFor();
  await expect.poll(() => [...bucket.store.keys()].filter((k) => k.startsWith("inbox/")).length).toBe(1);
  await page.getByRole("link", { name: "一覧" }).click();
  await page.reload();
  await expect(page.getByText("未送信")).toHaveCount(0);
  await showAll(page);
  await expect(page.getByRole("link", { name: /Snapshot one/ }), "the operation still shows: no list has reflected it").toContainText("★");
  expect(errors).toEqual([]);
  await ctx.close();
  await worker.close();
});

test("without a connection the phone still opens, with the list and the articles it has read", async ({ browser }) => {
  const worker = await workerServer(snapshotBucket(Math.floor(Date.now() / 1000), null));
  const ctx = await context(browser);
  const page = await ctx.newPage();
  await page.goto(`${worker.origin}/#t=${TOKEN}`);
  await underServiceWorker(page);
  await showAll(page);
  await page.getByRole("link", { name: /Snapshot one/ }).click();
  await expect(page.getByText("the snapshot's text")).toBeVisible();
  await page.getByRole("link", { name: "一覧" }).click();
  await page.reload();
  await page.getByText("更新").waitFor();

  await ctx.setOffline(true);
  await page.reload();
  await expect(page.getByRole("alert")).toHaveText("接続できないので、保存した内容を表示しています");
  await showAll(page);
  await expect(page.getByRole("link", { name: /Snapshot two/ }), "the list is the one saved").toBeVisible();
  await page.getByRole("link", { name: /Snapshot one/ }).click();
  await expect(page.getByText("the snapshot's text"), "an article read before").toBeVisible();
  await expect(page.getByRole("alert"), "and it says this is a saved copy").toHaveText("接続できないので、保存した内容を表示しています");
  await page.getByRole("button", { name: "お気に入りに追加" }).click();
  await page.getByRole("link", { name: "一覧" }).click();
  await expect(page.getByText("未送信1件")).toBeVisible();
  await page.getByRole("link", { name: /Snapshot two/ }).click();
  await expect(page.getByText("読み込めませんでした。"), "an article never read").toBeVisible();

  await ctx.setOffline(false);
  await page.getByRole("button", { name: "もう一度" }).click();
  await expect(page.getByText("the second text")).toBeVisible();
  await ctx.close();
  await worker.close();
});

test("the phone reads from the PC when it can reach it, and from the snapshot when it cannot", async ({ browser }) => {
  const ops: unknown[] = [];
  let workerOrigin = "";
  const live = await serve(livePc(() => workerOrigin, ops));
  const bucket = snapshotBucket(Math.floor(Date.now() / 1000) - 3600, live.origin);
  const worker = await workerServer(bucket);
  workerOrigin = worker.origin;
  const ctx = await context(browser);
  const page = await ctx.newPage();
  const violations: string[] = [];
  page.on("console", (m) => {
    if (m.text().includes("Content Security Policy")) {
      violations.push(m.text());
    }
  });

  await page.goto(`${worker.origin}/#t=${TOKEN}`);
  await showAll(page);
  await expect(page.getByRole("link", { name: /Live one/ }), "it learns the PC's address from the snapshot and goes there").toBeVisible();
  await expect(page.getByText("時間前の内容")).toHaveCount(0);
  await page.getByRole("link", { name: /Live one/ }).click();
  await expect(page.getByText("the live text")).toBeVisible();
  await page.getByRole("button", { name: "お気に入りに追加" }).click();
  await expect.poll(() => ops.length, "with the PC there, the operation goes straight to it").toBe(1);
  expect([...bucket.store.keys()].filter((k) => k.startsWith("inbox/"))).toEqual([]);
  await page.getByRole("link", { name: "一覧" }).click();

  await live.close();
  await page.getByRole("button", { name: "更新" }).click();
  await expect(page.getByText("1 時間前の内容")).toBeVisible();
  await expect(page.getByRole("link", { name: /Snapshot two/ })).toBeVisible();
  await page.getByRole("link", { name: /Snapshot two/ }).click();
  await expect(page.getByText("the second text")).toBeVisible();
  await page.getByRole("button", { name: "お気に入りに追加" }).click();
  await expect.poll(() => [...bucket.store.keys()].filter((k) => k.startsWith("inbox/")).length, "without it, to the inbox").toBe(1);
  expect(ops.length).toBe(1);
  expect(violations).toEqual([]);
  await ctx.close();
  await worker.close();
});

test("an error page in place of the list or the page itself does not hide the saved copy", async ({ browser }) => {
  const bucket = snapshotBucket(Math.floor(Date.now() / 1000), null);
  let down = false;
  const worker = await serve((request) =>
    down
      ? new Response("<h1>530 origin is off</h1>", { status: 530, headers: { "content-type": "text/html" } })
      : (handle as Handle)(request, bucket, (clock += 120_000)),
  );
  const ctx = await context(browser);
  const page = await ctx.newPage();
  await page.goto(`${worker.origin}/#t=${TOKEN}`);
  await underServiceWorker(page);
  await showAll(page);
  await page.getByRole("link", { name: /Snapshot one/ }).click();
  await expect(page.getByText("the snapshot's text")).toBeVisible();
  await page.getByRole("link", { name: "一覧" }).click();
  await page.reload();
  await page.getByText("更新").waitFor();
  down = true;
  await page.reload();
  await expect(page.getByRole("alert")).toHaveText("接続できないので、保存した内容を表示しています");
  await showAll(page);
  await page.getByRole("link", { name: /Snapshot one/ }).click();
  await expect(page.getByText("the snapshot's text")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText("接続できないので、保存した内容を表示しています");
  await ctx.close();
  await worker.close();
});

test("another library's QR code leaves nothing of the first on the phone", async ({ browser }) => {
  const worker = await workerServer(snapshotBucket(Math.floor(Date.now() / 1000), null));
  const ctx = await context(browser);
  const page = await ctx.newPage();
  await page.goto(`${worker.origin}/#t=${TOKEN}&l=first`);
  await showAll(page);
  await page.getByRole("link", { name: /Snapshot one/ }).click();
  await expect(page.getByText("the snapshot's text")).toBeVisible();
  await page.getByRole("link", { name: "一覧" }).click();
  await page.evaluate(() => (location.hash = "#t=secret&l=second"));
  await expect
    .poll(() => page.evaluate(async () => (await caches.has("lattice-docs")) && (await (await caches.open("lattice-docs")).match("api/articles/1")) != null))
    .toBe(false);
  await ctx.close();
  await worker.close();
});

test("disconnecting this phone leaves nothing of the library on it", async ({ browser }) => {
  const worker = await workerServer(snapshotBucket(Math.floor(Date.now() / 1000), null));
  const ctx = await context(browser);
  const page = await ctx.newPage();
  await page.goto(`${worker.origin}/#t=${TOKEN}`);
  await showAll(page);
  await page.getByRole("link", { name: /Snapshot one/ }).click();
  await expect(page.getByText("the snapshot's text")).toBeVisible();
  await page.getByRole("link", { name: "一覧" }).click();
  page.on("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "このスマホの接続を解除" }).click();
  await expect(page.getByText("QRコードを読み取ってください")).toBeVisible();
  const left = await page.evaluate(async () => {
    const docs = await caches.open("lattice-docs");
    return { keys: (await docs.keys()).length, token: localStorage.getItem("lattice.mobile.token"), ops: localStorage.getItem("lattice.mobile.ops") };
  });
  expect(left).toEqual({ keys: 0, token: null, ops: null });
  await ctx.close();
  await worker.close();
});
