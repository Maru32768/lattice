// The phone's way to the snapshot while the PC is off (design-review §32). It gives the page and the
// documents the PC has published to anyone with the token, and takes operations into the inbox for the
// PC to apply. It holds the only binding to this bucket and can reach nothing else.

const CSP = "default-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const OP_ID = /^[0-9A-Za-z-]{1,64}$/;
const MAX_OP_BYTES = 16 * 1024;
const AUTH_TTL_MS = 60_000;
/** The page drops an operation only on a message in Lattice's coded form. */
const BAD_OP = JSON.stringify({ code: "mobile.badOp", params: {} });
const TYPES = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  webmanifest: "application/manifest+json",
  png: "image/png",
};

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** The PC keeps `auth.json` current, so a new token needs no deployment. Read at most once a minute per instance. */
let auth = { hash: null, live: null, at: -Infinity };

async function currentAuth(bucket, now, fresh = false) {
  if (fresh || now - auth.at >= AUTH_TTL_MS) {
    const object = await bucket.get("auth.json");
    const doc = object ? await object.json() : {};
    auth = { hash: doc.token_hash ?? null, live: doc.live_origin ?? null, at: now };
  }
  return auth;
}

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `fresh` for an operation: once the PC has taken the token out, nothing more may enter the inbox it is about to empty for good. */
async function authorized(request, bucket, now, fresh = false) {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) {
    return false;
  }
  const { hash } = await currentAuth(bucket, now, fresh);
  return hash != null && (await sha256(header.slice("Bearer ".length))) === hash;
}

/** Stored compressed: passed on as it is. */
function compressed(object, headers) {
  return new Response(object.body, { headers: { ...headers, "content-encoding": "gzip" }, encodeBody: "manual" });
}

async function document(bucket, key) {
  const object = await bucket.get(key);
  return object ? compressed(object, { "content-type": "application/json", "cache-control": "no-store" }) : json(404, { error: "not found" });
}

async function takeOp(request, bucket, now) {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_OP_BYTES) {
    return json(413, { error: "too large" });
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_OP_BYTES) {
    return json(413, { error: "too large" });
  }
  let id;
  try {
    id = JSON.parse(text).id;
  } catch {
    return json(400, { error: BAD_OP });
  }
  if (typeof id !== "string" || !OP_ID.test(id)) {
    return json(400, { error: BAD_OP });
  }
  // Named by arrival, so the PC applies them in the order the phone sent them.
  const key = `inbox/${String(now).padStart(15, "0")}-${id}.json`;
  await bucket.put(key, text);
  // The PC may have taken the token out and emptied the inbox for good while this was on its way. Then the phone keeps the
  // operation and sends it elsewhere; its id applies it once even if this copy is read some day.
  if (!(await authorized(request, bucket, now, true))) {
    await bucket.delete(key);
    return json(401, { error: "unauthorized" });
  }
  return json(202, { status: "queued" });
}

/** The page reads from the PC when it can reach it, and from nowhere else. */
const cspWith = (live) => (live ? CSP.replace("default-src 'self';", `default-src 'self'; connect-src 'self' ${live};`) : CSP);

async function pageFile(bucket, path, now) {
  const name = path === "/" ? "index.html" : path.slice(1);
  if (!/^[0-9A-Za-z.-]+$/.test(name) || name.startsWith(".")) {
    return new Response("not found", { status: 404 });
  }
  const object = await bucket.get(`page/${name}`);
  if (!object) {
    return new Response("not found", { status: 404 });
  }
  const type = TYPES[name.split(".").pop()] ?? "application/octet-stream";
  const headers = {
    "content-type": type,
    "cache-control": "no-cache",
    "content-security-policy": cspWith((await currentAuth(bucket, now)).live),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
  return name.endsWith(".png") ? new Response(object.body, { headers }) : compressed(object, headers);
}

export async function handle(request, bucket, now = Date.now()) {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith("/api/")) {
    if (!(await authorized(request, bucket, now, request.method === "POST"))) {
      return json(401, { error: "unauthorized" });
    }
    if (request.method === "GET" && pathname === "/api/index") {
      return document(bucket, "index.json");
    }
    const article = /^\/api\/articles\/(\d+)$/.exec(pathname);
    if (request.method === "GET" && article) {
      return document(bucket, `articles/${article[1]}.json`);
    }
    if (request.method === "POST" && pathname === "/api/ops") {
      return takeOp(request, bucket, now);
    }
    return json(404, { error: "not found" });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", { status: 405 });
  }
  return pageFile(bucket, pathname, now);
}

export default { fetch: (request, env) => handle(request, env.BUCKET) };
