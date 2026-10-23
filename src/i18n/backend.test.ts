import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { ja } from "./ja.ts";
import { translatorFor } from "./index.ts";
import { rustMessageUsage } from "../../scripts/rust-messages.mjs";

function readRust(dir: string): { file: string; usage: ReturnType<typeof rustMessageUsage> }[] {
  const root = new URL(`../../${dir}/`, import.meta.url);
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      return readRust(file);
    }
    return entry.name.endsWith(".rs") ? [{ file, usage: rustMessageUsage(readFileSync(new URL(entry.name, root), "utf8")) }] : [];
  });
}
const rust = ["crates/lattice-core/src", "crates/lattice-cli/src", "src-tauri/src"].flatMap(readRust);
const catalog = new Map<string, string>(Object.entries(ja));

const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const beKeys = Object.keys(ja).filter((k) => k.startsWith("be."));

test("every backend message code has a catalog entry with the same params", () => {
  const calls = rust.flatMap((r) => r.usage.calls.map((c) => ({ ...c, file: r.file })));
  assert.ok(calls.length > 50, "found the msg! calls");
  for (const c of calls) {
    const key = `be.${c.code}`;
    const message = catalog.get(key);
    assert.ok(message, `${c.file}: ${key} is missing from src/i18n/ja.ts`);
    assert.deepEqual(c.params, names(message), `${c.file}: params of ${key}`);
  }
});

test("every be.* catalog entry is a code the backend uses", () => {
  const used = new Set(rust.flatMap((r) => r.usage.calls.map((c) => c.code)));
  // Field labels passed through msg::coded(field, ...) from the settings table.
  const fields = ["instructions.profile", "instructions.summary", "instructions.chat"];
  for (const r of rust.filter((r) => r.usage.dynamicField)) {
    assert.equal(r.file, "crates/lattice-core/src/instructions.rs", "declare new dynamic message sites explicitly");
    for (const code of fields) {
      assert.ok(r.usage.strings.has(code), `${r.file}: dynamic field ${code} was removed`);
      used.add(code);
    }
  }
  assert.deepEqual(
    beKeys.filter((k) => !used.has(k.slice(3))),
    [],
  );
});

test("t.msg translates coded messages, nested codes in params too, and passes plain text through", () => {
  const [ja_, en] = [translatorFor("ja"), translatorFor("en")];
  const tooLong = JSON.stringify({ code: "instructions.tooLong", params: { field: JSON.stringify({ code: "instructions.summary", params: {} }), max: 2000 } });
  assert.equal(ja_.msg(tooLong), "要約の追加の指示は 2,000 文字までです");
  assert.equal(en.msg(tooLong), "Extra instructions for summaries can be 2,000 characters at most");
  assert.equal(en.msg(JSON.stringify({ code: "render.failed", params: { error: "HTTP 503" } })), "Could not render the page: HTTP 503");
  assert.equal(en.msg("HTTP 404"), "HTTP 404", "provider and network errors stay as they are");
  assert.equal(en.msg(new Error("boom")), "boom");
  assert.equal(en.msg('{"code":"no.such.code","params":{}}'), '{"code":"no.such.code","params":{}}', "a code this UI does not know is shown raw");
  assert.equal(en.msg('{"code":"broken'), '{"code":"broken');
  assert.equal(en.msg("ジャンル名が空です"), "ジャンル名が空です", "messages stored before G51 stay as they were");
});
