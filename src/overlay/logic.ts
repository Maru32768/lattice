/**
 * Pure overlay logic (no live page state): snippet preparation, line-break splitting,
 * sanitizing translated HTML, and deterministic display assignment.
 *
 * Adapted from Mazelingo's content-logic (MIT License, Copyright (c) 2026 Yeq6X).
 */
import { isAtom, isIgnored } from "./dom.ts";

const HTML_TAGS = /<[^>]*>/gu;
const UNIT_END = /[。．.!！?？…」』）)]$/u;
const BREAKS = /(?:\r\n|\n|<br\b[^>]*>)(?:[ \t]*(?:\r\n|\n|<br\b[^>]*>))*/giu;
const ONE_BREAK = /\r\n|\n|<br\b[^>]*>/giu;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const ALNUM = /[\p{L}\p{N}]/u;

export const ALLOWED_TAGS = new Set(["a", "b", "i", "em", "strong", "span", "img", "br", "code", "s", "u", "mark", "sub", "sup", "kbd"]);

/** Split at blank lines always, and at single newlines/<br> after sentence-ending punctuation. */
export function splitByLineBreaks(html: string): { parts: string[]; separators: string[] } {
  const raw: string[] = [], rawSep: string[] = [];
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
  const parts: string[] = [], separators: string[] = [];
  let pending = "";
  raw.forEach((p, i) => {
    if (p.trim()) {
      if (parts.length > 0) separators.push(pending);
      parts.push(p);
      pending = "";
    }
    if (i < rawSep.length) pending += rawSep[i];
  });
  return { parts, separators };
}

export function isCjkDominant(text: string): boolean {
  let cjk = 0, alnum = 0;
  for (const c of text) {
    if (CJK.test(c)) cjk++;
    if (ALNUM.test(c)) alnum++;
  }
  return cjk > 0 && cjk * 2 >= alnum;
}

export type Target = "ja" | "en";

/** Japanese pages translate into English, all others into Japanese: the declared `lang` decides, else the text. */
export function pageTarget(lang: string, sample: string): Target {
  const l = lang.trim().toLowerCase();
  const japanese = l ? l === "ja" || l.startsWith("ja-") || l.startsWith("ja_") : isCjkDominant(sample);
  return japanese ? "en" : "ja";
}

/** Text already in the target language has nothing to translate. */
export const isWrittenIn = (text: string, target: Target) => isCjkDominant(text) === (target === "ja");

const safeUrl = (v: string, allowData: boolean) => {
  const s = v.trim().replace(/[\p{C}\s]+/gu, "");
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(s)?.[1]?.toLowerCase();
  if (allowData && /^data:image\//iu.test(s)) return true;
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
        const keep = (name === "a" && n === "href" && safeUrl(a.value, false)) ||
          (name === "img" && n === "src" && safeUrl(a.value, true)) || (name === "img" && n === "alt");
        if (!keep) el.removeAttribute(a.name);
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
    if (n instanceof Text) return doc.createTextNode(n.data);
    if (!(n instanceof Element) || isIgnored(n)) return null;
    if (isAtom(n)) return doc.createTextNode(`⟦${++atoms}⟧`);
    const el = doc.createElement(ALLOWED_TAGS.has(n.tagName.toLowerCase()) ? n.tagName.toLowerCase() : "span");
    const href = n.tagName.toLowerCase() === "a" ? n.getAttribute("href") : null;
    if (href && safeUrl(href, false)) el.setAttribute("href", href);
    n.childNodes.forEach((c) => {
      const k = clone(c);
      if (k) el.append(k);
    });
    return el;
  };
  const root = doc.createElement("div");
  block.childNodes.forEach((c) => {
    const k = clone(c);
    if (k) root.append(k);
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
  for (let i = 0; i < input.length; i++) h = ((h << 5) - h + input.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Which units of one block show their translation: exactly round(n * percent / 100) with
 * the rounding and order derived from a seed, so a page keeps the same mix on revisit.
 */
export function assignTranslated(sources: string[], percent: number, seed: string): boolean[] {
  const n = sources.length;
  const p = Math.max(0, Math.min(100, percent));
  const s = hashString(`${seed}::${sources.join("|")}`);
  const exact = (n * p) / 100;
  const count = Math.floor(exact) + (Math.abs(Math.trunc(s * 2654435761)) % 100 < (exact % 1) * 100 ? 1 : 0);
  const out = Array.from({ length: n }, (_, i) => i < count);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.abs(Math.trunc(s * (i + 1) * 2654435761)) % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
