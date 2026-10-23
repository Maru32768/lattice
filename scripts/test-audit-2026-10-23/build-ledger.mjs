import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { summaries, findings } from "./review-data.mjs";
import { profiles } from "./profiles.mjs";

const dir = fileURLToPath(new URL("../../docs/test-audit-2026-10-23/", import.meta.url));
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
// Reject changed source before writing anything over the frozen audit or its follow-up status.
const priorSnapshot = path.join(dir, "input-hashes.json");
if (fs.existsSync(priorSnapshot)) {
  for (const input of JSON.parse(fs.readFileSync(priorSnapshot, "utf8"))) {
    assert.equal(sha256(input.file), input.sha256, `${input.file}: audited input changed; preserve the original snapshot`);
  }
}
const inventory = JSON.parse(fs.readFileSync(path.join(dir, "inventory.json"), "utf8"));
const notes = new Map(summaries);
const issues = new Map(findings.flatMap((f) => f.tests.map((id) => [id, f])));
const lexical = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
assert.equal(notes.size, summaries.length, "duplicate review IDs");
assert.equal(issues.size, findings.flatMap((f) => f.tests).length, "duplicate finding assignments");
assert.deepEqual([...notes.keys()].sort(lexical), inventory.map((t) => t.id).sort(lexical), "inventory/review mismatch");
assert.deepEqual(Object.keys(profiles).sort(lexical), [...new Set(inventory.map((t) => t.file))].sort(lexical), "unreviewed or obsolete file profile");
for (const id of issues.keys()) {
  assert.ok(notes.has(id), `finding references unknown ${id}`);
}
for (const [file, p] of Object.entries(profiles)) {
  assert.ok(fs.existsSync(file), file);
  for (const target of p.targets) {
    assert.ok(fs.existsSync(target), `missing production target: ${target}`);
  }
}

const entries = inventory.map((t) => {
  const finding = issues.get(t.id);
  const ignored = t.id === "T035";
  return {
    ...t,
    protects: notes.get(t.id),
    ...profiles[t.file],
    decision: finding?.decision ?? (ignored ? "維持・任意疎通" : "維持"),
    priority: finding?.priority ?? null,
    finding: finding?.id ?? null,
    action:
      finding?.action ??
      (ignored ? "有償live疎通として明示実行時だけ使用。通常CIの保証へ含めない" : "維持。現時点で削除・統合を正当化する同一保証の代替を認めない"),
    evidence: finding?.evidence ?? "本文・assertion・fixture・呼出し境界を読解",
    execution: ignored ? "ignored" : "passed",
    remediation: finding ? "未着手（監査のみ）" : "対象外",
    owner: null,
  };
});
const count = (key) => Object.fromEntries([...new Set(entries.map((t) => t[key]))].map((v) => [v, entries.filter((t) => t[key] === v).length]));
const metadata = {
  date: "2026-10-23",
  timezone: "Asia/Tokyo",
  commit: "ff8dd646be45a9a9a2eac1d90f4567f238d291fa",
  snapshot: "作業ツリーを監査。HEADとの差分があるPalette.tsx/TitleBar.tsxを含む。監査は既存コードを変更していない",
  unit: "test宣言一件。loop内のassertion/入力例は別件に数えない",
  total: entries.length,
  files: Object.keys(profiles).length,
  byLayer: count("layer"),
  byDecision: count("decision"),
  byExecution: count("execution"),
  findingGroups: findings.length,
  flaggedTests: issues.size,
  idPolicy: "このsnapshot内だけのID。継続台帳への照合キーはfile + name",
};
fs.writeFileSync(path.join(dir, "ledger.json"), JSON.stringify({ metadata, findings, entries }, null, 2) + "\n");
const cell = (s) => String(s).replaceAll("|", "\\|").replaceAll("\n", " ");
const source = (file, line) => `../../${file}${line ? `#L${line}` : ""}`;
let md = `# 全テスト台帳（2026-10-23）\n\n`;
md += `463宣言・112ファイルを対象に、各本文のassertion・入力・fixtureと本番側の接続を確認した記録。自動採点やテスト名だけの分類ではない。実行は462成功・1 ignore。\n\n`;
md += `[監査結果](README.md) / [改善候補14項目・20テスト](findings.md) / [本番経路との境界](boundaries.md) / [実行・再現証拠](evidence.md) / [構造化台帳](ledger.json)\n\n`;
md += `「維持」は完全性の認定ではなく、現時点で削除・統合の根拠を認めなかったという判断。「補強」も元の保証を捨てる提案ではない。各ファイルの境界・重複判断は配下の全行に適用する。試験名は原文を残し、「実際に守るもの」で射程を補正した。\n\n`;
md += `| 判定 | 件数 |\n| --- | ---: |\n${Object.entries(metadata.byDecision)
  .map(([k, v]) => `| ${k} | ${v} |`)
  .join("\n")}\n\n`;
for (const [file, p] of Object.entries(profiles).sort(([a], [b]) => a.localeCompare(b, "en"))) {
  const tests = entries.filter((t) => t.file === file);
  md += `## ${file}（${tests.length}件）\n\n`;
  md += `本番の接続先: ${p.targets.map((t) => `[${t}](${source(t)})`).join("、")}。\n\n`;
  md += `境界: ${p.boundary}\n\n重複判断: ${p.overlap}\n\n`;
  md += `| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |\n| --- | --- | --- | --- |\n`;
  for (const t of tests) {
    md += `| <a id="${t.id}"></a>[${t.id}:${t.line}](${source(file, t.line)}) | ${cell(t.name)} | ${cell(t.protects)} | ${t.decision}${t.finding ? ` / [${t.priority} ${t.finding}](findings.md#${t.finding})` : t.execution === "ignored" ? " / ignore・未実行" : " / 成功"} |\n`;
  }
  md += "\n";
}
fs.writeFileSync(path.join(dir, "ledger.md"), md.trimEnd() + "\n");

const inputFiles = [
  ...new Set([
    ...Object.keys(profiles),
    ...Object.values(profiles).flatMap((p) => p.targets),
    "e2e/setup.ts",
    "e2e/mock.ts",
    "e2e/fixtures.ts",
    "e2e/harness.ts",
    "e2e/vite.config.ts",
    "e2e/warm.ts",
    "playwright.config.ts",
    "package.json",
    "package-lock.json",
    "Cargo.toml",
    "Cargo.lock",
    "mise.toml",
    "src/main.tsx",
    "src/theme.css",
    "src-tauri/src/lib.rs",
    "src-tauri/build.rs",
    "src-tauri/capabilities/default.json",
    ".github/workflows/ci.yml",
  ]),
].sort(lexical);
// Freeze once: future regeneration must fail rather than silently claim a new snapshot was reviewed.
const snapshotPath = path.join(dir, "input-hashes.json");
const hashes = inputFiles.map((file) => ({ file, sha256: sha256(file) }));
if (fs.existsSync(snapshotPath)) {
  assert.deepEqual(JSON.parse(fs.readFileSync(snapshotPath, "utf8")), hashes, "audited inputs changed; re-review before updating snapshot");
} else {
  fs.writeFileSync(snapshotPath, JSON.stringify(hashes, null, 2) + "\n");
}
console.log(JSON.stringify(metadata, null, 2));
