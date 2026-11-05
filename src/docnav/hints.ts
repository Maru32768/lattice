// What `f` and `gw` put labels on. Ideas from Vimium's link_hints.js (see controller.ts).
import { firstVisibleOffset, textNodes } from "./text.ts";

/** A place in the document that typing its label picks. */
export interface Target {
  /** Where it is now; null when off screen. */
  rect(): DOMRect | null;
  pick(newTab: boolean): void;
}

const ALPHABET = "SADFJKLEWCMPGH";
/** Every two-letter label: more words on screen than this get a label only every so often. */
const MAX_WORDS = ALPHABET.length ** 2;
const LABEL_WIDTH = 24;

const CLICKABLE =
  "a[href],area[href],button,input:not([type='hidden']),select,textarea,summary,label[for],[onclick],[contenteditable=''],[contenteditable='true']," +
  "[role='button'],[role='link'],[role='tab'],[role='checkbox'],[role='radio'],[role='switch'],[role='option'],[role='menuitem'],[role='menuitemcheckbox'],[role='menuitemradio']," +
  "[tabindex]:not([tabindex='-1'])";
const NOT_TYPED = "button,submit,reset,checkbox,radio,image,file,color,range".split(",").map((t) => `[type='${t}']`);
const TEXT_FIELD = `input:not(${NOT_TYPED.join(",")}),textarea,[contenteditable=''],[contenteditable='true']`;
/** Picking one of these means going into it, not clicking it. */
const FIELD = `${TEXT_FIELD},select`;

/** Labels for `n` targets, none the start of another; the first letters are spread over the alphabet rather than bunched. */
export function hintLabels(n: number, alphabet = ALPHABET): string[] {
  const labels = [""];
  let used = 0;
  while (labels.length - used < n || labels.length === 1) {
    const label = labels[used++]!;
    for (const c of alphabet) {
      labels.push(c + label);
    }
  }
  return labels
    .slice(used, used + n)
    .toSorted()
    .map((l) => [...l].toReversed().join(""));
}

/** At most `max` of `items`, evenly spaced: every part of the screen stays within reach of a label. */
export function spread<T>(items: T[], max: number): T[] {
  return items.length <= max ? items : items.filter((_, i) => Math.floor((i * max) / items.length) !== Math.floor(((i - 1) * max) / items.length));
}

function hitAt(x: number, y: number): Element | null {
  let hit = document.elementFromPoint(x, y);
  while (hit?.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) {
      break;
    }
    hit = inner;
  }
  return hit;
}

/** Whether `a` is in `b`, across shadow roots. */
function within(a: Node | null, b: Node): boolean {
  for (let n = a; n; n = n.parentNode ?? (n as ShadowRoot).host ?? null) {
    if (n === b) {
      return true;
    }
  }
  return false;
}

const onScreen = (r: DOMRect) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;

/** The part of `el` a click would reach: in the viewport and not under something else. */
function reachable(el: Element): DOMRect | null {
  for (const r of el.getClientRects()) {
    if (onScreen(r)) {
      const hit = hitAt(Math.min(r.left + r.width / 2, innerWidth - 1), Math.min(r.top + r.height / 2, innerHeight - 1));
      if (hit && (within(hit, el) || within(el, hit))) {
        return r;
      }
    }
  }
  return null;
}

/** As a real click does, for pages that listen for the press and menus that open on it. */
function clickOn(el: Element, ctrlKey: boolean) {
  const r = el.getBoundingClientRect();
  const init = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    button: 0,
    ctrlKey,
    clientX: r.left + r.width / 2,
    clientY: r.top + r.height / 2,
  };
  el.dispatchEvent(new PointerEvent("pointerdown", init));
  el.dispatchEvent(new MouseEvent("mousedown", init));
  el.dispatchEvent(new PointerEvent("pointerup", init));
  el.dispatchEvent(new MouseEvent("mouseup", init));
  el.dispatchEvent(new MouseEvent("click", init));
}

function allIn(scope: ParentNode, out: Element[] = []): Element[] {
  for (const el of scope.querySelectorAll("*")) {
    if (el.matches(CLICKABLE) && !el.matches(":disabled,[aria-disabled='true']")) {
      out.push(el);
    }
    if (el.shadowRoot) {
      allIn(el.shadowRoot, out);
    }
  }
  return out;
}

/** What can be clicked on screen in `root`, open shadow roots included. Of several in one spot only the outermost: two labels there would hide each other. */
export function linkTargets(root: Element): Target[] {
  const spots = new Set<string>();
  const out: Target[] = [];
  for (const el of allIn(root)) {
    const r = reachable(el);
    const spot = r && `${Math.round(r.left)}:${Math.round(r.top)}`;
    if (!spot || spots.has(spot)) {
      continue;
    }
    spots.add(spot);
    out.push({
      rect: () => reachable(el),
      pick: (newTab) => (el.matches(FIELD) ? (el as HTMLElement).focus() : clickOn(el, newTab)),
    });
  }
  return out;
}

/** The first text field on screen in `root`. */
export function firstField(root: Element): HTMLElement | null {
  return (allIn(root).find((el) => el.matches(TEXT_FIELD) && reachable(el)) as HTMLElement | undefined) ?? null;
}

/** Whether a reader can see `parent`'s text at this point: nothing with text lies over it. An empty box, as a PDF's link, hides nothing. */
function seenAt(r: DOMRect, parent: Element): boolean {
  const hit = hitAt(r.left + r.width / 2, r.top + r.height / 2);
  return !!hit && (within(hit, parent) || within(parent, hit) || !hit.textContent);
}

/** The words on screen in `root` that a reader can see, as Ranges: `Intl.Segmenter`, so that Japanese has words too. */
export function visibleWords(root: Element): Range[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  const whole = document.createRange();
  const out: Range[] = [];
  let last = null as DOMRect | null;
  for (const node of textNodes(root)) {
    whole.selectNodeContents(node);
    if (!onScreen(whole.getBoundingClientRect())) {
      continue;
    }
    // One node can be a whole plain-text page, where a Range takes as long as all its lines: only for words, and only those on screen.
    // shortcut: a node run across columns taller than the view loses the columns after the first, upgrade if such a page turns up.
    const start = firstVisibleOffset(node, 0);
    // Once a line: a hit test costs a good part of a millisecond on a PDF's page, and there are hundreds of words.
    let line = null as { top: number; seen: boolean } | null;
    for (const { segment, index, isWordLike } of segmenter.segment(node.data.slice(start))) {
      if (!isWordLike) {
        continue;
      }
      const range = document.createRange();
      range.setStart(node, start + index);
      range.setEnd(node, start + index + segment.length);
      const box = range.getClientRects()[0];
      if (box && box.top >= innerHeight) {
        break;
      }
      if (!box || !onScreen(box)) {
        continue;
      }
      if (line?.top !== box.top) {
        line = { top: box.top, seen: seenAt(box, node.parentElement!) };
      }
      // Japanese has several words in the space of one label, which would only hide each other.
      if (line.seen && !(last && Math.abs(box.top - last.top) < box.height / 2 && Math.abs(box.left - last.left) < LABEL_WIDTH)) {
        out.push(range);
        last = box;
      }
    }
  }
  return spread(out, MAX_WORDS);
}
