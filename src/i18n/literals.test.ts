import { test } from "node:test";
import assert from "node:assert/strict";
import { scan, sourceFiles } from "../../scripts/i18n-extract.mjs";

/** Japanese that is data, not UI text: it stays the same in every display language. */
const ALLOWED: Record<string, string[]> = {};

test("UI code has no Japanese text outside the catalogs (src/i18n)", () => {
  const files = sourceFiles();
  assert.ok(files.length > 50, "found the sources");
  const found = files
    .flatMap(scan)
    .filter((e) => !ALLOWED[e.file]?.includes(e.ja))
    .map((e) => `${e.file}:${e.line} ${e.ja}`);
  assert.deepEqual(found, [], "move these to src/i18n/ja.ts and en.ts (node scripts/i18n-extract.mjs), or allow them above if they are data");
});
