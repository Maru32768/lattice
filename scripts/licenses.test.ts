import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { npmPackages, renderNpm } from "./licenses.ts";

test("every bundled npm package has a license text, and dev tools are left out", () => {
  const packages = npmPackages(fileURLToPath(new URL("..", import.meta.url)));
  const names = packages.map((p) => p.name);
  assert.ok(names.includes("react"));
  assert.ok(!names.includes("vite"));
  assert.ok(packages.every((p) => p.text.length > 0));
});

test("packages with the same text share one copy of it", () => {
  const out = renderNpm([
    { name: "a", version: "1.0.0", license: "MIT", text: "MIT text" },
    { name: "b", version: "2.0.0", license: "MIT", text: "MIT text" },
    { name: "c", version: "3.0.0", license: "ISC", text: "ISC text" },
  ]);
  assert.equal(out.split("MIT text").length, 2);
  assert.match(out, /Used by:\n {2}a 1\.0\.0\n {2}b 2\.0\.0/);
});
