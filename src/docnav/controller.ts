/**
 * Moving around a document by keys, without a mouse. One per document host: the app for the Reader and
 * the chat log, the overlay for a page and the PDF viewer. A host runs the actions the key map names
 * through `run`.
 */
import type { ActionId } from "../lib/keymap.ts";
import { isDocScroll, scrollDoc } from "./scroll.ts";

export interface DocHost {
  /** Where the document's text and links are; null with no document. */
  root(): Element | null;
  scroller(): Element | null;
  print(): void;
}

/** `host`: as it is now, since the app's closures change with each render. */
export function createDocNav(host: () => DocHost) {
  return {
    /** Runs one of the document's own actions; any other id does nothing, as a page may call this itself. */
    run(id: ActionId, count: number) {
      if (id === "print") {
        host().print();
      } else if (isDocScroll(id)) {
        const el = host().scroller();
        if (el) {
          scrollDoc(el, id, count);
        }
      }
    },
  };
}
