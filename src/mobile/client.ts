// The phone page's side of the API (design-review §32) and what it remembers on the device.
import type { ArticleDoc, ArticleRow, MobileIndex, MobileOp, MobileOpKind } from "../bindings";
import type { LanguageMode } from "../reader/mixed.ts";

/** The documents this page can read. `mobile::FORMAT`: a page and its documents can differ for a while, across an update. */
const FORMAT = 1;
const TOKEN = "lattice.mobile.token";
const LIBRARY = "lattice.mobile.library";
const LANGUAGE = "lattice.mobile.language";
const OPS = "lattice.mobile.ops";
const LIVE = "lattice.mobile.live";
const DOCS = "lattice-docs";
/** Articles kept for reading without a connection, newest first. */
const KEEP_DOCS = 200;
/** A PC that is off must not hold up the snapshot: this long, then the snapshot. */
const PROBE_MS = 2500;
/** An answer from the PC is good for this long. */
const LIVE_ANSWER_MS = 30_000;
/** A PC that went to sleep never answers; a long list on a slow connection still gets through. */
const TIMEOUT_MS = 30_000;
/** On a poor connection the saved copy shows after this. */
const SAVED_AFTER_MS = 3000;
/**
 * An operation no list has shown after this is given up on, sent or not. Well under the 90 days the PC
 * remembers what it applied (`KEEP_APPLIED_SECS`): sent any later, one could undo what changed since.
 */
const KEEP_OPS_MS = 60 * 24 * 60 * 60 * 1000;

/** Blocked storage (a private window) must not break the page: it asks for the QR code again instead. */
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Forgotten at the next start.
  }
}

function forget(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing was stored, then.
  }
}

/** Only in a secure context: the local network's plain HTTP page has no caches, and does without. */
const docs = () => (typeof caches !== "undefined" ? caches.open(DOCS) : null);
const dropDocs = () => (typeof caches !== "undefined" ? caches.delete(DOCS) : Promise.resolve(false));

/** The `t=` and `l=` (the library's id) of an address fragment such as `#t=abc&l=def`. */
export function fragmentOf(fragment: string): { token: string; library: string | null } | null {
  const params = new URLSearchParams(fragment.replace(/^#/, ""));
  const token = params.get("t");
  return token ? { token, library: params.get("l") } : null;
}

/** Takes the token from the address the QR code opened and removes it, so it stays out of history and screenshots. True if there was one. */
export function adoptToken(): boolean {
  const found = fragmentOf(location.hash);
  if (found) {
    write(TOKEN, found.token);
    // Article ids mean something else in another library, so nothing kept from one may reach the other. A new token of the same library keeps it all.
    if (found.library !== read(LIBRARY)) {
      updateOps(() => []);
      void dropDocs();
      forget(LIVE);
      live = null;
      liveAnswers = false;
      write(LIBRARY, found.library ?? "");
    }
    history.replaceState(null, "", location.pathname + location.search);
  }
  return found != null;
}

export const hasToken = () => read(TOKEN) != null;

/** The server turned the token down. It stays stored: this may be another server on the port, or a tunnel's own login. A new QR code replaces it. */
export class Unauthorized extends Error {}

/** A document of a format this page cannot read: one of the two is about to be replaced by the other's version. */
export class FormatMismatch extends Error {}

const authorization = () => ({ Authorization: `Bearer ${read(TOKEN) ?? ""}` });

/**
 * The PC's own address, as the list last said, and whether it answered the last time it was asked. A page
 * on the Worker then reads from the PC, which is up to date, and falls back on the snapshot whenever it does not answer.
 */
let live: string | null = read(LIVE);
let liveAnswers = false;
let liveAskedAt = 0;

async function askLive() {
  liveAskedAt = Date.now();
  liveAnswers =
    live != null &&
    new URL(live).origin !== location.origin &&
    (await fetch(`${live}/api/ping`, { headers: authorization(), signal: AbortSignal.timeout(PROBE_MS) }).then(
      (r) => r.ok,
      () => false,
    ));
}

/** As of now: a PC that has gone to sleep since would hold up a request for the whole timeout. */
async function liveNow(): Promise<boolean> {
  if (live != null && Date.now() - liveAskedAt > LIVE_ANSWER_MS) {
    await askLive();
  }
  return liveAnswers;
}

/** The API by way of the PC if it answers, then of wherever this page came from. */
async function request(path: string): Promise<Response> {
  if (await liveNow()) {
    try {
      const response = await fetch(`${live}/${path}`, { headers: authorization(), signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (response.status !== 401 && response.status < 500) {
        return response;
      }
    } catch {
      // Gone since it was last asked.
    }
    liveAnswers = false;
  }
  const response = await fetch(path, { headers: authorization(), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (response.status === 401) {
    throw new Unauthorized();
  }
  return response;
}

async function keep(path: string, doc: unknown) {
  const cache = await docs();
  if (cache) {
    await cache.put(path, Response.json(doc));
    const keys = await cache.keys();
    await Promise.all(keys.slice(0, Math.max(0, keys.length - KEEP_DOCS)).map((k) => cache.delete(k)));
  }
}

/** A document as it crosses the network: its `format` says whether this page can read the rest. */
type Doc = MobileIndex | ArticleDoc;

async function savedDoc(path: string): Promise<Doc | null> {
  try {
    const saved = await (await docs())?.match(path);
    const doc = saved ? ((await saved.json()) as Doc) : null;
    return doc?.format === FORMAT ? doc : null;
  } catch {
    return null;
  }
}

/**
 * A document from the network, kept for later. Null when the server says it is gone. An answer that is not a document of
 * ours, such as a tunnel's page with the PC off or a login page, throws: it must neither show nor replace the saved copy.
 */
async function fetched(path: string): Promise<Doc | null> {
  const response = await request(path);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const doc = (await response.json()) as Doc | null;
  if (typeof doc !== "object" || doc === null || typeof doc.format !== "number") {
    throw new Error("not a document");
  }
  if (doc.format !== FORMAT) {
    throw new FormatMismatch();
  }
  await keep(path, doc).catch(() => {});
  return doc;
}

/** What `document` found: `saved` says it is the copy on this phone, because the network failed or was too slow. */
interface Found {
  doc: Doc | null;
  saved: boolean;
}

async function document(path: string): Promise<Found> {
  const network = fetched(path).then((doc): Found => ({ doc, saved: false }));
  const saved = await savedDoc(path);
  if (!saved) {
    return network;
  }
  const fallback: Found = { doc: saved, saved: true };
  // The answer still arrives later, and replaces the copy for next time.
  const late = new Promise<Found>((resolve) => setTimeout(() => resolve(fallback), SAVED_AFTER_MS));
  const answered = network.then(
    (f) => f,
    (e: unknown) => {
      if (e instanceof Unauthorized || e instanceof FormatMismatch) {
        throw e;
      }
      return fallback;
    },
  );
  return Promise.race([answered, late]);
}

/** The list, and whether it is the saved copy. */
export async function loadIndex(): Promise<{ index: MobileIndex; saved: boolean }> {
  await askLive();
  let found = await document("api/index");
  if (found.doc == null) {
    throw new Error("no list yet");
  }
  // The snapshot says where the PC is. It may be there right now.
  const named = (found.doc as MobileIndex).live_url;
  if (!found.saved && !liveAnswers && named && named !== live) {
    live = named;
    write(LIVE, named);
    await askLive();
    if (liveAnswers) {
      const fromPc = await document("api/index").catch(() => null);
      found = fromPc?.doc ? fromPc : found;
    }
  }
  const index = found.doc as MobileIndex;
  updateOps((local) => settled(local, index.applied_ops, Date.now()));
  return { index, saved: found.saved };
}

/** Null when the article is gone, and whether it is the saved copy. */
export async function loadArticle(id: number): Promise<{ doc: ArticleDoc | null; saved: boolean }> {
  const { doc, saved } = await document(`api/articles/${id}`);
  return { doc: doc as ArticleDoc | null, saved };
}

/** Leaves nothing of the library on this phone. Other tabs follow through `storage`. */
export async function disconnect() {
  try {
    localStorage.clear();
  } catch {
    // Nothing was stored, then.
  }
  ops = [];
  live = null;
  liveAnswers = false;
  listeners.forEach((l) => l());
  await dropDocs();
}

// ---- operations ---------------------------------------------------------------------------------

/** An operation done on this phone, until a list shows it. `sent`: the server has it. `at` is this phone's clock. */
export interface LocalOp extends MobileOp {
  at: number;
  sent: boolean;
}

function parseOps(text: string | null): LocalOp[] {
  try {
    const v = JSON.parse(text ?? "[]") as unknown;
    return Array.isArray(v) ? (v as LocalOp[]) : [];
  } catch {
    return [];
  }
}

let ops = parseOps(read(OPS));
const listeners = new Set<() => void>();

/** Starts from what storage holds, not from this tab's copy: another tab may have added to it. */
function updateOps(change: (local: LocalOp[]) => LocalOp[]) {
  const stored = read(OPS);
  ops = change(stored == null ? ops : parseOps(stored));
  write(OPS, JSON.stringify(ops));
  listeners.forEach((l) => l());
}

function otherTabChanged(e: StorageEvent) {
  if (e.key === OPS || e.key === null) {
    ops = parseOps(e.newValue);
    listeners.forEach((l) => l());
  }
}

export const subscribeOps = (changed: () => void) => {
  if (listeners.size === 0) {
    addEventListener("storage", otherTabChanged);
  }
  listeners.add(changed);
  return () => {
    listeners.delete(changed);
    if (listeners.size === 0) {
      removeEventListener("storage", otherTabChanged);
    }
  };
};
export const localOps = () => ops;

/** Not crypto.randomUUID, which needs a secure context: the local network's page has plain HTTP. */
export function newOpId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** What a list that reflects `applied` leaves of the local operations. */
export function settled(local: LocalOp[], applied: string[], now: number): LocalOp[] {
  const done = new Set(applied);
  return local.filter((op) => !done.has(op.id) && now - op.at <= KEEP_OPS_MS);
}

/** A row as the operations not yet shown by a list will leave it. */
export function withOps(row: ArticleRow, local: LocalOp[]): ArticleRow {
  return local.reduce((r, { op }) => {
    if (op.kind === "set_read" && op.article_id === r.id) {
      return { ...r, read_status: op.read ? "read" : "unread" };
    }
    if (op.kind === "set_favorite" && op.article_id === r.id) {
      return { ...r, favorite: op.favorite };
    }
    return r;
  }, row);
}

export type SendResult = { status: "done" } | { status: "wait" } | { status: "rejected"; error: string };

/** A message in the catalog's form (`msg!`): only Lattice itself answers with one. */
function isCoded(error: unknown): error is string {
  if (typeof error !== "string") {
    return false;
  }
  try {
    return typeof (JSON.parse(error) as { code?: unknown }).code === "string";
  } catch {
    return false;
  }
}

/**
 * What an answer to an operation means. Only Lattice's own word settles it: a captive portal's 200 page
 * took nothing, and a proxy's 403 refuses nothing. A read-only server may yet be restarted with writes on, so that waits too.
 */
export function resultOf(status: number, body: unknown): SendResult {
  const { status: said, error } = (body ?? {}) as { status?: unknown; error?: unknown };
  if (status >= 200 && status < 300 && (said === "applied" || said === "queued")) {
    return { status: "done" };
  }
  return (status === 400 || status === 422) && isCoded(error) ? { status: "rejected", error } : { status: "wait" };
}

async function sendTo(base: string, op: MobileOp): Promise<SendResult> {
  try {
    const response = await fetch(`${base}api/ops`, {
      method: "POST",
      headers: { ...authorization(), "Content-Type": "application/json" },
      body: JSON.stringify({ id: op.id, op: op.op }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return resultOf(response.status, await response.json().catch(() => null));
  } catch {
    return { status: "wait" };
  }
}

/** To the PC if it answers, else to wherever this page came from. Both ways are safe together: the operation's id applies it once. */
async function sendOp(op: MobileOp): Promise<SendResult> {
  if (await liveNow()) {
    const result = await sendTo(`${live}/`, op);
    if (result.status !== "wait") {
      return result;
    }
    liveAnswers = false;
  }
  return sendTo("", op);
}

let flushing: Promise<void> | null = null;
/** An operation turned down for good, and why, for the page to say. */
let onRejected: (op: MobileOp, error: string) => void = () => {};
export const whenRejected = (f: typeof onRejected) => {
  onRejected = f;
};

/** Sends what has not been sent, in order, stopping at the first that cannot get through for now. */
export function flushOps(): Promise<void> {
  flushing ??= (async () => {
    updateOps((local) => local);
    for (let next = ops.find((o) => !o.sent); next; next = ops.find((o) => !o.sent)) {
      const sending = next;
      const result = await sendOp(sending);
      if (result.status === "wait") {
        break;
      }
      if (result.status === "rejected") {
        updateOps((local) => local.filter((o) => o.id !== sending.id));
        onRejected(sending, result.error);
      } else {
        updateOps((local) => local.map((o) => (o.id === sending.id ? { ...o, sent: true } : o)));
      }
    }
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

/** Records the operation on this phone first, so it survives a closed page or a sleeping PC, then tries to send it. */
export function submit(op: MobileOpKind) {
  updateOps((local) => [...local, { id: newOpId(), op, at: Date.now(), sent: false }]);
  void flushOps();
}

/** For what can never get through, such as an operation a proxy always refuses. */
export function discardUnsent() {
  updateOps((local) => local.filter((o) => o.sent));
}

// ---- language -----------------------------------------------------------------------------------

export interface LanguageChoice {
  mode: LanguageMode;
  percent: number;
}

/** Per device, like the Reader's choice on the PC. */
export function savedLanguage(): LanguageChoice {
  try {
    const v = JSON.parse(read(LANGUAGE) ?? "null") as Partial<LanguageChoice> | null;
    if (v && (v.mode === "original" || v.mode === "mixed" || v.mode === "translated") && typeof v.percent === "number") {
      return { mode: v.mode, percent: v.percent };
    }
  } catch {
    // A value this version cannot read: back to the default.
  }
  return { mode: "translated", percent: 50 };
}

export const saveLanguage = (choice: LanguageChoice) => write(LANGUAGE, JSON.stringify(choice));
