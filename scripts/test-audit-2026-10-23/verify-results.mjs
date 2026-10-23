// Uses the retained local runner logs; this is an audit check, not an application test.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const dir = fileURLToPath(new URL("../../docs/test-audit-2026-10-23/", import.meta.url));
const { entries, metadata } = JSON.parse(fs.readFileSync(path.join(dir, "ledger.json"), "utf8"));
const logFiles = [".local/test-audit-node.log", ".local/test-audit-rust-full.log", ".local/test-audit-e2e.log"];
const [node, rust, e2e] = logFiles.map((f) => fs.readFileSync(f, "utf8"));
const nodeResults = [...node.matchAll(/^✔ (.*) \([\d.]+ms\)$/gm)].map((m) => m[1]);
const rustResults = [...rust.matchAll(/^test (\S+) \.\.\. (ok|ignored)[^\r\n]*$/gm)].map((m) => ({ name: m[1], status: m[2] }));
const e2eResults = [...e2e.matchAll(/^\s*ok\s+\d+\s+\[[^\]]+\]\s+›\s+(e2e[\\/].+?\.spec\.ts):(\d+):\d+\s+›/gm)].map(
  (m) => `${m[1].replaceAll("\\", "/")}:${m[2]}`,
);
assert.equal(nodeResults.length, 118);
assert.equal(rustResults.length, 215);
assert.equal(e2eResults.length, 130);
assert.equal(new Set(nodeResults).size, nodeResults.length, "node test names are ambiguous");
assert.equal(new Set(rustResults.map((r) => r.name)).size, rustResults.length, "rust names are ambiguous across crates");
assert.equal(new Set(e2eResults).size, e2eResults.length, "browser declaration executed more than once");
for (const t of entries) {
  if (t.layer === "node") {
    assert.ok(nodeResults.includes(t.name), `missing Node result ${t.id}`);
  } else if (t.layer === "browser-mock") {
    assert.ok(e2eResults.includes(`${t.file}:${t.line}`), `missing Playwright result ${t.id}`);
  } else {
    const module = path.posix.basename(t.file, ".rs");
    const qualified = t.file.includes("/tests/") ? t.name : module === "main" ? `tests::${t.name}` : `${module}::tests::${t.name}`;
    const result = rustResults.find((r) => r.name === qualified);
    assert.ok(result, `missing Rust result ${t.id}: ${qualified}`);
    assert.equal(result.status, t.execution === "ignored" ? "ignored" : "ok", t.id);
  }
}

let checkedLinks = 0;
const auditedInputs = new Set(JSON.parse(fs.readFileSync(path.join(dir, "input-hashes.json"), "utf8")).map((input) => input.file));
const historicalSources = new Map();
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".md"))) {
  const doc = fs.readFileSync(path.join(dir, file), "utf8");
  for (const [, href] of doc.matchAll(/\]\(([^)]+)\)/g)) {
    if (/^https?:/.test(href)) {
      continue;
    }
    const [relative, anchor] = href.split("#");
    const target = relative ? path.resolve(dir, relative) : path.join(dir, file);
    // This command creates the linked evidence file after all checks have succeeded.
    if (target === path.join(dir, "execution-results.json") && !fs.existsSync(target)) {
      checkedLinks++;
      continue;
    }
    assert.ok(fs.existsSync(target), `${file}: broken link ${href}`);
    const relativeSource = path.relative(process.cwd(), target).replaceAll("\\", "/");
    // Old audit links describe the audited revision; remediation links describe the working tree.
    if (file !== "remediation.md" && auditedInputs.has(relativeSource) && !historicalSources.has(relativeSource)) {
      historicalSources.set(relativeSource, execFileSync("git", ["show", `${metadata.commit}:${relativeSource}`], { encoding: "utf8" }));
    }
    const contents =
      file !== "remediation.md" && historicalSources.has(relativeSource) ? historicalSources.get(relativeSource) : fs.readFileSync(target, "utf8");
    if (anchor?.startsWith("L") && /^L\d+$/.test(anchor)) {
      assert.ok(Number(anchor.slice(1)) <= contents.split("\n").length, href);
    }
    if (anchor && /^[TFR]\d+$/.test(anchor)) {
      assert.ok(contents.includes(`id="${anchor}"`), `${file}: missing anchor ${href}`);
    }
    checkedLinks++;
  }
}
const logs = logFiles.map((file) => ({ file, sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") }));
const result = {
  date: "2026-10-23",
  command: "mise exec -- node scripts/test-audit-2026-10-23/verify-results.mjs",
  matchedDeclarations: entries.length,
  execution: metadata.byExecution,
  checkedLinks,
  logs,
  evidence: "Nodeは名前、Rustはmodule付き名前、Playwrightはfile:lineで全宣言と成功/ignoreログを突合した",
};
fs.writeFileSync(path.join(dir, "execution-results.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
