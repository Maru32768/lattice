/**
 * Moving around a document by keys, without a mouse: hints, visual mode, find, headings. One per
 * document host: the app for the Reader and the chat log, the overlay for a page and the PDF viewer.
 * A host gives every key to `onKey` first, and runs the actions the key map names through `run`.
 *
 * The ideas come from Vimium's content scripts (MIT License, Copyright (c) 2010 Phil Crosby, Ilya Sukhar).
 */
import type { ActionId } from "../lib/keymap.ts";
import { hintLabels, linkTargets, type Target } from "./hints.ts";
import { isDocScroll, scrollDoc } from "./scroll.ts";
import { createUi, type DocUi } from "./ui.ts";

export interface DocHost {
  /** Where the document's text and links are; null with no document. */
  root(): Element | null;
  scroller(): Element | null;
  print(): void;
}

type Hint = Target & { label: string };

type DocMode = { kind: "normal" } | { kind: "hints"; typed: string; targets: Hint[]; newTab: boolean };

const NORMAL: DocMode = { kind: "normal" };

const BLUR_MS = 100;

const isModified = (key: string) => /^(Ctrl|Alt)\+/.test(key);
const isTyped = (key: string) => key.replace(/^Shift\+/, "").length === 1;

/** `host`: as it is now, since the app's closures change with each render. */
export function createDocNav(host: () => DocHost) {
  let mode: DocMode = NORMAL;
  let ui: DocUi | null = null;

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
    }
  }

  // Whatever takes the keyboard or the pointer away ends a mode: one left behind would eat the keys of whatever is focused next.
  function onPress(e: Event) {
    if (e.composedPath()[0] !== ui?.host) {
      enter(NORMAL);
    }
  }
  // Not at once: WebView2 takes the keyboard away and gives it back as it shows a page again.
  function onBlur() {
    window.setTimeout(() => {
      if (!document.hasFocus()) {
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
    } else if (isTyped(key)) {
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

  // ---- what hosts call -------------------------------------------------------------------------

  const RUNS: Partial<Record<ActionId, () => void>> = {
    hints: () => startHints(linkTargetsIn(), false),
    hintsNew: () => startHints(linkTargetsIn(), true),
    print: () => host().print(),
  };

  function linkTargetsIn() {
    const root = host().root();
    return root ? linkTargets(root) : [];
  }

  return {
    /** Runs one of the document's own actions; any other id does nothing, as a page may call this itself. */
    run(id: ActionId, count: number) {
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
    onKey: (key: string): boolean => (mode.kind === "hints" ? hintKey(mode, key) : false),
  };
}
