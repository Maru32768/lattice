// In-app back / forward (H4): where the user was in the shell (screen, settings section, scope and
// facets, the focused tab's document), as a bounded stack with a cursor, like a browser's history.
import type { Facets, Scope } from "../library/library";
import type { Doc, Id, Tab } from "../layout/layout";
import type { Screen } from "../library/Nav";
import type { SettingsSection } from "../settings/SettingsView";

/** The focused tab and what it showed. `key` tells documents apart: a page by its explicit navigations (`seq`), not the page's own. */
export interface PlaceDoc {
  tab: Id;
  key: string;
  doc: Doc;
}

export interface Place {
  screen: Screen;
  /** Only on the settings screen. */
  section?: SettingsSection;
  scope: Scope;
  facets: Facets;
  doc?: PlaceDoc;
}

export interface History {
  stack: Place[];
  /** The current place in `stack`; -1 while empty. */
  at: number;
}

export const NO_HISTORY: History = { stack: [], at: -1 };
export const HISTORY_LIMIT = 50;

export const placeDoc = (t: Tab): PlaceDoc =>
  t.kind === "reader"
    ? { tab: t.id, key: `r${t.articleId}`, doc: { kind: "reader", articleId: t.articleId } }
    : { tab: t.id, key: `p${t.id}.${t.seq}`, doc: { kind: "page", url: t.url, title: t.title, saved: t.saved } };

/** Two places are the same visit when this is equal. */
export const placeKey = (p: Place) => JSON.stringify([p.screen, p.section ?? null, p.scope, p.facets, p.doc?.key ?? null]);

/** A new place: the forward entries go, the oldest beyond the limit too; the same place again is no new entry. */
export function visit(h: History, p: Place): History {
  const cur = h.stack[h.at];
  if (cur && placeKey(cur) === placeKey(p)) {
    return h;
  }
  const stack = [...h.stack.slice(0, h.at + 1), p].slice(-HISTORY_LIMIT);
  return { stack, at: stack.length - 1 };
}

/** Where a back / forward step actually arrived (a document may reopen under a new key): it takes the current entry's place. */
export function arrived(h: History, p: Place): History {
  if (h.at < 0) {
    return visit(h, p);
  }
  return { ...h, stack: h.stack.map((x, i) => (i === h.at ? p : x)) };
}

/** One step back (-1) or forward (1); null at either end. */
export function go(h: History, d: 1 | -1): History | null {
  const at = h.at + d;
  return at >= 0 && at < h.stack.length ? { ...h, at } : null;
}

export const canGo = (h: History, d: 1 | -1) => go(h, d) != null;
