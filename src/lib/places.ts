/**
 * Where the reader left lists and articles, kept on this device (localStorage). Each kind is one storage key holding its
 * most recent places, so a library of thousands does not grow it without end. Read again on every call: another window
 * of the app writes the same key.
 */
export function placeStore<T>(storageKey: string, cap: number, valid: (v: unknown) => v is T) {
  const read = (): [string, T][] => {
    try {
      const all: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
      return Array.isArray(all) ? all.filter((e): e is [string, T] => Array.isArray(e) && typeof e[0] === "string" && valid(e[1])) : [];
    } catch {
      return []; // blocked storage, or a value an older version wrote
    }
  };
  return {
    get: (key: string): T | undefined => read().find(([k]) => k === key)?.[1],
    /** `null` forgets the place: the list or article opens at its top. */
    set(key: string, value: T | null) {
      const kept = read().filter(([k]) => k !== key);
      if (value) {
        kept.push([key, value]);
      }
      try {
        localStorage.setItem(storageKey, JSON.stringify(kept.slice(-cap)));
      } catch {
        // Blocked or full storage: the place lasts until the view goes away.
      }
    },
    clear() {
      try {
        localStorage.removeItem(storageKey);
      } catch {
        // Blocked storage holds nothing.
      }
    },
  };
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * A place in an article, shared by the Reader, the Page view and the phone: the block at the top of the view, and how far
 * down it the top was (0 to 1; below 0 when the block starts lower). The Page view knows the block by its text only, so a
 * place is found by `block` when it still has that `text`, else by the text.
 */
export interface ReadingPlace {
  block?: number;
  text: string;
  at: number;
  /** When it was taken (ms): of two places, the newer one wins. */
  t: number;
}

export const isReadingPlace = (v: unknown): v is ReadingPlace =>
  isObj(v) && typeof v.text === "string" && v.text !== "" && isNum(v.at) && isNum(v.t) && (v.block === undefined || isNum(v.block));

/** The start of a block's text, spaces collapsed: what a place knows the block by. */
export const needle = (s: string) => s.replace(/\s+/gu, " ").trim().slice(0, 80);

/** The block a place names: the same id and text, else the first with that start, else the first that contains it. */
export function blockOf<B extends { id: number; text: string }>(blocks: B[], place: ReadingPlace): B | undefined {
  return (
    blocks.find((b) => b.id === place.block && needle(b.text) === place.text) ??
    blocks.find((b) => needle(b.text) === place.text) ??
    blocks.find((b) => b.text.replace(/\s+/gu, " ").includes(place.text))
  );
}

/**
 * The place of a view whose top edge is at `top` (client px), among `els`, its blocks in document order: the first with
 * text that reaches below the edge. Null above the first block, where the view opens anyway.
 */
export function placeIn(els: HTMLElement[], top: number, blockAt: (el: HTMLElement) => { id: number; text: string } | undefined): ReadingPlace | null {
  if (!els[0] || els[0].getBoundingClientRect().top > top) {
    return null;
  }
  for (const el of els) {
    const r = el.getBoundingClientRect();
    const b = r.bottom > top ? blockAt(el) : undefined;
    const text = b && needle(b.text);
    if (b && text) {
      return { block: b.id, text, at: r.height > 0 ? (top - r.top) / r.height : 0, t: Date.now() };
    }
  }
  return null;
}

/**
 * Calls `keep` once `target` has stopped scrolling for a moment, and as the page is hidden, which may be the last chance:
 * a phone drops pages in the background. Returns what stops it.
 */
export function keepOnRest(target: EventTarget, keep: () => void) {
  let timer = 0;
  const onScroll = () => {
    clearTimeout(timer);
    timer = window.setTimeout(keep, 300);
  };
  const onHide = () => {
    if (document.visibilityState === "hidden") {
      keep();
    }
  };
  target.addEventListener("scroll", onScroll, { passive: true });
  document.addEventListener("visibilitychange", onHide);
  return () => {
    clearTimeout(timer);
    target.removeEventListener("scroll", onScroll);
    document.removeEventListener("visibilitychange", onHide);
  };
}

/** How far to scroll down so that `place` in `el`, its block, is at `top` again. */
export function scrollFor(el: Element, place: ReadingPlace, top: number) {
  const r = el.getBoundingClientRect();
  return r.top + place.at * r.height - top;
}
