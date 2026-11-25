import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { handlers } from "./mock.ts";

const api = readFileSync(new URL("../src/api.ts", import.meta.url), "utf8");
const invoked = new Set([...api.matchAll(/invoke(?:<[^(]*>)?\(\s*"([^"]+)"/g)].map((m) => m[1]));
assert.ok(invoked.size > 50, "found the invoke calls");

test("the e2e mock answers exactly the commands src/api.ts invokes", () => {
  const mocked = new Set(Object.keys(handlers));
  assert.deepEqual(
    [...invoked].filter((c) => !mocked.has(c)),
    [],
    "add these to e2e/mock.ts",
  );
  assert.deepEqual(
    [...mocked].filter((c) => !invoked.has(c)),
    [],
    "no longer in src/api.ts: remove from e2e/mock.ts",
  );
});

test("the app may call each command src/api.ts invokes, and a remote page the overlay's alone", () => {
  const dir = new URL("../src-tauri/capabilities/", import.meta.url);
  const granted = (file: string) => (JSON.parse(readFileSync(new URL(file, dir), "utf8")) as { permissions: string[] }).permissions;
  const app = new Set(granted("default.json"));
  assert.deepEqual(
    [...invoked].filter((c) => !app.has(`allow-${c.replaceAll("_", "-")}`)),
    [],
    "add these to capabilities/default.json",
  );
  for (const file of readdirSync(dir).filter((f) => f !== "default.json")) {
    assert.deepEqual(
      granted(file).filter((p) => !p.startsWith("allow-overlay-")),
      [],
      file,
    );
  }
});
