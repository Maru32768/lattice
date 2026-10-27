/**
 * Live-DOM overlay: tokenize a leaf block into text/atom tokens, locate a reading unit's
 * plain text as a Range, wrap it in a sentence span, and swap original/translated variants
 * while keeping the page's own elements (links, code styling, images) in place.
 *
 * Adapted from Mazelingo's dom-overlay (MIT License, Copyright (c) 2026 Yeq6X).
 */

/** Elements that carry no translatable text and are moved, never re-created. */
export const ATOM_TAGS = new Set(["svg", "img", "video", "canvas", "input", "select", "textarea", "iframe", "math"]);
const IGNORED_TAGS = new Set(["script", "style", "noscript", "template"]);
const PLACEHOLDER = /⟦(\d+)⟧/gu;

type Meta = {
  latticeAtom?: boolean;
  latticeAtomNumber?: number;
};

export type SentenceSpan = HTMLElement & {
  latticeOriginal?: DocumentFragment;
  latticeAtoms?: Map<number, Node>;
  latticeAtomNumbers?: number[];
};

const tag = (n: Node | null | undefined) => (n instanceof Element ? n.tagName.toLowerCase() : "");
const children = (n: Node | null | undefined): Node[] => Array.from(n?.childNodes ?? []);

export function isIgnored(n: Node): boolean {
  return n instanceof Element && (IGNORED_TAGS.has(tag(n)) || n.getAttribute("aria-hidden") === "true");
}

export function isAtom(n: Node | null | undefined): boolean {
  if (!(n instanceof Element)) {
    return false;
  }
  const m = n as Element & Meta;
  if (typeof m.latticeAtom === "boolean") {
    return m.latticeAtom;
  }
  return ATOM_TAGS.has(tag(n)) || (n.textContent ?? "").trim() === "";
}

interface Boundary {
  container: Node;
  offset: number;
}

const before = (n: Node): Boundary | null => {
  const p = n.parentNode;
  if (!p) {
    return null;
  }
  const offset = children(p).indexOf(n);
  return offset < 0 ? null : { container: p, offset };
};
const after = (n: Node): Boundary | null => {
  const b = before(n);
  return b && { container: b.container, offset: b.offset + 1 };
};

export interface Token {
  type: "text" | "atom";
  node: Node;
  text: string;
}

/** Text and atom tokens in document order; atoms read as ⟦n⟧, numbered per block. */
export function tokenize(block: Element, isSentence: (n: Node) => boolean = () => false): Token[] {
  const out: Token[] = [];
  let atoms = 0;
  const visit = (n: Node) => {
    if (n instanceof Text) {
      if (n.data) {
        out.push({ type: "text", node: n, text: n.data });
      }
      return;
    }
    if (!(n instanceof Element) && n.nodeType !== 11) {
      return;
    }
    if (n instanceof Element) {
      if (isIgnored(n)) {
        return;
      }
      if (!isSentence(n)) {
        const atom = ATOM_TAGS.has(tag(n)) || (n.textContent ?? "").trim() === "";
        (n as Element & Meta).latticeAtom = atom;
        if (atom) {
          atoms += 1;
          (n as Element & Meta).latticeAtomNumber = atoms;
          out.push({ type: "atom", node: n, text: `⟦${atoms}⟧` });
          return;
        }
      }
    }
    children(n).forEach(visit);
  };
  children(block).forEach(visit);
  return out;
}

interface Char {
  value: string;
  start: Boundary;
  end: Boundary;
}

/** Characters of the token stream with whitespace runs collapsed to one space. */
function normalizeStream(tokens: Token[]): { text: string; chars: Char[] } {
  const chars: Char[] = [];
  let ws: { start: Boundary; end: Boundary } | null = null;
  const push = (value: string, start: Boundary, end: Boundary) => {
    if (/\s/u.test(value)) {
      if (ws) {
        ws.end = end;
      } else {
        ws = { start, end };
      }
      return;
    }
    if (ws) {
      chars.push({ value: " ", start: ws.start, end: ws.end });
      ws = null;
    }
    chars.push({ value, start, end });
  };
  for (const t of tokens) {
    if (t.type === "atom") {
      const s = before(t.node),
        e = after(t.node);
      if (s && e) {
        for (const c of t.text) {
          push(c, s, e);
        }
      }
    } else {
      // Index by UTF-16 offset: Range offsets into Text nodes are UTF-16 based.
      for (let i = 0; i < t.text.length; i++) {
        push(t.text.charAt(i), { container: t.node, offset: i }, { container: t.node, offset: i + 1 });
      }
    }
  }
  if (ws) {
    chars.push({ value: " ", start: (ws as { start: Boundary }).start, end: (ws as { end: Boundary }).end });
  }
  return { text: chars.map((c) => c.value).join(""), chars };
}

export const normalizeText = (s: string) => s.replace(/\s+/gu, " ").trim();

/** Resolves once `root` has had no DOM mutations for `quietMs`, or after `maxMs` regardless (JS pages still rendering). */
export function settle(root: Node, quietMs: number, maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      observer.disconnect();
      clearTimeout(quiet);
      clearTimeout(cap);
      resolve();
    };
    const observer = new MutationObserver(() => {
      clearTimeout(quiet);
      quiet = setTimeout(done, quietMs);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    quiet = setTimeout(done, quietMs);
    const cap = setTimeout(done, maxMs);
  });
}

export interface Located {
  start: Boundary;
  end: Boundary;
  nextIndex: number;
}

function atElementEdge(b: Boundary, el: Element, edge: "start" | "end"): boolean {
  let { container, offset } = b;
  while (container !== el) {
    const len = container instanceof Text ? container.data.length : children(container).length;
    if (offset !== (edge === "start" ? 0 : len)) {
      return false;
    }
    const p = container.parentNode;
    if (!p) {
      return false;
    }
    const idx = children(p).indexOf(container);
    if (idx !== (edge === "start" ? 0 : children(p).length - 1)) {
      return false;
    }
    container = p;
    offset = edge === "start" ? 0 : children(p).length;
  }
  return offset === (edge === "start" ? 0 : children(el).length);
}

const inside = (b: Boundary, el: Element) => el.contains(b.container);

/** Expand a range to whole inline elements it fully covers, so wrapping never splits them. */
function promote(start: Boundary, end: Boundary, root: Element): [Boundary, Boundary] {
  if (start.container instanceof Text && start.offset === 0) {
    start = before(start.container) ?? start;
  }
  if (end.container instanceof Text && end.offset === end.container.data.length) {
    end = after(end.container) ?? end;
  }
  for (let changed = true; changed;) {
    changed = false;
    const sc = start.container;
    if (sc instanceof Element && sc !== root && start.offset === 0 && (!inside(end, sc) || atElementEdge(end, sc, "end"))) {
      const b = before(sc);
      if (b) {
        [start, changed] = [b, true];
      }
    }
    const ec = end.container;
    if (ec instanceof Element && ec !== root && end.offset === children(ec).length && (!inside(start, ec) || atElementEdge(start, ec, "start"))) {
      const a = after(ec);
      if (a) {
        [end, changed] = [a, true];
      }
    }
  }
  return [start, end];
}

/** Finds `plain` (a unit's source text) in the block, searching from `fromIndex`. */
export function locate(block: Element, tokens: Token[], plain: string, fromIndex = 0): Located | null {
  const source = normalizeText(plain);
  if (!source) {
    return null;
  }
  const { text, chars } = normalizeStream(tokens);
  const at = text.indexOf(source, Math.max(0, fromIndex));
  if (at < 0) {
    return null;
  }
  const first = chars[at],
    last = chars[at + source.length - 1];
  if (!first || !last) {
    return null;
  }
  const [start, end] = promote(first.start, last.end, block);
  return { start, end, nextIndex: at + source.length };
}

function collectAtoms(root: Node): Element[] {
  const out: Element[] = [];
  const visit = (n: Node) => {
    if (n instanceof Element && isAtom(n)) {
      out.push(n);
    } else {
      children(n).forEach(visit);
    }
  };
  children(root).forEach(visit);
  return out;
}

function copyMeta(src: Node, dst: Node) {
  if (src instanceof Element && dst instanceof Element) {
    const m = (src as Element & Meta).latticeAtom;
    if (typeof m === "boolean") {
      (dst as Element & Meta).latticeAtom = m;
    }
  }
  const d = children(dst);
  children(src).forEach((c, i) => d[i] && copyMeta(c, d[i]));
}

function cloneFragment(f: DocumentFragment): DocumentFragment {
  const c = f.cloneNode(true) as DocumentFragment;
  copyMeta(f, c);
  return c;
}

export function wrapRange(range: Range, className: string): SentenceSpan {
  const doc = range.startContainer.ownerDocument!;
  const span = doc.createElement("span") as SentenceSpan;
  span.className = className;
  span.append(range.extractContents());
  span.latticeAtoms = new Map();
  span.latticeAtomNumbers = [];
  for (const a of collectAtoms(span)) {
    const n = Number((a as Element & Meta).latticeAtomNumber);
    if (Number.isInteger(n) && n > 0) {
      span.latticeAtoms.set(n, a);
      span.latticeAtomNumbers.push(n);
    }
  }
  const original = doc.createDocumentFragment();
  children(span).forEach((c) => {
    const k = c.cloneNode(true);
    copyMeta(c, k);
    original.append(k);
  });
  span.latticeOriginal = original;
  range.insertNode(span);
  return span;
}

/** Original fragment with the live atom nodes (not clones) put back. */
function hydrate(span: SentenceSpan): DocumentFragment {
  const f = cloneFragment(span.latticeOriginal!);
  const numbers = span.latticeAtomNumbers ?? [];
  collectAtoms(f).forEach((clone, i) => {
    const n = numbers[i];
    const live = n === undefined ? undefined : span.latticeAtoms?.get(n);
    if (live) {
      clone.replaceWith(live);
    }
  });
  return f;
}

function elements(root: Node): Element[] {
  const out: Element[] = [];
  const visit = (n: Node) => {
    if (n instanceof Element) {
      if (isAtom(n)) {
        return;
      }
      out.push(n);
    }
    children(n).forEach(visit);
  };
  children(root).forEach(visit);
  return out;
}

function textPlacements(n: Node): Text[] {
  return children(n).flatMap((c) => (c instanceof Text ? [c] : c instanceof Element && !isAtom(c) ? textPlacements(c) : []));
}

function removeText(root: Node) {
  textPlacements(root).forEach((t) => t.remove());
}

function insertText(doc: Document, parent: Node, ref: Node | null, text: string, atoms: Map<number, Node>) {
  const frag = doc.createDocumentFragment();
  let cursor = 0;
  for (const m of text.matchAll(PLACEHOLDER)) {
    if (m.index > cursor) {
      frag.append(doc.createTextNode(text.slice(cursor, m.index)));
    }
    const atom = atoms.get(Number(m[1]));
    frag.append(atom ?? doc.createTextNode(m[0]));
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length) {
    frag.append(doc.createTextNode(text.slice(cursor)));
  }
  parent.insertBefore(frag, ref && ref.parentNode === parent ? ref : null);
}

/**
 * Shows `html` (sanitized translation) in the span. When its element structure matches the
 * original (same inline tags in the same order), the translated text is poured into the
 * page's own elements so classes/styles/links survive; otherwise it falls back to text.
 */
export function renderVariant(span: SentenceSpan, html: string) {
  const doc = span.ownerDocument;
  const atoms = span.latticeAtoms ?? new Map<number, Node>();
  const original = hydrate(span);
  const tpl = doc.createElement("template");
  tpl.innerHTML = html;
  const variant = tpl.content;
  const oEls = elements(original),
    vEls = elements(variant);
  const sameShape = oEls.length === vEls.length && oEls.every((e, i) => tag(e) === tag(vEls[i]));
  if (sameShape) {
    const vIndex = new Map(vEls.map((e, i) => [e, i] as const));
    const placements = textPlacements(variant);
    removeText(original);
    for (const t of placements) {
      const vp = t.parentNode;
      const target = vp instanceof Element ? (oEls[vIndex.get(vp) ?? -1] ?? original) : original;
      let next = t.nextSibling;
      while (next && (!(next instanceof Element) || isAtom(next))) {
        next = next.nextSibling;
      }
      const ref = next instanceof Element ? (oEls[vIndex.get(next) ?? -1] ?? null) : null;
      insertText(doc, target, ref, t.data, atoms);
    }
  } else {
    const first = textPlacements(original)[0];
    const parent = first?.parentNode ?? original;
    removeText(original);
    // Emptied inline elements (a <code> inside a dropped link) would show as blank boxes; ones holding atoms stay.
    elements(original)
      .toReversed()
      .forEach((e) => e !== parent && !e.contains(parent) && e.childNodes.length === 0 && e.remove());
    insertText(doc, parent, null, variant.textContent ?? "", atoms);
  }
  span.replaceChildren(original);
}

export function renderOriginal(span: SentenceSpan) {
  span.replaceChildren(hydrate(span));
}
