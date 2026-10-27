// The English and Japanese user docs correspond line for line, so a line's shape and the lines a change
// touches must match between them. `node scripts/doc-pairs.mjs [base]` checks both; the pairing is against
// `base` (default origin/master), working tree included. A commit message with [one-language] in the range
// skips the pairing (a typo fixed in one language).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PAIRS = [
  ["README.md", "README.ja.md"],
  ["docs/guide.md", "docs/guide.ja.md"],
  ["CHANGELOG.md", "CHANGELOG.ja.md"],
];
const SKIP = "[one-language]";

/** What must agree between a line and its translation: its block kind, its code spans, and how many links it has (their targets are per language). */
export function shapeOf(line) {
  const kind = /^\s*$/.test(line)
    ? "blank"
    : /^#{1,6} /.test(line)
      ? `h${/^#+/.exec(line)[0].length}`
      : /^\s*```/.test(line)
        ? "fence"
        : /^\s*\|/.test(line)
          ? `table${line.split("|").length}`
          : /^\s*[-*] /.test(line)
            ? `bullet${/^\s*/.exec(line)[0].length}`
            : /^\s*\d+\. /.test(line)
              ? `ordered${/^\s*/.exec(line)[0].length}`
              : "text";
  // Placeholders are translated (`NAME` / `名前`, `<Unix seconds>` / `<Unix 秒>`): they match anything.
  const code = [...line.matchAll(/`[^`]+`/g)].map((m) => m[0].replace(/<[^>]*>/g, "<>").replace(/\b[A-Z]{2,}\b|[^\t -~]+/g, "_"));
  const links = line.match(/\]\(/g)?.length ?? 0;
  return [kind, ...code.sort((a, b) => a.localeCompare(b)), `links${links}`].join(" ");
}

/** "line N: …" for each line whose shape differs, and a line-count difference. */
export function shapeMismatches(en, ja) {
  const a = en.split("\n");
  const b = ja.split("\n");
  const out = [];
  if (a.length !== b.length) {
    out.push(`${a.length} lines vs ${b.length}`);
  }
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const [x, y] = [shapeOf(a[i]), shapeOf(b[i])];
    if (x !== y) {
      out.push(`line ${i + 1}: ${x} vs ${y}`);
    }
  }
  return out;
}

/** The lines a `git diff -U0` touches, as "-N" (old side) and "+N" (new side). */
export function changedLines(diff) {
  const lines = new Set();
  for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const [a, b, c, d] = [m[1], m[2] ?? "1", m[3], m[4] ?? "1"].map(Number);
    for (let i = 0; i < b; i++) {
      lines.add(`-${a + i}`);
    }
    for (let i = 0; i < d; i++) {
      lines.add(`+${c + i}`);
    }
    // A pure deletion or insertion still names where it happened.
    if (b === 0) {
      lines.add(`-after${a}`);
    }
  }
  return lines;
}

/** Lines changed in one file of the pair but not the other. */
export function unpaired(enDiff, jaDiff) {
  const [a, b] = [changedLines(enDiff), changedLines(jaDiff)];
  const only = (x, y) => [...x].filter((l) => !y.has(l));
  return { en: only(a, b), ja: only(b, a) };
}

function main(base) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  let failed = false;
  for (const [en, ja] of PAIRS) {
    const bad = shapeMismatches(readFileSync(join(root, en), "utf8"), readFileSync(join(root, ja), "utf8"));
    if (bad.length) {
      failed = true;
      console.error(`${en} and ${ja} differ in shape:\n  ${bad.join("\n  ")}`);
    }
  }
  let range;
  try {
    range = git("log", "--format=%B", `${base}..HEAD`);
  } catch {
    console.warn(`doc-pairs: ${base} is not available; the changed-lines pairing is skipped.`);
    process.exit(failed ? 1 : 0);
  }
  if (range.includes(SKIP)) {
    console.warn(`doc-pairs: a commit since ${base} says ${SKIP}; the changed-lines pairing is skipped.`);
  } else {
    for (const [en, ja] of PAIRS) {
      const u = unpaired(git("diff", "-U0", base, "--", en), git("diff", "-U0", base, "--", ja));
      if (u.en.length || u.ja.length) {
        failed = true;
        console.error(
          `Since ${base}, these lines changed in only one of ${en} / ${ja} (-: old line, +: new line):\n` +
            `  only ${en}: ${u.en.join(" ") || "-"}\n  only ${ja}: ${u.ja.join(" ") || "-"}\n` +
            `Update the other language too, or put ${SKIP} in the commit message.`,
        );
      }
    }
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv[2] || "origin/master");
}
