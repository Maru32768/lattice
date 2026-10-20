// The Page toolbar's URL bar: what a typed input opens, and the search engine for inputs that
// are not URLs (Settings › ブラウザ). The choice persists in the app's storage, like the shortcuts.

export type EngineId = "google" | "duckduckgo" | "bing" | "brave" | "kagi" | "custom";

export const ENGINES: { id: Exclude<EngineId, "custom">; label: string; search: string; home: string }[] = [
  { id: "duckduckgo", label: "DuckDuckGo", search: "https://duckduckgo.com/?q=%s", home: "https://duckduckgo.com/" },
  { id: "google", label: "Google", search: "https://www.google.com/search?q=%s", home: "https://www.google.com/" },
  { id: "bing", label: "Bing", search: "https://www.bing.com/search?q=%s", home: "https://www.bing.com/" },
  { id: "brave", label: "Brave Search", search: "https://search.brave.com/search?q=%s", home: "https://search.brave.com/" },
  { id: "kagi", label: "Kagi", search: "https://kagi.com/search?q=%s", home: "https://kagi.com/" },
];

export interface SearchEngine {
  id: EngineId;
  /** The custom engine's search URL, %s standing for the query. */
  custom: string;
}

export const DEFAULT_ENGINE: SearchEngine = { id: "duckduckgo", custom: "" };

/** The browser opens http(s) pages only (`browser.rs` `is_http`). */
function httpUrl(s: string): URL | null {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

const fill = (template: string, q: string) => template.replace(/%s/g, () => q);

export const validTemplate = (t: string) => t.includes("%s") && !!httpUrl(fill(t.trim(), "q"));

/** An unusable custom template searches with the default engine. */
function resolve(e: SearchEngine): { search: string; home: string } {
  if (e.id === "custom" && validTemplate(e.custom)) return { search: e.custom.trim(), home: `${httpUrl(fill(e.custom.trim(), ""))!.origin}/` };
  return ENGINES.find((x) => x.id === e.id) ?? ENGINES[0];
}

export const homeOf = (e: SearchEngine) => resolve(e).home;

// localhost, an IP, or dotted labels ending in a letter TLD; a port and a path may follow. No spaces.
const HOST_LIKE = /^(localhost|\[[0-9a-f:.]+\]|\d{1,3}(\.\d{1,3}){3}|([a-z0-9-]+\.)+(xn--[a-z0-9-]+|[a-z]{2,}))(:\d+)?([/?#]\S*)?$/i;

/** What the URL bar opens for `input`: an http(s) URL as typed, https:// + a host, otherwise a search. Null: nothing. */
export function toNavigation(input: string, e: SearchEngine): string | null {
  const s = input.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return httpUrl(s)?.href ?? null;
  if (HOST_LIKE.test(s)) return httpUrl(`https://${s}`)?.href ?? null;
  return fill(resolve(e).search, encodeURIComponent(s));
}

const STORAGE_KEY = "lattice.searchEngine";

function load(): SearchEngine {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<SearchEngine> | null;
    const known = v?.id === "custom" || ENGINES.some((x) => x.id === v?.id);
    if (v && known && typeof v.custom === "string") return { id: v.id!, custom: v.custom };
  } catch {
    // Blocked storage or a damaged value: the default engine.
  }
  return DEFAULT_ENGINE;
}

let current = load();
export const getEngine = () => current;

export function setEngine(e: SearchEngine) {
  current = e;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(e));
  } catch {
    // Blocked storage: the choice lasts for this session only.
  }
}
