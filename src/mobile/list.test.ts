import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { FIRST_VIEW, PAGE, forgetListPlace, storeView, storedView, withoutGoneGroup, type ListView } from "./list.ts";
import { NO_FACETS, NO_KEPT, keep, viewKey } from "../library/library.ts";

const stored = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, v),
    removeItem: (k: string) => void stored.delete(k),
  },
});
beforeEach(() => stored.clear());

test("the phone shows the list it showed before the page was loaded again", () => {
  assert.equal(storedView(), FIRST_VIEW);
  const facets = { ...NO_FACETS, tags: ["rust"], tagMode: "any" as const };
  const view: ListView = { scope: { kind: "favorites" }, facets, query: "tok", shown: 3 * PAGE, kept: NO_KEPT };
  storeView({ ...view, kept: keep(NO_KEPT, viewKey(view.scope, facets), 42) });
  assert.deepEqual(storedView(), view, "the articles read from it are not kept, as on the PC");
  forgetListPlace();
  assert.equal(storedView(), FIRST_VIEW, "another library starts over");
});

test("the phone keeps a group's list, and leaves it when the PC deletes the group", () => {
  const view: ListView = { ...FIRST_VIEW, scope: { kind: "group", id: 7 }, shown: 2 * PAGE };
  storeView(view);
  assert.deepEqual(storedView(), view);
  const group = { id: 7, name: "DDIA", created_at: "2026-11-01T00:00:00Z", count: 0 };
  assert.equal(withoutGoneGroup(view, [group]), view, "an empty group is still there");
  assert.deepEqual(withoutGoneGroup(view, []), { ...view, scope: { kind: "all" }, shown: PAGE });
  assert.equal(withoutGoneGroup(FIRST_VIEW, []), FIRST_VIEW);
  stored.set("lattice.mobile.view", JSON.stringify({ ...FIRST_VIEW, facets: { ...NO_FACETS, groups: [7], tags: ["rust"] } }));
  assert.deepEqual(storedView().facets, { ...NO_FACETS, tags: ["rust"] }, "a group chosen as a filter, which the sheet no longer offers, is dropped");
});

test("a stored view of another shape is not shown", () => {
  const good = JSON.parse(JSON.stringify(FIRST_VIEW)) as Record<string, unknown>;
  for (const bad of [
    { ...good, scope: { kind: "genre", name: "x" } },
    { ...good, scope: { kind: "group", id: "7" } },
    { ...good, facets: { ...NO_FACETS, tags: "rust" } },
    { ...good, shown: "100" },
    { ...good, query: null },
  ]) {
    stored.set("lattice.mobile.view", JSON.stringify(bad));
    assert.equal(storedView(), FIRST_VIEW, JSON.stringify(bad));
  }
  stored.set("lattice.mobile.view", "{");
  assert.equal(storedView(), FIRST_VIEW);
});
