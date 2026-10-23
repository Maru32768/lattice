// Historical font-oracle comparison and current excerpt mutation check. See remediation.md.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { chromium } from "@playwright/test";

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ locale: "ja-JP" });
  await context.route(/\.(woff2?|ttf)(\?|$)/, (route) => route.abort());
  const page = await context.newPage();
  await page.goto(`http://localhost:${process.env.E2E_PORT ?? 1443}/`);
  await page.locator(".row").first().click();
  await page.locator(".docbar [aria-haspopup=menu]").last().click();
  await page.getByRole("menu").waitFor();
  const observed = await page.evaluate(() => {
    const buttons = [...document.querySelector(".menu").querySelectorAll("button")];
    return {
      buttons: buttons.length,
      assertedFont: buttons.every((b) => document.fonts.check('12px "IBM Plex Sans JP"', b.textContent)),
      actualFamily: getComputedStyle(buttons[0]).fontFamily,
      loadedNotoFaces: [...document.fonts].filter((f) => f.family.includes("Noto") && f.status === "loaded").length,
      nonexistentFontCheck: document.fonts.check('12px "NonexistentAuditFont123"', "日本語"),
    };
  });
  console.log("FONT", JSON.stringify(observed));
  assert.ok(observed.buttons > 0, "not a vacuous every([]) result");
  assert.equal(observed.loadedNotoFaces, 0);
  assert.equal(observed.assertedFont, true);
  assert.equal(observed.nonexistentFontCheck, true);
} finally {
  await browser.close();
}

const source = fs.readFileSync("src/search/search.test.ts", "utf8");
const originalImport = 'import { excerpt, filterHits, groupHits, highlight, terms } from "./search.ts";';
assert.ok(source.includes(originalImport), "test import changed; re-review the mutation before running");
const url = pathToFileURL(path.resolve("src/search/search.ts")).href;
const mutant = source.replace(
  originalImport,
  `import { filterHits, groupHits, highlight, terms } from ${JSON.stringify(url)};
const excerpt = (text, terms, max = 220) => text.length <= max
  ? text
  : terms.some(t => text.toLowerCase().includes(t.toLowerCase())) ? '…' + text + '…' : text;`,
);
fs.mkdirSync(".local", { recursive: true });
const scratch = ".local/test-audit-excerpt-mutant.test.ts";
fs.writeFileSync(scratch, mutant);
const result = spawnSync(process.execPath, ["--test", scratch], { encoding: "utf8" });
console.log("EXCERPT_MUTANT", result.status, result.stdout, result.stderr);
assert.ifError(result.error);
assert.equal(result.status, 1, "the strengthened excerpt assertions must reject the untrimmed result");
assert.match(result.stdout, /✖ excerpt centers on the first hit/);

const laterHit = source.replace(
  originalImport,
  `import { excerpt as actualExcerpt, filterHits, groupHits, highlight, terms } from ${JSON.stringify(url)};
const excerpt = (text, terms, max) => actualExcerpt(text, terms.slice(0, 1), max);`,
);
fs.writeFileSync(scratch, laterHit);
const later = spawnSync(process.execPath, ["--test", scratch], { encoding: "utf8" });
console.log("LATER_HIT_MUTANT", later.status, later.stdout, later.stderr);
assert.ifError(later.error);
assert.equal(later.status, 1, "the first occurrence must win over the first query term");
assert.match(later.stdout, /✖ excerpt centers on the first hit/);
