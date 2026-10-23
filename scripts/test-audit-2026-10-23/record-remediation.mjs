// Attach verified fixes to the original audit IDs without renumbering its frozen inventory.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import ts from "typescript";

const dir = fileURLToPath(new URL("../../docs/test-audit-2026-10-23/", import.meta.url));
/** @type {Array<[string, string, Array<[string, string]>]>} */
const fixes = [
  [
    "F01",
    "実際のfont-family・loaded face・必要glyphを初回frameで検証。冷cacheでfont取得を遅延させた負例も追加。固定500ms待機を除去。",
    [
      ["e2e/shell.spec.ts", "the ⋯ menu draws its text in the frame it first appears (H8)"],
      ["e2e/shell.spec.ts", "the menu font check rejects delayed font files on a cold page (H8)"],
    ],
  ],
  [
    "F02",
    "抜粋の正確な内容・長さ・両端・無hit・複数語を検証。全文返却と後続hit優先の両変異を拒否。",
    [["src/search/search.test.ts", "excerpt centers on the first hit"]],
  ],
  ["F03", "コピー項目を実クリックし、Chromium clipboardから未保存URLを読み戻して確認。", [["e2e/shell.spec.ts", "an unsaved page's ⋯ copies its URL (H14)"]]],
  [
    "F04",
    "Rustをtoken化し、コメント・文字列内の見かけの呼出し・cfg(test)を除外。core/CLI/Tauriを再帰走査。動的field codeは明示契約として検証。",
    [
      ["src/i18n/backend.test.ts", "every be.* catalog entry is a code the backend uses"],
      ["scripts/rust-messages.test.mjs", "Rust message uses exclude comments, literal lookalikes and cfg(test) items"],
      ["scripts/rust-messages.test.mjs", "Rust message scan keeps production cfg branches and excludes gated helper methods"],
    ],
  ],
  [
    "F05",
    "Node cryptoで独立計算したGET/DELETEの固定署名値へ変更。AWS既知vectorとURL/escapeのassertionは維持。",
    [["crates/lattice-core/src/r2.rs", "signs_list_and_delete_requests"]],
  ],
  [
    "F06",
    "Nodeのmock timersで静穏期間のreset、cap直前未完了・到達時完了を検証。実時間の許容幅とintervalを除去。",
    [
      ["src/overlay/overlay.test.ts", "settle waits for a full quiet period after the last DOM mutation"],
      ["src/overlay/overlay.test.ts", "settle reaches its cap while DOM mutations continue"],
    ],
  ],
  [
    "F07",
    "設定送信・同一セッション再表示という実際の保証へ3テストを改名。DB耐久性は既存の境界記録を維持。",
    [
      ["e2e/chat.spec.ts", "the chat budget sends the setting and keeps it when the section is reopened"],
      ["e2e/english.spec.ts", "an English WebView starts in English and sends the language choice"],
      ["e2e/i18n.spec.ts", "the display language switches live in Settings and sends the backend setting"],
    ],
  ],
  [
    "F08",
    "日本語の全19カテゴリを列挙し、実navigation全体の集合・順序と一致してから全見出しを確認。",
    [["e2e/settings.spec.ts", "every settings section renders, and Esc goes back to the library"]],
  ],
  [
    "F09",
    "カスタム名を再設定してから空欄解除を操作し、元名/カスタム名/空欄のrename引数列を確認。",
    [["e2e/feedname.spec.ts", "a custom name starts the field; the feed's own name or an empty field saves as no custom name"]],
  ],
  [
    "F10",
    "別窓化/復帰の名称を実操作へ修正し、chat窓の引用をクリックしてmainへのcitation payloadとnewTabを確認。",
    [
      ["e2e/popout.spec.ts", "the chat dock pops out from its header and saves the open-window marker"],
      ["e2e/popout.spec.ts", "the chat window syncs article scopes, sends citations to main and docks back"],
    ],
  ],
  [
    "F11",
    "URL保存テストを改名。Pageへbrowser-titleを送り、題名表示と別tab開閉後の保持を確認。",
    [
      ["e2e/palette.spec.ts", "Ctrl+Enter saves a pasted URL to the Index"],
      ["e2e/tabs.spec.ts", "a Page tab gets its own webview, titled by its host until the page names itself"],
    ],
  ],
  [
    "F12",
    "外側クリックの名称をapp DOM内へ限定。別のbrowser-focus分岐試験は維持。",
    [["e2e/menus.spec.ts", "a press outside in the app DOM closes the group picker and a menu (H23)"]],
  ],
  [
    "F13",
    "needsTranslation/translationProgressのhelper契約と分かる名称へ修正。TS/Rust一致まで保証する表現を除去。",
    [
      ["src/reader/mixed.test.ts", "needsTranslation excludes target-language prose, translated blocks and code"],
      ["src/reader/mixed.test.ts", "translationProgress counts translated and eligible prose blocks"],
    ],
  ],
  [
    "F14",
    "固定badgeをジョブ試験へ、mainのno-readyをmain shell試験開始へ移動。assertionを残して独立2シナリオを統合。",
    [
      ["e2e/jobs.spec.ts", "job types show their names, with the ID on hover"],
      ["e2e/shell.spec.ts", "the main window keeps its title bar and its strips do not drag the window (H19)"],
    ],
  ],
];

function reference(file, name) {
  const source = fs.readFileSync(file, "utf8");
  let position = -1;
  if (file.endsWith(".rs")) {
    position = source.indexOf(`fn ${name}(`);
  } else {
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === "test" && node.arguments[0]?.text === name) {
        position = node.getStart(ast);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  assert.ok(position >= 0, `${file}: missing current check ${name}`);
  return { file, name, line: source.slice(0, position).split("\n").length };
}
const logFiles = [
  ".local/test-remediation-node.log",
  ".local/test-remediation-e2e.log",
  ".local/test-remediation-rust.log",
  ".local/test-remediation-probes.log",
];
const [node, browser, rust, probes] = logFiles.map((file) => fs.readFileSync(file, "utf8"));
assert.match(node, /^ℹ fail 0\r?$/m);
assert.doesNotMatch(browser, /^\s+\d+ failed\b/m);
const nodePassed = Number(node.match(/^ℹ pass (\d+)/m)?.[1]);
const browserPassed = Number(browser.match(/^\s+(\d+) passed\s/m)?.[1]);
const rustRuns = [...rust.matchAll(/^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/gm)];
assert.ok(nodePassed >= 121 && browserPassed >= 129 && rustRuns.length >= 5, "missing full runner summaries");
for (const result of rustRuns) {
  assert.equal(result[1], "ok");
  assert.equal(Number(result[3]), 0);
}
assert.match(probes, /EXCERPT_MUTANT 1/);
assert.match(probes, /LATER_HIT_MUTANT 1/);
const rustPassed = rustRuns.reduce((n, r) => n + Number(r[2]), 0);
const ignored = rustRuns.reduce((n, r) => n + Number(r[4]), 0);
const ledgerPath = path.join(dir, "ledger.json");
const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
assert.deepEqual(
  fixes.map((f) => f[0]),
  ledger.findings.map((f) => f.id),
);
const resolved = fixes.map(([id, change, checks]) => ({
  id,
  status: "対応済み",
  change,
  originalTests: ledger.findings.find((f) => f.id === id).tests,
  checks: checks.map(([file, name]) => reference(file, name)),
}));
const report = {
  date: "2026-10-23",
  originalAuditTests: 463,
  findingsResolved: 14,
  originalTestsAddressed: 20,
  verification: { nodePassed, browserPassed, rustPassed, ignored, mutationChecksRejected: 2 },
  fixes: resolved,
  logs: logFiles.map((file) => ({ file, sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") })),
};
fs.writeFileSync(path.join(dir, "remediation.json"), JSON.stringify(report, null, 2) + "\n");
for (const entry of ledger.entries) {
  const resolution = resolved.find((f) => f.originalTests.includes(entry.id));
  if (resolution) {
    entry.remediation = "対応済み（2026-10-23）";
    entry.currentChecks = resolution.checks;
  }
}
for (const finding of ledger.findings) {
  finding.resolution = resolved.find((f) => f.id === finding.id);
}
ledger.metadata.remediation = { file: "remediation.json", findingsResolved: 14, originalTestsAddressed: 20 };
fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n");
let markdown = "# テスト監査の対応結果\n\n元の[463件台帳](ledger.md)の14項目・20テストへの対応。監査IDを維持し、現在の実行箇所を以下へ記録する。\n\n";
markdown += `検証: Node ${nodePassed}件、Playwright ${browserPassed}件、Rust ${rustPassed}件成功・${ignored}件ignore。抜粋の変異2種は修正後のassertionで失敗することを確認。型検査・変更箇所のlint/formatも成功。\n\n`;
markdown += "| 課題 | 状態 | 変更と現在の検証箇所 |\n| --- | --- | --- |\n";
for (const fix of resolved) {
  markdown += `| <a id="${fix.id}"></a>${fix.id} | 対応済み | ${fix.change} ${fix.checks.map((c) => `[${c.file}:${c.line}](../../${c.file}#L${c.line})`).join("、")} |\n`;
}
markdown +=
  "\n本番のnative窓・IPC配送、DB再起動の耐久性、TS/Rust共通corpusは引き続き[境界記録](boundaries.md)の範囲。今回の名称修正はその保証を拡張していない。R2期待値はregion=auto、service=s3、20130524T000000Z、空body、既存fixtureのpath/queryからNode cryptoで独立計算した。\n\n";
markdown +=
  "元のinventory・input-hashes・実行結果は監査当時の記録として保持した。修正対象の現在位置は本表、構造化した対応・ログhashは[remediation.json](remediation.json)を参照。旧probes.mjsは、現在のassertionが全文返却・後続hit優先の変異を拒否する確認へ更新した。\n\n";
markdown +=
  "Rustの初回並列ビルドはメモリ不足で失敗したため、ブラウザテスト終了後にcargo test --workspace -j 1で成功を確認した。通常sandboxではSchannel資格情報エラーが出るため、前回同様の承認済み実行を使用した。\n";
fs.writeFileSync(path.join(dir, "remediation.md"), markdown);
for (const file of ["README.md", "ledger.md", "findings.md", "evidence.md"]) {
  const target = path.join(dir, file);
  let doc = fs.readFileSync(target, "utf8");
  if (!doc.includes("<!-- remediation -->")) {
    const firstLine = doc.indexOf("\n");
    doc =
      doc.slice(0, firstLine + 1) +
      "\n<!-- remediation -->\n**修正後: 14項目・20テストの対応完了。[対応内容・現在のテスト位置・検証結果](remediation.md)。以下の件数・指摘本文は監査時点の記録。**\n" +
      doc.slice(firstLine + 1);
  }
  doc = doc.replace(
    "14項目・一意な20テスト。全件「未着手」、担当未設定。",
    "監査対象の改善候補は14項目・一意な20テスト。現在は全件対応済み（上記対応台帳を参照）。",
  );
  fs.writeFileSync(target, doc);
}
console.log(JSON.stringify(report.verification));
