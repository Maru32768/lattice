// UI text in the display language (G51). `ja.ts` is the source of the keys; `en.ts` must have
// exactly the same keys (`satisfies Messages`). Messages from the backend arrive as codes
// (`{"code":…,"params":{…}}`, see lattice-core's msg.rs) and are translated by `t.msg`.
import { Fragment, createElement, useSyncExternalStore, type ReactNode } from "react";
import { ja } from "./ja.ts";
import { en } from "./en.ts";

export type Lang = "ja" | "en";
export const LANGS: readonly Lang[] = ["ja", "en"];
/** Each language's name in itself, as the language menu shows it. */
export const LANGUAGE_NAMES: Record<Lang, string> = { ja: "日本語", en: "English" };
export type Key = keyof typeof ja;

type Names<S> = S extends `${string}{${infer P}}${infer R}` ? P | Names<R> : never;
type Value = string | number;
export type Params<K extends Key> = { [P in Names<(typeof ja)[K]>]: Value };
/** A key without params: what a table of labels holds. */
export type PlainKey = { [K in Key]: [Names<(typeof ja)[K]>] extends [never] ? K : never }[Key];
type Args<K extends Key> = [Names<(typeof ja)[K]>] extends [never] ? [] : [Params<K>];
/** A catalog: every key of `ja`, as a `{name}` template or a function of the params (English plurals). */
export type Messages = { [K in Key]: string | ((p: Params<K>) => string) };

const CATALOGS: Record<Lang, Messages> = { ja, en };
const STORAGE = "lattice.lang";

export const isLang = (v: unknown): v is Lang => v === "ja" || v === "en";

/** The cached choice (first paint, before the backend answers), else the WebView's language. */
function initial(): Lang {
  try {
    const v = localStorage.getItem(STORAGE);
    if (isLang(v)) {
      return v;
    }
  } catch {
    // no storage: fall through to the WebView's language
  }
  return typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("ja") ? "ja" : "en";
}

let current: Lang = initial();
const listeners = new Set<() => void>();
if (typeof document !== "undefined") {
  document.documentElement.lang = current;
}

export const displayLang = () => current;

function apply(lang: Lang) {
  if (lang === current) {
    return;
  }
  current = lang;
  if (typeof document !== "undefined") {
    document.documentElement.lang = lang;
  }
  for (const l of listeners) {
    l();
  }
}

/** Switches the UI live; the caller persists the choice in the backend (`api.setUiLanguage`). */
export function setDisplayLang(lang: Lang) {
  try {
    localStorage.setItem(STORAGE, lang);
  } catch {
    // the backend setting still applies from the next start
  }
  apply(lang);
}

// Another window (a pop-out, G52) switched the language: follow it.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE && isLang(e.newValue)) {
      apply(e.newValue);
    }
  });
}

/** BCP 47 tag for `Intl`. */
export const locale = (lang: Lang = current) => (lang === "ja" ? "ja-JP" : "en-US");

const numbers = { ja: new Intl.NumberFormat("ja-JP"), en: new Intl.NumberFormat("en-US") };

function format(lang: Lang, key: Key, params?: Record<string, Value>): string {
  const m = CATALOGS[lang][key] as string | ((p: Record<string, Value>) => string);
  if (typeof m === "function") {
    return m(params ?? {});
  }
  return m.replace(/\{(\w+)\}/g, (all, name: string) => {
    const v = params?.[name];
    return v === undefined ? all : typeof v === "number" ? numbers[lang].format(v) : v;
  });
}

/** A coded backend message: `{"code":"backup.keepRange","params":{"max":30}}`. */
interface Coded {
  code: string;
  params?: Record<string, Value>;
}

function parseCoded(s: string): Coded | null {
  if (!s.startsWith('{"code":')) {
    return null;
  }
  try {
    const v = JSON.parse(s) as Coded;
    return typeof v.code === "string" ? v : null;
  } catch {
    return null;
  }
}

function backendText(lang: Lang, x: unknown): string {
  const s = typeof x === "string" ? x : x instanceof Error ? x.message : String(x);
  const coded = parseCoded(s);
  const key = coded && `be.${coded.code}`;
  // A code this UI does not know (or plain text: provider and network errors) is shown as is.
  if (!coded || !key || !(key in ja)) {
    return s;
  }
  const params = Object.fromEntries(Object.entries(coded.params ?? {}).map(([k, v]) => [k, typeof v === "string" ? backendText(lang, v) : v]));
  return format(lang, key as Key, params);
}

export interface T {
  <K extends Key>(key: K, ...args: Args<K>): string;
  /** Like `t`, with React nodes as params (a `<code>` or a link inside a sentence). */
  rich<K extends Key>(key: K, params: { [P in Names<(typeof ja)[K]>]: ReactNode }): ReactNode;
  /** A message from the backend (an error, a `last_error`, a warning) in the display language. */
  msg(x: unknown): string;
  lang: Lang;
}

function translator(lang: Lang): T {
  const t = (<K extends Key>(key: K, ...[p]: Args<K>) => format(lang, key, p)) as T;
  t.rich = (key, params) => {
    const nodes = params as Record<string, ReactNode>;
    const parts = format(lang, key)
      .split(/\{(\w+)\}/)
      .map((s, i) => (i % 2 ? nodes[s] : s));
    return createElement(Fragment, null, ...parts);
  };
  t.msg = (x) => backendText(lang, x);
  t.lang = lang;
  return t;
}

const TRANSLATORS: Record<Lang, T> = { ja: translator("ja"), en: translator("en") };

/**
 * The translator for the display language at the time of the call. Code that runs during render
 * should use `useT()` so it re-renders, and memos that build text depend on the `t` it returns.
 */
export const t = Object.defineProperties(<K extends Key>(key: K, ...args: Args<K>) => TRANSLATORS[current](key, ...args), {
  rich: { value: ((key, params) => TRANSLATORS[current].rich(key, params)) as T["rich"] },
  msg: { value: (x: unknown) => TRANSLATORS[current].msg(x) },
  lang: { get: () => current },
}) as T;

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** The display language's translator; a new function per language, so it works as a memo dependency. */
export function useT(): T {
  return TRANSLATORS[useSyncExternalStore(subscribe, displayLang)];
}

/** Translator for one language (tests, and text that must not follow the display language). */
export const translatorFor = (lang: Lang) => TRANSLATORS[lang];
