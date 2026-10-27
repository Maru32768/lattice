/**
 * Pure overlay logic (no live page state): snippet preparation, line-break splitting,
 * sanitizing translated HTML, and deterministic display assignment.
 *
 * Adapted from Mazelingo's content-logic (MIT License, Copyright (c) 2026 Yeq6X).
 */
import type { PageKeys } from "../lib/keys.ts";
import { isAtom, isIgnored } from "./dom.ts";

const HTML_TAGS = /<[^>]*>/gu;
const UNIT_END = /[。．.!！?？…」』）)]$/u;
const BREAKS = /(?:\r\n|\n|<br\b[^>]*>)(?:[ \t]*(?:\r\n|\n|<br\b[^>]*>))*/giu;
const ONE_BREAK = /\r\n|\n|<br\b[^>]*>/giu;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const ALNUM = /[\p{L}\p{N}]/u;
const KANA = /[ぁ-ゖァ-ヺ]/u;

export const ALLOWED_TAGS = new Set(["a", "b", "i", "em", "strong", "span", "img", "br", "code", "s", "u", "mark", "sub", "sup", "kbd"]);

/** Split at blank lines always, and at single newlines/<br> after sentence-ending punctuation. */
export function splitByLineBreaks(html: string): { parts: string[]; separators: string[] } {
  const raw: string[] = [],
    rawSep: string[] = [];
  let last = 0;
  for (const m of html.matchAll(BREAKS)) {
    const count = (m[0].match(ONE_BREAK) ?? []).length;
    const prev = html.slice(last, m.index).replace(HTML_TAGS, "").trimEnd();
    if (count >= 2 || UNIT_END.test(prev)) {
      raw.push(html.slice(last, m.index));
      rawSep.push(m[0]);
      last = m.index + m[0].length;
    }
  }
  raw.push(html.slice(last));
  const parts: string[] = [],
    separators: string[] = [];
  let pending = "";
  raw.forEach((p, i) => {
    if (p.trim()) {
      if (parts.length > 0) {
        separators.push(pending);
      }
      parts.push(p);
      pending = "";
    }
    if (i < rawSep.length) {
      pending += rawSep[i];
    }
  });
  return { parts, separators };
}

export function isCjkDominant(text: string): boolean {
  let cjk = 0,
    alnum = 0;
  for (const c of text) {
    if (CJK.test(c)) {
      cjk++;
    }
    if (ALNUM.test(c)) {
      alnum++;
    }
  }
  return cjk > 0 && cjk * 2 >= alnum;
}

export type Target = "ja" | "en";

/** Japanese pages translate into English, all others into Japanese: the declared `lang` decides, else the text. */
export function pageTarget(lang: string, sample: string): Target {
  const l = lang.trim().toLowerCase();
  // Kana tell Japanese from Chinese (as segments::is_japanese).
  const japanese = l ? l === "ja" || l.startsWith("ja-") || l.startsWith("ja_") : isCjkDominant(sample) && KANA.test(sample);
  return japanese ? "en" : "ja";
}

/**
 * Text already in the target language has nothing to translate (as `Target::is_written_in`). Errs
 * toward translating: any kana or kanji keeps text from counting as English ("GitHub Actionsによる自動化"),
 * and only kana make it Japanese, so Chinese (kanji without kana) is translated.
 */
export const isWrittenIn = (text: string, target: Target) => (target === "ja" ? KANA.test(text) : ![...text].some((c) => CJK.test(c)));

const safeUrl = (v: string, allowData: boolean) => {
  const s = v.trim().replace(/[\p{C}\s]+/gu, "");
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(s)?.[1]?.toLowerCase();
  if (allowData && /^data:image\//iu.test(s)) {
    return true;
  }
  return scheme === undefined || scheme === "http" || scheme === "https";
};

/** LLM output is untrusted HTML: keep a few inline tags, only http(s) links, no handlers. */
export function sanitize(html: string, doc: Document = document): string {
  const tpl = doc.createElement("template");
  tpl.innerHTML = html;
  const walk = (parent: ParentNode) => {
    for (const el of Array.from(parent.children)) {
      walk(el);
      const name = el.tagName.toLowerCase();
      if (!ALLOWED_TAGS.has(name)) {
        el.replaceWith(...Array.from(el.childNodes));
        continue;
      }
      for (const a of Array.from(el.attributes)) {
        const n = a.name.toLowerCase();
        const keep =
          (name === "a" && n === "href" && safeUrl(a.value, false)) ||
          (name === "img" && n === "src" && safeUrl(a.value, true)) ||
          (name === "img" && n === "alt");
        if (!keep) {
          el.removeAttribute(a.name);
        }
      }
    }
  };
  walk(tpl.content);
  const div = doc.createElement("div");
  div.append(tpl.content);
  return div.innerHTML;
}

/**
 * Snippet HTML sent for translation: the block's inline markup with attributes stripped
 * (except a[href]) and atoms (images, icons) replaced by ⟦n⟧ in token order.
 */
export function snippetHtml(block: Element): string {
  const doc = block.ownerDocument;
  let atoms = 0;
  const clone = (n: Node): Node | null => {
    if (n instanceof Text) {
      return doc.createTextNode(n.data);
    }
    if (!(n instanceof Element) || isIgnored(n)) {
      return null;
    }
    if (isAtom(n)) {
      return doc.createTextNode(`⟦${++atoms}⟧`);
    }
    const el = doc.createElement(ALLOWED_TAGS.has(n.tagName.toLowerCase()) ? n.tagName.toLowerCase() : "span");
    const href = n.tagName.toLowerCase() === "a" ? n.getAttribute("href") : null;
    if (href && safeUrl(href, false)) {
      el.setAttribute("href", href);
    }
    n.childNodes.forEach((c) => {
      const k = clone(c);
      if (k) {
        el.append(k);
      }
    });
    return el;
  };
  const root = doc.createElement("div");
  block.childNodes.forEach((c) => {
    const k = clone(c);
    if (k) {
      root.append(k);
    }
  });
  return root.innerHTML;
}

export function plainText(html: string, doc: Document = document): string {
  const tpl = doc.createElement("template");
  tpl.innerHTML = html;
  return tpl.content.textContent ?? "";
}

export function hashString(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) - h + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * Which units of one block show their translation: n * percent / 100 of them (rounded either way),
 * spread evenly so the languages alternate instead of bunching (a shuffle left runs of five
 * sentences in one language). The phase comes from a seed, so a page keeps the same mix on revisit.
 */
export function assignTranslated(sources: string[], percent: number, seed: string): boolean[] {
  const p = Math.max(0, Math.min(100, percent)) / 100;
  const phase = (hashString(`${seed}::${sources.join("|")}`) % 1000) / 1000;
  return sources.map((_, i) => Math.floor((i + 1) * p + phase) > Math.floor(i * p + phase));
}

/**
 * The share of units that show their translation, for a mixed `percent` that counts text in the
 * display language `lang`: the same setting reads 70 % Japanese on English and Japanese pages alike.
 * Without a display language (an overlay the UI has not configured yet) it counts the translation.
 */
export const translatedShare = (percent: number, target: Target, lang: string) => (!lang || target === lang ? percent : 100 - percent);

/** Whether a space must follow `text` before more Latin-script text (as segments::joined_translation). */
export const endsSpaced = (text: string) => /[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\uff00-\uffef]$/u.test(text);

/**
 * What the overlay does with a key pressed in the page. "take": forward it before the page sees
 * it. "unlessHandled": forward it once the page has had it, if the page did not preventDefault
 * (sites with their own "/" or "j" keep them). Null: the page's.
 */
export function routeKey(keys: PageKeys, key: string | null, inField: boolean, prefixArmed: boolean): "take" | "unlessHandled" | null {
  if (!key) {
    return null;
  }
  if (prefixArmed) {
    return "take";
  }
  if (!keys.inFields.includes(key) && (inField || !keys.outside.includes(key))) {
    return null;
  }
  // A plain key has no browser default to suppress; a Ctrl / Alt one may (Ctrl+S, Ctrl+P).
  return /^(Ctrl|Alt)\+/.test(key) ? "take" : "unlessHandled";
}
