import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { ja } from "./ja.ts";
import { translatorFor } from "./index.ts";

const ROOTS = ["crates/lattice-core/src", "src-tauri/src"].map((d) => new URL(`../../${d}/`, import.meta.url));
const rust = ROOTS.flatMap((root) =>
  readdirSync(root)
    .filter((f) => f.endsWith(".rs") && f !== "msg.rs")
    .map((f) => ({ file: f, text: readFileSync(new URL(f, root), "utf8") })),
);

/** Every `msg!("code", name = expr, …)` call: its code and param names (top-level commas only). */
function msgCalls(text: string) {
  const calls: { code: string; params: string[] }[] = [];
  for (let i = text.indexOf("msg!("); i >= 0; i = text.indexOf("msg!(", i + 1)) {
    const parts: string[] = [];
    let depth = 0;
    let cur = "";
    let str = false;
    for (let j = i + 5; j < text.length; j++) {
      const c = text[j];
      if (str) {
        if (c === "\\") {
          cur += c + text[++j];
        } else {
          if (c === '"') {
            str = false;
          }
          cur += c;
        }
        continue;
      }
      if (c === '"') {
        str = true;
      } else if ("([{".includes(c)) {
        depth++;
      } else if (")]}".includes(c)) {
        if (depth === 0) {
          break;
        }
        depth--;
      } else if (c === "," && depth === 0) {
        parts.push(cur);
        cur = "";
        continue;
      }
      cur += c;
    }
    parts.push(cur);
    const code = /^\s*"([\w.]+)"\s*$/.exec(parts[0])?.[1];
    if (code) {
      calls.push({
        code,
        params: parts
          .slice(1)
          .map((p) => /^\s*(\w+)\s*=/.exec(p)?.[1] ?? "")
          .filter(Boolean)
          .sort(),
      });
    }
  }
  return calls;
}

const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const beKeys = Object.keys(ja).filter((k) => k.startsWith("be."));

test("every backend message code has a catalog entry with the same params", () => {
  const calls = rust.flatMap((r) => msgCalls(r.text).map((c) => ({ ...c, file: r.file })));
  assert.ok(calls.length > 50, "found the msg! calls");
  for (const c of calls) {
    const key = `be.${c.code}`;
    assert.ok(key in ja, `${c.file}: ${key} is missing from src/i18n/ja.ts`);
    assert.deepEqual(c.params, names(ja[key as keyof typeof ja]), `${c.file}: params of ${key}`);
  }
});

test("every be.* catalog entry is a code the backend uses", () => {
  const all = rust.map((r) => r.text).join("\n");
  assert.deepEqual(
    beKeys.filter((k) => !all.includes(`"${k.slice(3)}"`)),
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
