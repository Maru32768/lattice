import { test } from "node:test";
import assert from "node:assert/strict";
import { HISTORY_LIMIT, NO_HISTORY, arrived, canGo, go, placeDoc, placeKey, visit, type Place } from "./history.ts";
import { NO_FACETS } from "../library/library.ts";

const at = (screen: Place["screen"], extra: Partial<Place> = {}): Place => ({ screen, scope: { kind: "all" }, facets: NO_FACETS, ...extra });

test("visits stack up; the same place twice is one entry", () => {
  let h = visit(NO_HISTORY, at("library"));
  h = visit(h, at("library"));
  h = visit(h, at("jobs"));
  assert.deepEqual(h.stack.map((p) => p.screen), ["library", "jobs"]);
  assert.equal(h.at, 1);
});

test("back and forward move the cursor and stop at the ends; a new visit drops what was ahead", () => {
  let h = [at("library"), at("jobs"), at("feeds")].reduce(visit, NO_HISTORY);
  assert.equal(canGo(h, 1), false);
  h = go(h, -1)!;
  h = go(h, -1)!;
  assert.equal(h.stack[h.at].screen, "library");
  assert.equal(go(h, -1), null);
  h = go(h, 1)!;
  assert.equal(h.stack[h.at].screen, "jobs");
  h = visit(h, at("settings", { section: "translation" }));
  assert.deepEqual(h.stack.map((p) => p.screen), ["library", "jobs", "settings"]);
  assert.equal(canGo(h, 1), false);
});

test("the stack is bounded: the oldest entries go", () => {
  let h = NO_HISTORY;
  for (let i = 0; i < HISTORY_LIMIT + 10; i++) h = visit(h, at("library", { scope: { kind: "feed", id: i } }));
  assert.equal(h.stack.length, HISTORY_LIMIT);
  assert.deepEqual(h.stack[0].scope, { kind: "feed", id: 10 });
  assert.equal(h.at, HISTORY_LIMIT - 1);
});

test("where a step arrived replaces its entry instead of cutting the forward ones", () => {
  let h = [at("library"), at("jobs")].reduce(visit, NO_HISTORY);
  h = go(h, -1)!;
  h = arrived(h, at("library", { scope: { kind: "favorites" } }));
  assert.deepEqual(h.stack.map((p) => p.screen), ["library", "jobs"]);
  assert.deepEqual(h.stack[0].scope, { kind: "favorites" });
  assert.equal(canGo(h, 1), true);
});

test("a page's document is its explicit navigation, not where the page moved on its own", () => {
  const page = { kind: "page" as const, id: 4, key: "k", url: "https://a.example/", title: "", seq: 2, loading: false, saved: null };
  const moved = { ...page, url: "https://a.example/next" };
  assert.equal(placeDoc(page).key, placeDoc(moved).key);
  assert.notEqual(placeDoc(page).key, placeDoc({ ...page, seq: 3 }).key);
  assert.equal(placeKey(at("library", { doc: placeDoc({ kind: "reader", id: 1, articleId: 7 }) })), placeKey(at("library", { doc: placeDoc({ kind: "reader", id: 9, articleId: 7 }) })));
});
