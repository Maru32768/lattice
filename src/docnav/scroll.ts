// Scrolling a document by key: the same moves in the Reader, the chat log and a page (overlay).

const LINE = 60;
// A page's own `scroll-behavior: smooth` would drag behind a held key.
const behavior = "instant";
// As a browser's Space: the last lines of a screen stay on the next one.
const screen = (el: Element) => (el.clientHeight * 7) / 8;

const MOVES = {
  scrollDown: (el: Element, n: number) => el.scrollBy({ top: n * LINE, behavior }),
  scrollUp: (el: Element, n: number) => el.scrollBy({ top: -n * LINE, behavior }),
  scrollLeft: (el: Element, n: number) => el.scrollBy({ left: -n * LINE, behavior }),
  scrollRight: (el: Element, n: number) => el.scrollBy({ left: n * LINE, behavior }),
  halfDown: (el: Element, n: number) => el.scrollBy({ top: (n * el.clientHeight) / 2, behavior }),
  halfUp: (el: Element, n: number) => el.scrollBy({ top: (-n * el.clientHeight) / 2, behavior }),
  pageDown: (el: Element, n: number) => el.scrollBy({ top: n * screen(el), behavior }),
  pageUp: (el: Element, n: number) => el.scrollBy({ top: -n * screen(el), behavior }),
  docTop: (el: Element) => el.scrollTo({ top: 0, behavior }),
  docBottom: (el: Element) => el.scrollTo({ top: el.scrollHeight, behavior }),
};

export type DocScroll = keyof typeof MOVES;
export const isDocScroll = (id: string): id is DocScroll => Object.hasOwn(MOVES, id);
export const scrollDoc = (el: Element, id: DocScroll, count: number) => MOVES[id](el, count);

/** The largest box in `root` (itself included) that can scroll: what a reader of `root` means by "the document". */
export function scrollerIn(root: Element): Element | null {
  let best: Element | null = null;
  let area = 0;
  for (const el of [root, ...root.querySelectorAll("*")]) {
    // The geometry first: it rules out most elements without computing their style.
    if (el.scrollHeight <= el.clientHeight || el.clientWidth * el.clientHeight <= area || !/auto|scroll/.test(getComputedStyle(el).overflowY)) {
      continue;
    }
    best = el;
    area = el.clientWidth * el.clientHeight;
  }
  return best;
}

/** Whether a reader can scroll the viewport: it takes its overflow from the root element, or from the body if the root leaves it visible. */
function viewportScrolls(): boolean {
  const root = getComputedStyle(document.documentElement).overflowY;
  // A standalone SVG has no body.
  const body = document.body as HTMLElement | null;
  return !/hidden|clip/.test(root === "visible" && body ? getComputedStyle(body).overflowY : root);
}

/** How long a walk's box holds: a walk reads every element, a held `j` asks on each repeat, and a route change can make another box the largest. */
const BOX_MS = 1000;
let pageBox: Element | null = null;
let boxAt = 0;

/** What scrolls a whole page: the viewport, or for an app-like site its largest scrolling box. */
export function pageScroller(): Element | null {
  const root = document.scrollingElement;
  if (root && root.scrollHeight > root.clientHeight && viewportScrolls()) {
    return root;
  }
  if (!pageBox?.isConnected || pageBox.scrollHeight <= pageBox.clientHeight || performance.now() - boxAt > BOX_MS) {
    pageBox = scrollerIn(document.body);
    boxAt = performance.now();
  }
  return pageBox;
}
