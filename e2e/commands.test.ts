import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handlers } from "./mock.ts";

test("the e2e mock answers exactly the commands src/api.ts invokes", () => {
  const api = readFileSync(new URL("../src/api.ts", import.meta.url), "utf8");
  const invoked = new Set([...api.matchAll(/invoke(?:<[^(]*>)?\(\s*"([^"]+)"/g)].map((m) => m[1]));
  assert.ok(invoked.size > 50, "found the invoke calls");
  const mocked = new Set(Object.keys(handlers));
  assert.deepEqual([...invoked].filter((c) => !mocked.has(c)), [], "add these to e2e/mock.ts");
  assert.deepEqual([...mocked].filter((c) => !invoked.has(c)), [], "no longer in src/api.ts: remove from e2e/mock.ts");
});
