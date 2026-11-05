// What `f` and `gw` put labels on. Ideas from Vimium's link_hints.js (see controller.ts).

/** A place in the document that typing its label picks. */
export interface Target {
  /** Where it is now; null when off screen. */
  rect(): DOMRect | null;
  pick(newTab: boolean): void;
}

const ALPHABET = "SADFJKLEWCMPGH";

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
