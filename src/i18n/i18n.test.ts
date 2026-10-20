import { test } from "node:test";
import assert from "node:assert/strict";
import { ja } from "./ja.ts";
import { en } from "./en.ts";
import { translatorFor, type Key } from "./index.ts";

const JAPANESE = /[぀-ヿ㐀-鿿]/;
const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test("en has every key of ja, with the same params", () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ja).sort());
  for (const key of Object.keys(ja) as Key[]) {
    const params = names(ja[key]);
    const m = en[key] as string | ((p: Record<string, number>) => string);
    if (typeof m === "string") assert.deepEqual(names(m), params, key);
    else for (const n of [1, 2]) {
      const out = m(Object.fromEntries(params.map((p) => [p, n])));
      assert.ok(out && !/\{\w+\}/.test(out), `${key}: ${out}`);
    }
  }
});

test("English text has no Japanese in it", () => {
  const en_ = translatorFor("en");
  const leaks = (Object.keys(ja) as Key[]).filter((k) => {
    const params = Object.fromEntries(names(ja[k]).map((p) => [p, 2]));
    return JAPANESE.test((en_ as (k: Key, p: object) => string)(k, params));
  });
  assert.deepEqual(leaks, []);
});

test("t fills params, formats numbers per language and pluralizes English", () => {
  const [tj, te] = [translatorFor("ja"), translatorFor("en")];
  assert.equal(te("settingsView.models", { length: 1 }), "1 model");
  assert.equal(te("settingsView.models", { length: 1200 }), "1,200 models");
  assert.equal(tj("language.title"), "表示言語");
  assert.equal(te("language.title"), "Display language");
});

test("t.msg passes plain text and unknown codes through", () => {
  const te = translatorFor("en");
  assert.equal(te.msg("HTTP 404"), "HTTP 404");
  assert.equal(te.msg(new Error("boom")), "boom");
  assert.equal(te.msg('{"code":"no.such.code","params":{}}'), '{"code":"no.such.code","params":{}}', "an unknown code is shown raw");
  assert.equal(te.msg('{"code":"broken'), '{"code":"broken');
});
