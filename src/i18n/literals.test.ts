import { test } from "node:test";
import assert from "node:assert/strict";
import * as extract from "../../scripts/i18n-extract.mjs";

const { scan, sourceFiles } = extract as unknown as { scan: (file: string) => { file: string; line: number; ja: string }[]; sourceFiles: () => string[] };

/** Japanese that is data, not UI text: it stays the same in every display language. */
const ALLOWED: Record<string, string[]> = {};

/** Not moved to the catalogs yet (G51 is migrating them file by file). */
const PENDING = new Set([
  "src/App.tsx", "src/BrowserView.tsx", "src/ChatPane.tsx", "src/FeedsView.tsx", "src/ImportView.tsx", "src/JobsView.tsx", "src/overlay/index.ts",
  "src/Palette.tsx", "src/QuizCard.tsx", "src/QuizPanel.tsx", "src/QuizReview.tsx", "src/Reader.tsx", "src/SearchPane.tsx",
]);

test("UI code has no Japanese text outside the catalogs (src/i18n)", () => {
  const files = sourceFiles();
  assert.ok(files.length > 50, "found the sources");
  const found = files.filter((f) => !PENDING.has(f)).flatMap(scan)
    .filter((e) => !ALLOWED[e.file]?.includes(e.ja))
    .map((e) => `${e.file}:${e.line} ${e.ja}`);
  assert.deepEqual(found, [], "move these to src/i18n/ja.ts and en.ts (node scripts/i18n-extract.mjs), or allow them above if they are data");
});
