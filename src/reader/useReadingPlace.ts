import { useLayoutEffect, useRef } from "react";
import { blockOf, isReadingPlace, keepOnRest, needle, placeIn, placeStore, scrollFor, type ReadingPlace } from "../lib/places";
import { useLatest } from "../lib/useLatest";
import { TRANSLATABLE } from "./mixed";
import { roomOf } from "./stickies";

/** Each article's place on this device, for the Reader and the Page view: an article opens where it was left, also after a restart. */
export const readingPlaces = placeStore<ReadingPlace>("lattice.readingPlaces", 500, isReadingPlace);

/**
 * Where each tab's Reader was when it went away. A pane that moves in the layout tree (split, close) and a tab shown again
 * (a tab switch, a swap) build their Reader anew, often in another width, which moves the text: so the place is a block and
 * how far into it the view starts. `place` is null above the first block, in the article's header, where `top` is a scrollTop.
 * Kept apart from `readingPlaces` as the same article may be open in two tabs at two places.
 * shortcut: a Reader hidden under the zoom has no place to read and comes back at its top, upgrade if closing a zoomed pane proves common.
 */
const places = new Map<number, { article: number; seq: number | undefined; place: ReadingPlace | null; top: number; t: number }>();

/** The tab's Page view read `article` back to the top: the tab's Reader of it starts there too. */
export const forgetTabPlace = (tab: number, article: number) => places.get(tab)?.article === article && places.delete(tab);

/**
 * Keeps tab `tab`'s place in `article` across a remount, and the article's place across opening it again, for the scroller
 * given the ref it returns. A new jump request (`seq`) is where the reader asked to go, so it replaces the place.
 */
export function useReadingPlace(tab: number, article: number, seq: number | undefined, blocks: { id: number; text: string; kind: string }[]) {
  const scroller = useRef<HTMLDivElement>(null);
  const shown = useLatest(blocks);
  useLayoutEffect(() => {
    const view = scroller.current;
    if (!view) {
      return;
    }
    /** False when the place's block is not in this article (any more). */
    const goTo = (place: ReadingPlace) => {
      const b = blockOf(shown.current, place);
      const el = b && view.querySelector(`#b-${b.id}`);
      if (el) {
        view.scrollTop += scrollFor(el, place, view.getBoundingClientRect().top);
      }
      return !!el;
    };
    const kept = places.get(tab);
    places.delete(tab);
    const mine = kept?.article === article && kept.seq === seq ? kept : undefined;
    // The article's own place: for a tab that had none, and after the Page view read on (a place with no block id). Another
    // Reader tab's place does not move this one. A tie is no older (the e2e clock stands still).
    const stored = seq === undefined ? readingPlaces.get(String(article)) : undefined;
    // A place the article does not have (a Page view's from a part of the page the Reader lacks) leaves the tab's own.
    const preferred = !!stored && (!mine || (stored.block === undefined && stored.t >= mine.t));
    const wentToStored = preferred && goTo(stored);
    if (!wentToStored && mine?.place) {
      goTo(mine.place);
    } else if (!wentToStored && mine) {
      view.scrollTop = mine.top;
    }
    /**
     * The blocks and the view's top as they would be on screen without the stickies' room under blocks: a place must be
     * good where there are none (the Page view, the phone, a wider pane). In such room the top is the end of the block
     * above, where its cards start.
     */
    const measure = () => {
      const els = [...view.querySelectorAll<HTMLElement>("[id^='b-']")];
      const viewTop = view.getBoundingClientRect().top;
      let top: number | undefined;
      let rooms = 0;
      const boxes = new Map<HTMLElement, { top: number; bottom: number; height: number }>();
      for (const el of els) {
        const r = el.getBoundingClientRect();
        const room = roomOf(el);
        if (top === undefined && viewTop < r.bottom + room) {
          top = (room ? Math.min(viewTop, r.bottom - 1) : viewTop) - rooms;
        }
        boxes.set(el, { top: r.top - rooms, bottom: r.bottom - rooms, height: r.height });
        rooms += room;
      }
      return { els, top: top ?? viewTop - rooms, boxOf: (el: HTMLElement) => boxes.get(el)! };
    };
    const placeAt = (prose: boolean) => {
      const { els, top, boxOf } = measure();
      const blockAt = (el: HTMLElement) => shown.current.find((b) => el.id === `b-${b.id}` && (!prose || TRANSLATABLE.has(b.kind)));
      // Stickies beside the text can go on below it, and the view with them, past the last block: the place is then that block's end.
      const last = prose ? undefined : els.findLast((el) => blockAt(el)?.text.trim());
      return placeIn(els, last ? Math.min(top, boxOf(last).bottom - 1) : top, blockAt, boxOf);
    };
    // A place this Reader could not show (the Page view's, from a part of the page it lacks; or an article without
    // text) is still the article's until the reader moves to another block: leaving at once must not put this Reader's
    // top over it. By the block, not the scrollTop, which moves by itself as blocks above grow (a translation arriving);
    // once moved, back at that block is a place of the reader's too.
    let unshown = preferred && !wentToStored;
    const shownBlock = unshown ? placeAt(false)?.block : undefined;

    /** The place on screen, kept for the article; undefined while the Reader is hidden and has none to read. */
    const keep = () => {
      if (view.clientHeight === 0) {
        return undefined;
      }
      // The block at the top, whatever it is: a code block keeps its height at another width, which a paragraph below it
      // does not. The Page view also gets the first prose block from the top when that block is not prose: a page has
      // the same paragraphs, but no code block it can find (pre is not translated) and seldom a table's cells.
      const place = placeAt(false);
      // No prose below (an article that ends in a listing): the last prose above, which the line has gone past.
      const proseAbove = () => {
        const { els, top, boxOf } = measure();
        let last: { text: string; at: number } | null = null;
        for (const el of els) {
          const r = boxOf(el);
          if (r.bottom > top) {
            break;
          }
          const b = shown.current.find((x) => el.id === `b-${x.id}` && TRANSLATABLE.has(x.kind));
          const text = b && needle(b.text);
          if (text && r.height > 0) {
            last = { text, at: (top - r.top) / r.height };
          }
        }
        return last;
      };
      const prose = place && !TRANSLATABLE.has(shown.current.find((b) => b.id === place.block)?.kind ?? "") ? (placeAt(true) ?? proseAbove()) : null;
      if (place?.block !== shownBlock) {
        unshown = false;
      }
      if (!unshown) {
        readingPlaces.set(String(article), place && prose ? { ...place, page: { text: prose.text, at: prose.at } } : place);
      }
      return place;
    };
    const stop = keepOnRest(view, keep);
    return () => {
      stop();
      const place = keep();
      if (place !== undefined) {
        places.set(tab, { article, seq, place, top: view.scrollTop, t: Date.now() });
      }
    };
  }, [tab, article, seq, shown]);
  return scroller;
}
