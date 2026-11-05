// Scrolling a document by key: the same moves in the Reader, the chat log and a page (overlay).

const LINE = 60;
// A page's own `scroll-behavior: smooth` would drag behind a held key.
const behavior = "instant";

const MOVES = {
  scrollDown: (el: Element, n: number) => el.scrollBy({ top: n * LINE, behavior }),
  scrollUp: (el: Element, n: number) => el.scrollBy({ top: -n * LINE, behavior }),
  scrollLeft: (el: Element, n: number) => el.scrollBy({ left: -n * LINE, behavior }),
  scrollRight: (el: Element, n: number) => el.scrollBy({ left: n * LINE, behavior }),
  halfDown: (el: Element, n: number) => el.scrollBy({ top: (n * el.clientHeight) / 2, behavior }),
  halfUp: (el: Element, n: number) => el.scrollBy({ top: (-n * el.clientHeight) / 2, behavior }),
  docTop: (el: Element) => el.scrollTo({ top: 0, behavior }),
  docBottom: (el: Element) => el.scrollTo({ top: el.scrollHeight, behavior }),
};

export type DocScroll = keyof typeof MOVES;
export const isDocScroll = (id: string): id is DocScroll => id in MOVES;
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

/** What scrolls a whole page: the viewport, or for an app-like site its largest scrolling box. */
export function pageScroller(): Element | null {
  const root = document.scrollingElement;
  return root && root.scrollHeight > root.clientHeight ? root : scrollerIn(document.body);
}
