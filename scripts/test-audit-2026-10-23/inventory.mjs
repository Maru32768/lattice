import fs from "node:fs";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Run from the repository root. Declarations, not assertion count, are the unit of inventory.
const roots = ["src", "e2e", "scripts", "crates", "src-tauri"];
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = `${dir}/${e.name}`;
    if (["node_modules", "target", "overlay-dist", "gen"].includes(e.name)) {
      return [];
    }
    return e.isDirectory() ? walk(p) : [p];
  });
}
const records = [];
for (const file of roots.flatMap(walk).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
  if (!/\.(rs|ts|tsx|mjs|js)$/.test(file)) {
    continue;
  }
  const source = fs.readFileSync(file, "utf8");
  const lineAt = (p) => source.slice(0, p).split("\n").length;
  if (file.endsWith(".rs")) {
    const re = /#\[(?:tokio::)?test(?:\([^\]]*\))?\]\s*(?:#\[[^\]]*\]\s*)*(?:async\s+)?fn\s+(\w+)/g;
    for (const m of source.matchAll(re)) {
      records.push({ file, line: lineAt(m.index), name: m[1], layer: "rust" });
    }
  } else if (/\.(test|spec)\.(ts|tsx|mjs|js)$/.test(file)) {
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isCallExpression(node) && /^test(?:\.(?:skip|only|todo))?$/.test(node.expression.getText(ast))) {
        records.push({
          file,
          line: lineAt(node.getStart(ast)),
          end: lineAt(node.end),
          name: node.arguments[0]?.text ?? node.arguments[0]?.getText(ast),
          layer: file.endsWith(".spec.ts") ? "browser-mock" : "node",
        });
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
}
for (const [i, row] of records.entries()) {
  row.id = `T${String(i + 1).padStart(3, "0")}`;
}
const out = fileURLToPath(new URL("../../docs/test-audit-2026-10-23/", import.meta.url));
const inventoryPath = path.join(out, "inventory.json");
if (fs.existsSync(inventoryPath)) {
  assert.deepEqual(JSON.parse(fs.readFileSync(inventoryPath, "utf8")), records, "the dated inventory is frozen; record fixes by original ID");
}
fs.writeFileSync(path.join(out, "inventory.json"), JSON.stringify(records, null, 2) + "\n");
console.log(
  JSON.stringify({
    total: records.length,
    files: new Set(records.map((r) => r.file)).size,
    layers: Object.fromEntries(["rust", "node", "browser-mock"].map((l) => [l, records.filter((r) => r.layer === l).length])),
  }),
);
