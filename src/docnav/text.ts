// A document's text as a reader sees it, as one string mapped back to the DOM. `window.find` cannot do
// this job: it cannot be kept to one pane of the app, and in the PDF viewer it stops at the end of each
// line and goes into the paragraphs laid invisibly over the text.

const NOT_TEXT = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "SELECT"]);

/** The text nodes in `root` a reader can see and select, in document order. Not our own UI, nor the PDF viewer's invisible paragraphs. */
export function textNodes(root: Element): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (n.nodeType === Node.ELEMENT_NODE) {
        const el = n as Element;
        return NOT_TEXT.has(el.tagName) || el.hasAttribute("data-lattice-ui") || getComputedStyle(el).display === "none"
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_SKIP;
      }
      const style = getComputedStyle(n.parentElement!);
      return n.nodeValue?.trim() && style.visibility !== "hidden" && style.userSelect !== "none" ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  const out: Text[] = [];
  while (walker.nextNode()) {
    out.push(walker.currentNode as Text);
  }
  return out;
}

/** The first character of `node` below `top`: the first of its lines may have scrolled away. */
export function firstVisibleOffset(node: Text, top: number): number {
  const r = document.createRange();
  let [lo, hi] = [0, node.length - 1];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    r.setStart(node, mid);
    r.setEnd(node, mid + 1);
    if (r.getBoundingClientRect().bottom > top) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  while (lo < node.length - 1 && /\s/u.test(node.data.charAt(lo))) {
    lo++;
  }
  return lo;
}

export interface DocText {
  /** The text with all its whitespace gone. */
  text: string;
  nodes: Text[];
  /** For each character of `text`: the index of its node, and its offset in that node. */
  nodeAt: number[];
  offsetAt: number[];
}

export function docText(root: Element): DocText {
  const nodes = textNodes(root);
  const chars: string[] = [];
  const nodeAt: number[] = [];
  const offsetAt: number[] = [];
  nodes.forEach(({ data }, n) => {
    for (let o = 0; o < data.length; o++) {
      if (!/\s/u.test(data.charAt(o))) {
        chars.push(data.charAt(o));
        nodeAt.push(n);
        offsetAt.push(o);
      }
    }
  });
  return { text: chars.join(""), nodes, nodeAt, offsetAt };
}

/** Lower case with the length kept, so that an index into the result is one into `s`. */
function fold(s: string): string {
  const low = s.toLowerCase();
  return low.length === s.length ? low : [...s].map((c) => (c.toLowerCase().length === c.length ? c.toLowerCase() : c)).join("");
}

/**
 * Where `query` occurs in `text` (a `DocText`'s): as Vim's smartcase, a query with a capital minds case.
 * Whitespace never counts: lines in a PDF end anywhere, also inside a Japanese word.
 */
export function matchesIn(text: string, query: string): { starts: number[]; length: number } {
  const q = query.replace(/\s+/gu, "");
  const starts: number[] = [];
  if (!q) {
    return { starts, length: 0 };
  }
  const minded = q !== q.toLowerCase();
  const [hay, needle] = minded ? [text, q] : [fold(text), fold(q)];
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) {
    starts.push(i);
  }
  return { starts, length: needle.length };
}

/** The next match from `origin`, or the last before it for `dir` -1, wrapping round; -1 for no match at all. */
export function pickMatch(starts: number[], origin: number, dir: 1 | -1): number {
  if (dir > 0) {
    const i = starts.findIndex((s) => s >= origin);
    return i >= 0 ? i : starts.length ? 0 : -1;
  }
  const i = starts.findLastIndex((s) => s < origin);
  return i >= 0 ? i : starts.length - 1;
}

/** The match at `start` as a Range, across however many nodes it runs. */
export function rangeAt(doc: DocText, start: number, length: number): Range {
  const end = start + length - 1;
  const r = document.createRange();
  r.setStart(doc.nodes[doc.nodeAt[start]!]!, doc.offsetAt[start]!);
  r.setEnd(doc.nodes[doc.nodeAt[end]!]!, doc.offsetAt[end]! + 1);
  return r;
}

/** The index in `doc.text` of the first character at or after this point; null for a point outside the text. */
export function indexOfPoint(doc: DocText, node: Node, offset: number): number | null {
  const n = doc.nodes.indexOf(node as Text);
  if (n < 0) {
    return null;
  }
  let [lo, hi] = [0, doc.text.length];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (doc.nodeAt[mid]! < n || (doc.nodeAt[mid] === n && doc.offsetAt[mid]! < offset)) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}
