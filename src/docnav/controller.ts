/**
 * Moving around a document by keys, without a mouse: hints, visual mode, find, headings. One per
 * document host: the app for the Reader and the chat log, the overlay for a page and the PDF viewer.
 * A host gives every key to `onKey` first, and runs the actions the key map names through `run`.
 *
 * The ideas come from Vimium's content scripts (MIT License, Copyright (c) 2010 Phil Crosby, Ilya Sukhar).
 */
import { collapse, isWord } from "../vocab/vocab.ts";
import { isModified, isPrintable, type DocActionId } from "../lib/keymap.ts";
import { firstField, hintLabels, linkTargets, visibleWords, type Target } from "./hints.ts";
import { isDocScroll, scrollDoc } from "./scroll.ts";
import { docText, firstVisibleOffset, indexOfPoint, matchIsLive, matchesIn, pickMatch, rangeAt, textNodes, type DocText } from "./text.ts";
import { createUi, type DocUi, type View } from "./ui.ts";
import { MOTIONS, focusRect, lineAtFocus, shapeLines, showBlock } from "./visual.ts";

export interface DocHost {
  /** Where the document's text and links are; null with no document. */
  root(): Element | null;
  scroller(): Element | null;
  /** The find bar's name, for screen readers. */
  findLabel(): string;
  /** Saves the selected word to the vocabulary. */
  saveWord(): void;
  /** Puts the quote in the chat's input, and sends nothing. */
  ask(quote: string): void;
  /** A step in the document's history. */
  history(d: 1 | -1): void;
  print(): void;
  /** Brings in the text the document has not drawn yet (a PDF's far pages); `more` says that some came. Called on each use, so that a host not ready yet is asked again. */
  allText?(more: () => void): void;
  /** Changes when the document's text does; only a host that can say so has its text kept between uses. */
  textVersion?(): number | undefined;
}

type Hint = Target & { label: string };

interface TextPoint {
  node: Text;
  offset: number;
}

/** What a find leaves to go back to, on Esc. */
interface Place {
  ranges: Range[];
  top: number;
  left: number;
  pageTop: number;
  pageLeft: number;
  focus: Element | null;
}

type FindMode = {
  kind: "find";
  query: string;
  doc: DocText;
  origin: TextPoint | null;
  starts: number[];
  length: number;
  at: number;
  place: Place;
  input: HTMLInputElement;
  count: HTMLElement;
};

type DocMode =
  | { kind: "normal" }
  | { kind: "hints"; typed: string; targets: Hint[]; newTab: boolean }
  /** `g`: the first key of `gg` was pressed. */
  | { kind: "caret"; g: boolean }
  /** `line`: line-wise, from this line. */
  | { kind: "visual"; line: Range | null; g: boolean }
  /** `doc` and `origin`: what the query is looked for in, and from where. `at`: the match shown, in `starts`. */
  | FindMode;

const NORMAL: DocMode = { kind: "normal" };
const HEADINGS = "h1,h2,h3,h4,h5,h6,[role='heading'],[data-doc-heading]";
/** A long quote is cut, as the chat input is no place for a whole article, and the backend refuses more. */
const MAX_QUOTE = 4000;
/** Text a reader does not start from when `v` looks for where they are reading. */
const CHROME = "nav,header,footer,aside,[role='navigation'],[role='banner'],[role='contentinfo']";

const BLUR_MS = 100;
/** What the find bar covers of the bottom of the view. */
const BAR_HEIGHT = 48;

function viewOf(scroller: Element | null): View {
  return scroller && scroller !== document.scrollingElement ? scroller.getBoundingClientRect() : { top: 0, left: 0, bottom: innerHeight, right: innerWidth };
}

/** Whether `el` stays where it is as `scroller` moves what is under it. */
function staysPut(el: Element, scroller: Element | null): boolean {
  for (let at: Element | null = el; at !== scroller; at = at.parentElement) {
    // Up past the top without meeting the scroller: it is outside, like an app's top bar.
    if (!at || /fixed|sticky/.test(getComputedStyle(at).position)) {
      return true;
    }
  }
  return false;
}

const meets = (r: DOMRect, v: View) => r.height > 0 && r.bottom > v.top && r.top < v.bottom && r.right > v.left && r.left < v.right;

/** Where the reader is: the first text on screen, the page's own header and menus only if there is nothing else. */
function firstVisibleText(nodes: Text[], v: View): TextPoint | null {
  const r = document.createRange();
  const shown = nodes.filter((n) => {
    r.selectNodeContents(n);
    return meets(r.getBoundingClientRect(), v);
  });
  const node = shown.find((n) => !n.parentElement?.closest(CHROME)) ?? shown[0];
  return node ? { node, offset: firstVisibleOffset(node, v.top) } : null;
}

/** `host`: as it is now, since the app's closures change with each render. */
export function createDocNav(host: () => DocHost) {
  let mode: DocMode = NORMAL;
  let ui: DocUi | null = null;
  /** What `n` and `N` look for: the query last kept with Enter. */
  let lastQuery = "";
  /** The heading `]]` went to last and where that left it: a scroll margin or the document's end can stop it below the top, and while it stays there the next one must still be next. */
  let lastHeading: { el: Element; top: number } | null = null;
  /** The last walk of a document whose host says when its text changes: on a long PDF one takes over 100 ms, and `/`, `n` and `N` each need it. */
  let walked: { root: Element; version: number; doc: DocText } | null = null;

  function walkOf(root: Element): DocText {
    const version = host().textVersion?.();
    if (version === undefined) {
      return docText(root);
    }
    if (walked?.root !== root || walked.version !== version) {
      walked = { root, version, doc: docText(root) };
    }
    return walked.doc;
  }

  const selection = () => window.getSelection()!;

  /** The find with its match still in the document: a page's scripts and a translation replace text under an open bar. */
  function current(m: FindMode): FindMode {
    if (m.at < 0 || matchIsLive(m.doc, m.starts[m.at]!, m.length)) {
      return m;
    }
    const root = host().root();
    if (!root) {
      return { ...m, starts: [], at: -1 };
    }
    walked = null;
    const doc = walkOf(root);
    const origin = m.origin?.node.isConnected ? m.origin : firstVisibleText(doc.nodes, viewOf(host().scroller()));
    const { starts, length } = matchesIn(doc.text, m.query);
    return { ...m, doc, origin, starts, length, at: pickMatch(starts, indexOfScreen(doc, origin), 1) };
  }

  function draw() {
    if (mode.kind === "hints") {
      const { typed } = mode;
      ui?.labels(
        mode.targets
          .filter((t) => t.label.startsWith(typed))
          .flatMap((t) => {
            const rect = t.rect();
            return rect ? [{ label: t.label, rect }] : [];
          }),
      );
    } else if (mode.kind === "caret") {
      ui?.badge("CARET", viewOf(host().scroller()));
    } else if (mode.kind === "visual") {
      ui?.badge(mode.line ? "V-LINE" : "VISUAL", viewOf(host().scroller()));
    } else if (mode.kind === "find") {
      mode = current(mode);
      ui?.boxes(mode.at >= 0 ? Array.from(rangeAt(mode.doc, mode.starts[mode.at]!, mode.length).getClientRects()) : []);
      mode.count.textContent = mode.query.trim() ? `${mode.at + 1}/${mode.starts.length}` : "";
    }
  }

  // Whatever takes the keyboard or the pointer away ends a mode: one left behind would eat the keys of whatever is focused next.
  function onPress(e: Event) {
    if (e.composedPath()[0] !== ui?.host) {
      endFind(true);
      enter(NORMAL);
    }
  }
  // Not at once: WebView2 takes the keyboard away and gives it back as it shows a page again.
  function onBlur() {
    window.setTimeout(() => {
      // A frame with the keyboard shows only here: this window sees no press in it, and `hasFocus` stays true.
      if (!document.hasFocus() || document.activeElement?.matches("iframe,frame,object,embed")) {
        endFind(true);
        enter(NORMAL);
      }
    }, BLUR_MS);
  }
  const onMoved = () => draw();

  function listen(on: boolean) {
    const change = on ? window.addEventListener.bind(window) : window.removeEventListener.bind(window);
    change("pointerdown", onPress, true);
    change("blur", onBlur);
    change("scroll", onMoved, true);
    change("resize", onMoved);
  }

  /** What the modes draw in, there while one is on. */
  function openUi(): DocUi {
    if (!ui) {
      listen(true);
      ui = createUi();
    }
    return ui;
  }

  function enter(next: DocMode) {
    mode = next;
    if (next.kind !== "normal") {
      openUi();
      draw();
    } else if (ui) {
      listen(false);
      ui.remove();
      ui = null;
    }
  }

  // ---- moving the view -----------------------------------------------------------------------

  /** Brings `rect` into view above `covered`, `margin` from the edge it came in by. */
  function reveal(rect: DOMRect | null, margin: number, covered = 0) {
    const scroller = host().scroller();
    if (!rect || !scroller) {
      return;
    }
    const v = viewOf(scroller);
    const bottom = v.bottom - covered;
    // A pixel's grace: a box lined up with the edge is often a fraction of one over it.
    const top = rect.top < v.top - 1 ? rect.top - v.top - margin : rect.bottom > bottom + 1 ? rect.bottom - bottom + margin : 0;
    // A margin taken from the height can be wider than a narrow pane, and would carry the box past the other edge.
    const side = Math.min(margin, (v.right - v.left) / 2);
    const left = rect.left < v.left - 1 ? rect.left - v.left - side : rect.right > v.right + 1 ? rect.right - v.right + side : 0;
    if (top || left) {
      scroller.scrollBy({ top, left, behavior: "instant" });
    }
  }

  /**
   * Brings a match's first line past the edge of a box a reader can scroll (a code block) into it. `scrollIntoView` leaves an element that already fills its box, as a long line's does, and a box that cuts its text off (an ellipsis) has no way back.
   * shortcut: a box also moves for a fixed child, which it cannot bring any nearer, upgrade if a page's nav turns out to live in one.
   */
  function revealInBoxes(r: Range, scroller: Element | null) {
    for (let el = r.startContainer.parentElement; el && el !== scroller; el = el.parentElement) {
      const rect = r.getClientRects()[0];
      if (!rect) {
        return;
      }
      const box = el.getBoundingClientRect();
      const outX = rect.left < box.left - 1 || rect.right > box.right + 1;
      const outY = rect.top < box.top - 1 || rect.bottom > box.bottom + 1;
      if (outX || outY) {
        const { overflowX, overflowY } = getComputedStyle(el);
        el.scrollBy({
          left: outX && /auto|scroll/.test(overflowX) ? rect.left + rect.width / 2 - (box.left + box.width / 2) : 0,
          top: outY && /auto|scroll/.test(overflowY) ? rect.top + rect.height / 2 - (box.top + box.height / 2) : 0,
          behavior: "instant",
        });
      }
    }
  }

  /** Moves the view only for a match a reader cannot see: off screen, under a header, or past the edge of a box that scrolls by itself. */
  function revealRange(r: Range) {
    const scroller = host().scroller();
    revealInBoxes(r, scroller);
    /** What is on top at the middle of the match's first line (of all its lines, that is the gap between two): a reader sees the match if that holds or is part of it, and not if it is a header over it. */
    const onTop = () => {
      const rect = r.getClientRects()[0];
      return rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null;
    };
    const over = onTop();
    // Not what holds the scroller, which shows beside a box that does not fill the window: a match that lands on it is cut off.
    if (over && r.intersectsNode(over) && (over === scroller || !over.contains(scroller))) {
      return;
    }
    r.startContainer.parentElement?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    const v = viewOf(scroller);
    reveal(r.getBoundingClientRect(), (v.bottom - v.top) / 2, BAR_HEIGHT);
    // Under a sticky header a match is in view to all of the above, and a reader still cannot see it. Other boxes on top (a PDF's translated region) leave it readable.
    const still = onTop();
    if (still && !r.intersectsNode(still) && staysPut(still, scroller)) {
      scroller?.scrollBy({ top: r.getBoundingClientRect().top - v.top - (v.bottom - v.top) / 2, behavior: "instant" });
    }
  }

  function select(r: Range) {
    const s = selection();
    s.removeAllRanges();
    s.addRange(r);
  }

  function goHeading(dir: 1 | -1) {
    const root = host().root();
    if (!root) {
      return;
    }
    const all = Array.from(root.querySelectorAll(HEADINGS)).filter((h) => h.getClientRects().length > 0 && !h.closest("[data-lattice-ui]"));
    const top = viewOf(host().scroller()).top;
    const tops = all.map((h) => h.getBoundingClientRect().top - top);
    let i = dir > 0 ? tops.findIndex((t) => t > 2) : tops.findLastIndex((t) => t < -2);
    if (i >= 0 && lastHeading && all[i] === lastHeading.el && Math.abs(tops[i]! - lastHeading.top) < 2) {
      i += dir;
    }
    const to = all[i];
    if (to) {
      to.scrollIntoView({ block: "start", behavior: "instant" });
      lastHeading = { el: to, top: to.getBoundingClientRect().top - top };
    }
  }

  // ---- hints -----------------------------------------------------------------------------------

  function startHints(targets: Target[], newTab: boolean) {
    const labels = hintLabels(targets.length);
    if (targets.length) {
      enter({ kind: "hints", typed: "", newTab, targets: targets.map((t, i) => ({ ...t, label: labels[i]! })) });
    }
  }

  function hintKey(m: Extract<DocMode, { kind: "hints" }>, key: string): boolean {
    if (isModified(key)) {
      enter(NORMAL);
      return false;
    }
    if (key === "Escape") {
      enter(NORMAL);
    } else if (key === "Backspace") {
      enter({ ...m, typed: m.typed.slice(0, -1) });
    } else if (isPrintable(key)) {
      const typed = m.typed + key.slice(-1);
      const left = m.targets.filter((t) => t.label.startsWith(typed));
      if (left.length === 1) {
        enter(NORMAL);
        left[0]!.pick(m.newTab);
      } else if (left.length) {
        enter({ ...m, typed });
      }
    }
    return true;
  }

  function startWordHints() {
    const root = host().root();
    if (!root) {
      return;
    }
    const scroller = host().scroller();
    const targets = visibleWords(root).map((range): Target => ({
      rect: () => {
        const r = range.getClientRects()[0];
        // Against the box that scrolls the word: a page's header and sidebar are outside the scroller and on screen.
        return r && meets(r, viewOf(scroller?.contains(range.startContainer) ? scroller : null)) ? r : null;
      },
      pick: () => {
        select(range);
        enterVisual();
      },
    }));
    startHints(targets, false);
  }

  // ---- caret and visual ------------------------------------------------------------------------

  /** One callback for whichever use asks first: the find open when text comes is the one to go on with it. */
  function onMoreText() {
    const root = host().root();
    if (mode.kind === "find" && root) {
      const m = { ...mode, doc: walkOf(root) };
      if (m.query.trim()) {
        search(m, m.query);
      } else {
        mode = m;
      }
    }
  }
  const askAllText = () => host().allText?.(onMoreText);

  function enterVisual() {
    askAllText();
    enter({ kind: "visual", line: null, g: false });
  }

  function startVisual() {
    const root = host().root();
    if (!root) {
      return;
    }
    const s = selection();
    const view = viewOf(host().scroller());
    // What is already selected and on screen (a kept match, the mouse's) is where to go on from.
    if (s.toString() && root.contains(s.anchorNode) && meets(s.getRangeAt(0).getBoundingClientRect(), view)) {
      return enterVisual();
    }
    const at = firstVisibleText(textNodes(root), view);
    if (at) {
      s.collapse(at.node, at.offset);
      showBlock(s, root);
      askAllText();
      enter({ kind: "caret", g: false });
    }
  }

  function moveBy(m: Extract<DocMode, { kind: "caret" | "visual" }>, seq: string) {
    const motion = MOTIONS[seq];
    const root = host().root();
    if (!motion || !root) {
      return;
    }
    const s = selection();
    const [a, ao, f, fo] = [s.anchorNode, s.anchorOffset, s.focusNode, s.focusOffset];
    if (m.kind === "caret") {
      s.collapseToStart();
      motion(s, "move", root);
      // Out of the document it would step back in at some other place: the check below puts the caret back where it was.
      if (root.contains(s.focusNode)) {
        showBlock(s, root);
      }
    } else {
      motion(s, "extend", root);
      if (m.line) {
        shapeLines(s, m.line);
      } else if (!s.toString()) {
        showBlock(s, root);
      }
    }
    // `j` from the Reader's last line would land in the next pane, `k` from a PDF's first on the viewer's own controls.
    const at = s.focusNode instanceof Element ? s.focusNode : s.focusNode?.parentElement;
    if (a && f && (!root.contains(s.focusNode) || at?.closest("[data-lattice-ui]"))) {
      s.setBaseAndExtent(a, ao, f, fo);
    }
    reveal(focusRect(s), 40);
  }

  function modeKey(m: Extract<DocMode, { kind: "caret" | "visual" }>, key: string): boolean {
    const s = selection();
    // The page itself may have cleared the selection.
    if (isModified(key) || !s.rangeCount) {
      enter(NORMAL);
      return false;
    }
    if (key === "Escape") {
      s.collapseToStart();
      enter(NORMAL);
      return true;
    }
    if (!isPrintable(key)) {
      return false;
    }
    if (m.g) {
      moveBy(m, `G ${key}`);
      enter({ ...m, g: false });
    } else if (key === "G") {
      enter({ ...m, g: true });
    } else if (key === "V") {
      if (m.kind === "caret" || m.line) {
        enter({ kind: "visual", line: null, g: false });
      } else {
        s.collapse(s.focusNode, s.focusOffset);
        const root = host().root();
        if (root) {
          showBlock(s, root);
        }
        enter({ kind: "caret", g: false });
      }
    } else if (key === "Shift+V") {
      if (m.kind === "visual" && m.line) {
        enter({ ...m, line: null });
      } else {
        enter({ kind: "visual", line: lineAtFocus(s), g: false });
      }
    } else if (m.kind === "visual" && key === "Y") {
      // oxlint-disable-next-line typescript/no-deprecated -- `navigator.clipboard` fails on a page that is plain http or forbids it, and this key press is permission enough
      document.execCommand("copy");
      s.collapseToStart();
      enter(NORMAL);
    } else if (m.kind === "visual" && key === "S") {
      if (isWord(s.toString())) {
        enter(NORMAL);
        host().saveWord();
      }
    } else if (m.kind === "visual" && key === "A") {
      const quote = collapse(s.toString()).slice(0, MAX_QUOTE).toWellFormed();
      enter(NORMAL);
      host().ask(quote);
    } else {
      moveBy(m, key);
    }
    return true;
  }

  // ---- find ------------------------------------------------------------------------------------

  const indexOfScreen = (doc: DocText, first: TextPoint | null) => (first && indexOfPoint(doc, first.node, first.offset)) ?? 0;

  /** Where to look from: the selection's far end, if it is in this document, else the first text on screen. */
  function originIn(doc: DocText, dir: 1 | -1, root: Element): number {
    const s = selection();
    if (s.rangeCount && root.contains(s.anchorNode)) {
      const r = s.getRangeAt(0);
      const at = dir > 0 ? indexOfPoint(doc, r.endContainer, r.endOffset) : indexOfPoint(doc, r.startContainer, r.startOffset);
      if (at != null) {
        return at;
      }
    }
    return indexOfScreen(doc, firstVisibleText(doc.nodes, viewOf(host().scroller())));
  }

  /** Shows the query's match nearest the origin, or the place the find began without one. */
  function search(m: Extract<DocMode, { kind: "find" }>, query: string) {
    const { starts, length } = matchesIn(m.doc.text, query);
    enter({ ...m, query, starts, length, at: pickMatch(starts, indexOfScreen(m.doc, m.origin), 1) });
    // Drawing it has walked the text again if that had changed, so what to show is in `mode` now.
    if (mode.kind === "find" && mode.at >= 0) {
      revealRange(rangeAt(mode.doc, mode.starts[mode.at]!, mode.length));
      draw();
    } else {
      backToPlace(m.place);
    }
  }

  function backToPlace(place: Place) {
    // The viewport too: a match's scrollIntoView moves one with overflow hidden, which the reader cannot scroll back.
    window.scrollTo({ top: place.pageTop, left: place.pageLeft, behavior: "instant" });
    host().scroller()?.scrollTo({ top: place.top, left: place.left, behavior: "instant" });
  }

  function endFind(keep: boolean) {
    if (mode.kind !== "find") {
      return;
    }
    const m = current(mode);
    const active = document.activeElement;
    // An app key may have moved the keyboard on: it stays there, where a selection of ours would also take the caret out of a field and drop what is typed.
    const moved = active !== ui?.host && active !== document.body;
    const barHadKeys = active === ui?.host && document.hasFocus();
    enter(NORMAL);
    if (barHadKeys && m.place.focus instanceof HTMLElement) {
      m.place.focus.focus({ preventScroll: true });
    }
    const kept = keep && m.at >= 0;
    if (kept) {
      lastQuery = m.query;
    } else if (!keep) {
      // Only Esc: `search` went back already for a query with no match, and a press must not move what is under the pointer.
      backToPlace(m.place);
    }
    if (!moved) {
      const s = selection();
      s.removeAllRanges();
      (kept ? [rangeAt(m.doc, m.starts[m.at]!, m.length)] : m.place.ranges).forEach((r) => s.addRange(r));
    }
  }

  function startFind() {
    const root = host().root();
    if (!root) {
      return;
    }
    const s = selection();
    const scroller = host().scroller();
    const view = viewOf(scroller);
    const place: Place = {
      ranges: Array.from({ length: s.rangeCount }, (_, i) => s.getRangeAt(i)),
      top: scroller?.scrollTop ?? 0,
      left: scroller?.scrollLeft ?? 0,
      pageTop: window.scrollY,
      pageLeft: window.scrollX,
      focus: document.activeElement,
    };
    const { input, count } = openUi().bar(host().findLabel(), view);
    const doc = walkOf(root);
    enter({ kind: "find", query: "", doc, origin: firstVisibleText(doc.nodes, view), starts: [], length: 0, at: -1, place, input, count });
    input.addEventListener("input", () => {
      if (mode.kind === "find") {
        search(mode, input.value);
      }
    });
    input.addEventListener("keydown", (e) => {
      // This keeps what is typed here from the app and from a page's bubbling listeners. A page's capture listeners
      // have already seen the key. A Ctrl key goes on, since the app's run in fields too.
      if (e.isComposing || !(e.ctrlKey || e.altKey || e.metaKey)) {
        e.stopPropagation();
      }
      if (e.isComposing) {
        return;
      }
      if (e.key === "Escape" || e.key === "Enter") {
        e.preventDefault();
        endFind(e.key === "Enter");
      }
    });
    for (const type of ["keyup", "keypress"]) {
      input.addEventListener(type, (e) => e.stopPropagation());
    }
    input.addEventListener("blur", () => {
      window.setTimeout(() => {
        if (document.activeElement !== ui?.host) {
          endFind(true);
        }
      }, BLUR_MS);
    });
    // The key that opened the bar may still have its character on the way, which would land here.
    const eat = (e: Event) => e.preventDefault();
    input.addEventListener("keypress", eat, { once: true });
    input.addEventListener("keydown", () => input.removeEventListener("keypress", eat), { once: true });
    input.focus({ preventScroll: true });
    askAllText();
  }

  function repeatFind(dir: 1 | -1) {
    const root = host().root();
    if (!root || !lastQuery) {
      return;
    }
    const doc = walkOf(root);
    const { starts, length } = matchesIn(doc.text, lastQuery);
    const at = pickMatch(starts, originIn(doc, dir, root), dir);
    if (at >= 0) {
      const r = rangeAt(doc, starts[at]!, length);
      select(r);
      revealRange(r);
    }
  }

  // ---- what hosts call -------------------------------------------------------------------------

  const RUNS: Partial<Record<DocActionId, () => void>> = {
    docFind: startFind,
    findNext: () => repeatFind(1),
    findPrev: () => repeatFind(-1),
    hints: () => startHints(linkTargetsIn(), false),
    hintsNew: () => startHints(linkTargetsIn(), true),
    wordHints: startWordHints,
    visual: startVisual,
    nextHeading: () => goHeading(1),
    prevHeading: () => goHeading(-1),
    focusInput: () => {
      const root = host().root();
      (root && firstField(root))?.focus();
    },
    docBack: () => host().history(-1),
    docForward: () => host().history(1),
    print: () => host().print(),
    // What Ctrl+A does by itself, for a page that did not get the key: in its focused field, else the whole document.
    selectAll: () => {
      let field = document.activeElement;
      // A page's own components keep their focused field inside an open shadow root.
      while (field?.shadowRoot?.activeElement) {
        field = field.shadowRoot.activeElement;
      }
      if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
        field.select();
        return;
      }
      const root = field instanceof HTMLElement && field.isContentEditable ? field : host().root();
      if (root) {
        selection().selectAllChildren(root);
      }
    },
  };

  function linkTargetsIn() {
    const root = host().root();
    return root ? linkTargets(root) : [];
  }

  return {
    /** Runs one of the document's own actions; any other id does nothing, as a page may call this itself. */
    run(id: DocActionId, count: number) {
      // Ahead of NORMAL, which would close the find bar that Ctrl+A selects in.
      if (id === "selectAll" && mode.kind === "find") {
        mode.input.select();
        return;
      }
      enter(NORMAL);
      if (isDocScroll(id)) {
        const el = host().scroller();
        if (el) {
          scrollDoc(el, id, count);
        }
      } else {
        RUNS[id]?.();
      }
    },
    /** Whether the key was the mode's: the host then swallows it and goes no further. The find bar reads its own keys. */
    onKey: (key: string): boolean =>
      mode.kind === "hints" ? hintKey(mode, key) : mode.kind === "caret" || mode.kind === "visual" ? modeKey(mode, key) : false,
  };
}
