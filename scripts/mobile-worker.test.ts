import assert from "node:assert/strict";
import { gunzipSync, gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { test } from "node:test";
// @ts-expect-error -- plain JavaScript: Terraform uploads this very file.
import { handle } from "../infra/mobile/worker.js";

const TOKEN = "the-token";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

/** Each test runs later than the last, so the Worker's cached `auth.json` has expired. */
let clock = 1_000_000;

/** Runs after each put: what the PC does meanwhile. */
let afterPut: (() => void) | null = null;

function bucket(objects: Record<string, Uint8Array | string> = {}) {
  const store = new Map<string, Uint8Array | string>(Object.entries({ "auth.json": JSON.stringify({ token_hash: hash(TOKEN) }), ...objects }));
  return {
    store,
    get: (key: string) => {
      const v = store.get(key);
      return Promise.resolve(v == null ? null : { body: v, json: () => Promise.resolve(JSON.parse(v as string) as unknown) });
    },
    put: (key: string, v: string) => {
      store.set(key, v);
      afterPut?.();
      return Promise.resolve();
    },
    delete: (key: string) => {
      store.delete(key);
      return Promise.resolve();
    },
  };
}

type Handle = (request: Request, into: ReturnType<typeof bucket>, now?: number) => Promise<Response>;
const call = (b: ReturnType<typeof bucket>, path: string, init: RequestInit & { token?: string | null } = {}) => {
  const { token = TOKEN, ...rest } = init;
  clock += 120_000;
  const headers = new Headers(rest.headers);
  if (token != null) {
    headers.set("authorization", `Bearer ${token}`);
  }
  return (handle as Handle)(new Request(`https://m.example${path}`, { ...rest, headers }), b, clock);
};
const op = (id: unknown) => JSON.stringify({ id, op: { kind: "set_read", article_id: 1, read: true } });

test("the API needs the token, and the page does not", async () => {
  const b = bucket({ "index.json": gzipSync("{}"), "page/index.html": gzipSync("<html>") });
  for (const token of [null, "wrong", ""]) {
    assert.equal((await call(b, "/api/index", { token })).status, 401, String(token));
  }
  assert.equal((await call(b, "/api/index")).status, 200);
  const page = await call(b, "/", { token: null });
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy")!, /default-src 'self'/);
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
});

test("before the PC has published, nothing is accepted", async () => {
  const b = bucket();
  b.store.delete("auth.json");
  assert.equal((await call(b, "/api/index")).status, 401);
  assert.equal((await call(b, "/api/index", { token: "" })).status, 401);
});

test("a new token from the PC takes over within a minute, without a deployment", async () => {
  const b = bucket();
  b.store.set("index.json", gzipSync("{}"));
  assert.equal((await call(b, "/api/index")).status, 200);
  b.store.set("auth.json", JSON.stringify({ token_hash: hash("new") }));
  assert.equal((await call(b, "/api/index")).status, 401);
  assert.equal((await call(b, "/api/index", { token: "new" })).status, 200);
});

test("documents come as the PC stored them, marked as compressed", async () => {
  const b = bucket({ "index.json": gzipSync('{"articles":[]}'), "articles/12.json": gzipSync('{"id":12}') });
  const index = await call(b, "/api/index");
  assert.equal(index.headers.get("content-encoding"), "gzip");
  assert.equal(index.headers.get("cache-control"), "no-store");
  assert.equal(gunzipSync(Buffer.from(await index.arrayBuffer())).toString(), '{"articles":[]}');
  assert.equal((await call(b, "/api/articles/12")).status, 200);
  assert.equal((await call(b, "/api/articles/13")).status, 404);
  for (const path of ["/api/articles/12.json", "/api/articles/..%2Fauth", "/api/articles/1/2", "/api/auth", "/api/inbox"]) {
    assert.equal((await call(b, path)).status, 404, path);
  }
});

test("an operation goes to the inbox, named so that the order of arrival is kept", async () => {
  const b = bucket();
  const response = await call(b, "/api/ops", { method: "POST", body: op("abc-1") });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { status: "queued" });
  await call(b, "/api/ops", { method: "POST", body: op("abc-0") });
  const keys = [...b.store.keys()].filter((k) => k.startsWith("inbox/"));
  assert.equal(keys.length, 2);
  assert.match(keys[0], /^inbox\/\d{15}-abc-1\.json$/);
  assert.deepEqual([...keys].sort(), keys, "listing order is arrival order");
  assert.equal(b.store.get(keys[0]), op("abc-1"));
});

test("what is not an operation stays out of the bucket", async () => {
  const b = bucket();
  const cases: [string, number][] = [
    ["not json", 400],
    [op("../auth"), 400],
    [op("a/b"), 400],
    [op(""), 400],
    [op(1), 400],
    [op("x".repeat(65)), 400],
    [JSON.stringify({ id: "a", pad: "x".repeat(17 * 1024) }), 413],
    [JSON.stringify({ id: "a", pad: "あ".repeat(6 * 1024) }), 413],
  ];
  for (const [body, status] of cases) {
    assert.equal((await call(b, "/api/ops", { method: "POST", body })).status, status, body.slice(0, 30));
  }
  assert.deepEqual(
    [...b.store.keys()].filter((k) => k.startsWith("inbox/")),
    [],
  );
  assert.equal((await call(b, "/api/ops", { method: "POST", body: op("a"), token: null })).status, 401);
});

test("only the page's files are served: never the token's hash, the inbox or the documents", async () => {
  const b = bucket({ "page/mobile.js": gzipSync("x"), "page/icon-256.png": "png", "inbox/1-a.json": "secret", "articles/1.json": gzipSync("{}") });
  assert.equal((await call(b, "/mobile.js", { token: null })).headers.get("content-encoding"), "gzip");
  const icon = await call(b, "/icon-256.png", { token: null });
  assert.equal(icon.headers.get("content-encoding"), null);
  assert.equal(icon.headers.get("content-type"), "image/png");
  for (const path of ["/auth.json", "/inbox/1-a.json", "/articles/1.json", "/page/mobile.js", "/..%2Fauth.json", "/.hidden", "/nothing.js"]) {
    assert.equal((await call(b, path, { token: null })).status, 404, path);
  }
  assert.equal((await call(b, "/", { token: null, method: "POST", body: "x" })).status, 405);
});

test("the page may connect to the PC's address, when there is one, and to nothing else", async () => {
  const b = bucket({ "page/index.html": gzipSync("<html>") });
  const csp = async () => (await call(b, "/", { token: null })).headers.get("content-security-policy")!;
  assert.doesNotMatch(await csp(), /connect-src/);
  b.store.set("auth.json", JSON.stringify({ token_hash: hash(TOKEN), live_origin: "https://pc.example.ts.net" }));
  assert.match(await csp(), /connect-src 'self' https:\/\/pc\.example\.ts\.net;/);
  assert.match(await csp(), /default-src 'self'/);
});

test("once the PC takes the token out, no operation enters the inbox, whatever the cache says", async () => {
  const b = bucket({ "index.json": gzipSync("{}") });
  assert.equal((await call(b, "/api/index")).status, 200);
  b.store.set("auth.json", JSON.stringify({ token_hash: null }));
  const now = clock;
  const sameMinute = (path: string, init: RequestInit) =>
    (handle as Handle)(new Request(`https://m.example${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}` } }), b, now + 1);
  assert.equal((await sameMinute("/api/ops", { method: "POST", body: op("late") })).status, 401);
  assert.deepEqual(
    [...b.store.keys()].filter((k) => k.startsWith("inbox/")),
    [],
  );
});

test("an operation that lands as the PC takes the token out is not left in an inbox no one reads", async () => {
  const b = bucket();
  afterPut = () => b.store.set("auth.json", JSON.stringify({ token_hash: null }));
  const response = await call(b, "/api/ops", { method: "POST", body: op("racing") });
  afterPut = null;
  assert.equal(response.status, 401, "the phone keeps it and sends it elsewhere");
  assert.deepEqual(
    [...b.store.keys()].filter((k) => k.startsWith("inbox/")),
    [],
  );
});
