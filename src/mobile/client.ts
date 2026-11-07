// The phone page's side of the API (design-review §32) and what it remembers on the device.
import type { ArticleDoc, MobileIndex } from "../bindings";
import type { LanguageMode } from "../reader/mixed.ts";

const TOKEN = "lattice.mobile.token";
const LANGUAGE = "lattice.mobile.language";

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

async function request(path: string): Promise<Response> {
  const response = await fetch(path, { headers: { Authorization: `Bearer ${read(TOKEN) ?? ""}` } });
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
  return (await response.json()) as MobileIndex;
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
