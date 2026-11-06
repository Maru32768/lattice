// Moving a selection by keys, through `Selection.modify`. Ideas from Vimium's mode_visual.js (see controller.ts).
import { textNodes } from "./text.ts";

type Dir = "forward" | "backward";
/** `move` carries the caret, `extend` only the selection's focus. */
type Alter = "move" | "extend";
type Motion = (s: Selection, alter: Alter, root: Element) => void;

const SAME_LINE = 2;

/** The character the focus would pass going `dir`; the selection stays as it is. */
function charAt(s: Selection, dir: Dir): string {
  const [a, ao, f, fo] = [s.anchorNode!, s.anchorOffset, s.focusNode!, s.focusOffset];
  const before = s.toString();
  s.modify("extend", dir, "character");
  const after = s.toString();
  s.setBaseAndExtent(a, ao, f, fo);
  if (after.length > before.length) {
    return (dir === "forward" ? after.at(-1) : after[0]) ?? "";
  }
  return (dir === "forward" ? before[0] : before.at(-1)) ?? "";
}

const skipSpace = (s: Selection, alter: Alter, dir: Dir) => {
  for (let i = 0; i < 64 && /\s/u.test(charAt(s, dir)); i++) {
    s.modify(alter, dir, "character");
  }
};

/** Where a collapsed caret at the focus is drawn. */
export function focusRect(s: Selection): DOMRect | null {
  const r = document.createRange();
  r.setStart(s.focusNode!, s.focusOffset);
  r.collapse(true);
  const box = r.getClientRects()[0];
  if (box) {
    return box;
  }
  // A caret between two nodes has no box of its own: the character next to it does.
  const len = s.focusNode instanceof Text ? s.focusNode.length : s.focusNode!.childNodes.length;
  r.setEnd(s.focusNode!, Math.min(s.focusOffset + 1, len));
  return r.getClientRects()[0] ?? (s.focusNode instanceof Element ? s.focusNode : s.focusNode!.parentElement)?.getBoundingClientRect() ?? null;
}

const sameLine = (a: DOMRect | null, b: DOMRect | null) => !!a && !!b && Math.abs(a.top - b.top) < Math.max(SAME_LINE, a.height / 2);

const samePoint = (s: Selection, node: Node | null, offset: number) => s.focusNode === node && s.focusOffset === offset;

const place = (s: Selection, alter: Alter, node: Node, offset: number) => (alter === "move" ? s.collapse(node, offset) : s.extend(node, offset));

/**
 * A line step in a PDF's text layer stops between two of its spans, at no text at all, and where along the
 * line it came from is lost: the place is the start of the line it reached.
 */
function intoLine(s: Selection, alter: Alter, dir: Dir) {
  const node = s.focusNode;
  if (!(node instanceof Element)) {
    return;
  }
  const forward = dir === "forward";
  for (let c: ChildNode | null = node.childNodes[forward ? s.focusOffset : s.focusOffset - 1] ?? null; c; c = forward ? c.nextSibling : c.previousSibling) {
    let text: Node | null = c;
    while (text && !(text instanceof Text)) {
      text = forward ? text.firstChild : text.lastChild;
    }
    if (text?.nodeValue?.trim()) {
      place(s, alter, text, 0);
      return forward ? undefined : lineEdge(s, alter, "backward");
    }
  }
}

/** A line up or down. A line in a PDF is often several spans in a row, and each counts as a line of its own here: go on until the place on screen changes. */
function lineMotion(dir: Dir): Motion {
  return (s, alter) => {
    const from = focusRect(s);
    for (let i = 0; i < 32; i++) {
      const [node, offset] = [s.focusNode, s.focusOffset];
      s.modify(alter, dir, "line");
      intoLine(s, alter, dir);
      if (samePoint(s, node, offset) || !sameLine(from, focusRect(s))) {
        return;
      }
    }
  };
}

/** To the edge of the line, for the same reason over all its spans. */
function lineEdge(s: Selection, alter: Alter, dir: Dir) {
  const line = focusRect(s);
  for (let i = 0; i < 32; i++) {
    s.modify(alter, dir, "lineboundary");
    const [node, offset] = [s.focusNode!, s.focusOffset];
    s.modify(alter, dir, "character");
    if (samePoint(s, node, offset) || !sameLine(line, focusRect(s))) {
      return place(s, alter, node, offset);
    }
  }
}

const lineStart: Motion = (s, alter) => lineEdge(s, alter, "backward");
const lineEnd: Motion = (s, alter) => lineEdge(s, alter, "forward");
const firstNonBlank: Motion = (s, alter) => {
  lineEdge(s, alter, "backward");
  skipSpace(s, alter, "forward");
};

// Windows stops `forward word` at the next word's start and other systems at this word's end, so both are told apart by the spaces there.
const wordStart: Motion = (s, alter) => {
  s.modify(alter, "forward", "word");
  skipSpace(s, alter, "forward");
};
// A selection's end lies after the word's last character; a caret's block is on it.
const wordEnd: Motion = (s, alter) => {
  if (alter === "move") {
    s.modify(alter, "forward", "character");
  }
  skipSpace(s, alter, "forward");
  s.modify(alter, "forward", "word");
  skipSpace(s, alter, "backward");
  if (alter === "move") {
    s.modify(alter, "backward", "character");
  }
};

/** The ends of `root`, not of the page: the Reader's selection stays out of the panes beside it. */
const docStart: Motion = (s, alter, root) => {
  const first = textNodes(root)[0];
  if (first) {
    place(s, alter, first, 0);
  }
};
const docEnd: Motion = (s, alter, root) => {
  const last = textNodes(root).at(-1);
  if (last) {
    place(s, alter, last, last.length);
  }
};

/** By key name (`keyOf`). */
export const MOTIONS: Record<string, Motion> = {
  H: (s, alter) => s.modify(alter, "backward", "character"),
  L: (s, alter) => s.modify(alter, "forward", "character"),
  J: lineMotion("forward"),
  K: lineMotion("backward"),
  W: wordStart,
  B: (s, alter) => s.modify(alter, "backward", "word"),
  E: wordEnd,
  "0": lineStart,
  "^": firstNonBlank,
  "Shift+H": firstNonBlank,
  $: lineEnd,
  "Shift+L": lineEnd,
  "G G": docStart,
  "Shift+G": docEnd,
};

/**
 * A block over one character: an ordinary caret cannot be seen in text that is not editable.
 * At the end of `root`, the character before: the next one is another pane's.
 */
export function showBlock(s: Selection, root: Element) {
  const [node, offset] = [s.focusNode!, s.focusOffset];
  s.modify("extend", "forward", "character");
  if (!root.contains(s.focusNode)) {
    s.extend(node, offset);
  }
  if (!s.toString()) {
    s.modify("extend", "backward", "character");
  }
}

/** A selection from `anchorLine` to the focus, whole lines at both ends: what line-wise visual mode shows. */
export function shapeLines(s: Selection, anchorLine: Range) {
  const [node, offset] = [s.focusNode!, s.focusOffset];
  const down = anchorLine.comparePoint(node, offset) >= 0;
  const [base, baseOffset] = down ? [anchorLine.startContainer, anchorLine.startOffset] : [anchorLine.endContainer, anchorLine.endOffset];
  s.setBaseAndExtent(base, baseOffset, node, offset);
  lineEdge(s, "extend", down ? "forward" : "backward");
}

/** The line the focus is on, as the anchor of line-wise visual mode. */
export function lineAtFocus(s: Selection): Range {
  s.collapse(s.focusNode, s.focusOffset);
  const r = document.createRange();
  // Twice: in a PDF `k` can stop on the line break after a line, a line with nothing on it.
  for (let i = 0; i < 2 && !s.toString(); i++) {
    lineEdge(s, "move", "backward");
    r.setStart(s.focusNode!, s.focusOffset);
    lineEdge(s, "extend", "forward");
    if (!s.toString()) {
      s.modify("move", "backward", "character");
    }
  }
  r.setEnd(s.focusNode!, s.focusOffset);
  return r;
}
