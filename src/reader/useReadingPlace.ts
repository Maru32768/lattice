import { useLayoutEffect, useRef } from "react";

/**
 * Where each tab's Reader was when it went away. A pane that moves in the layout tree (split, close) and a tab shown again
 * (a tab switch, a swap) build their Reader anew, often in another width, which moves the text: so the place is a block and
 * how far into it the view starts. `block` is null above the first block, in the article's header, where `at` is a scrollTop.
 * shortcut: a Reader hidden under the zoom has no place to read and comes back at its top, upgrade if closing a zoomed pane proves common.
 */
const places = new Map<number, { article: number; seq: number | undefined; block: string | null; at: number }>();

/**
 * Keeps tab `tab`'s place in `article` across a remount, for the scroller given the ref it returns.
 * A new jump request (`seq`) is where the reader asked to go, so it replaces the place.
 */
export function useReadingPlace(tab: number, article: number, seq: number | undefined) {
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const view = scroller.current;
    if (!view) {
      return;
    }
    const place = places.get(tab);
    places.delete(tab);
    if (place?.article === article && place.seq === seq) {
      const r = place.block && view.querySelector(`#${place.block}`)?.getBoundingClientRect();
      if (r) {
        view.scrollTop += r.top + place.at * r.height - view.getBoundingClientRect().top;
      } else if (!place.block) {
        view.scrollTop = place.at;
      }
    }
    return () => {
      const top = view.getBoundingClientRect().top;
      const block = [...view.querySelectorAll("[id^='b-']")].find((b) => b.getBoundingClientRect().bottom > top);
      const r = block?.getBoundingClientRect();
      places.set(
        tab,
        block && r && r.top <= top ? { article, seq, block: block.id, at: (top - r.top) / r.height } : { article, seq, block: null, at: view.scrollTop },
      );
    };
  }, [tab, article, seq]);
  return scroller;
}
