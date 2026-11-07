// The phone page's side of the API (design-review §32) and what it remembers on the device.
import type { ArticleDoc, ArticleRow, MobileIndex, MobileOp, MobileOpKind } from "../bindings";
import type { LanguageMode } from "../reader/mixed.ts";

const TOKEN = "lattice.mobile.token";
const LANGUAGE = "lattice.mobile.language";
const OPS = "lattice.mobile.ops";
/** A PC that went to sleep never answers; a long list on a slow connection still gets through. */
const TIMEOUT_MS = 30_000;
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

/** The `t=` of an address fragment such as `#t=abc`. */
export function tokenInFragment(fragment: string): string | null {
  return new URLSearchParams(fragment.replace(/^#/, "")).get("t") || null;
}

/** Takes the token from the address the QR code opened and removes it, so it stays out of history and screenshots. True if there was one. */
export function adoptToken(): boolean {
  const token = tokenInFragment(location.hash);
  if (token) {
    write(TOKEN, token);
    history.replaceState(null, "", location.pathname + location.search);
  }
  return token != null;
}

export const hasToken = () => read(TOKEN) != null;

/** The server turned the token down. It stays stored: this may be another server on the port, or a tunnel's own login. A new QR code replaces it. */
export class Unauthorized extends Error {}

const authorization = () => ({ Authorization: `Bearer ${read(TOKEN) ?? ""}` });

async function request(path: string): Promise<Response> {
  const response = await fetch(path, { headers: authorization(), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (response.status === 401) {
    throw new Unauthorized();
  }
  return response;
}

export async function loadIndex(): Promise<MobileIndex> {
  const response = await request("api/index");
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const index = (await response.json()) as MobileIndex;
  updateOps((local) => settled(local, index.applied_ops, Date.now()));
  return index;
}

/** Null when the article is gone. */
export async function loadArticle(id: number): Promise<ArticleDoc | null> {
  const response = await request(`api/articles/${id}`);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return (await response.json()) as ArticleDoc;
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

async function sendOp(op: MobileOp): Promise<SendResult> {
  try {
    const response = await fetch("api/ops", {
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
