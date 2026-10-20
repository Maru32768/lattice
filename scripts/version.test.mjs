import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkVersions, readVersions, setVersion } from "./version.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FILES = ["package.json", "package-lock.json", "Cargo.toml", "Cargo.lock"];

function copyRepo() {
  const dir = mkdtempSync(join(tmpdir(), "lattice-version-"));
  for (const f of FILES) copyFileSync(join(ROOT, f), join(dir, f));
  return dir;
}

test("every version file in the repository agrees", () => {
  assert.match(checkVersions(ROOT), /^\d+\.\d+\.\d+/);
});

test("tauri.conf.json takes its version from Cargo.toml", () => {
  assert.equal(JSON.parse(readFileSync(join(ROOT, "src-tauri/tauri.conf.json"), "utf8")).version, undefined);
});

test("setVersion rewrites every source and leaves dependencies alone", () => {
  const dir = copyRepo();
  const lockBefore = readFileSync(join(dir, "Cargo.lock"), "utf8");
  assert.equal(setVersion(dir, "2.3.4-beta.1"), "2.3.4-beta.1");
  assert.deepEqual(readVersions(dir).map((f) => f.versions.every((v) => v === "2.3.4-beta.1")), [true, true, true, true]);
  const changed = lockBefore.split("\n").filter((l, i) => l !== readFileSync(join(dir, "Cargo.lock"), "utf8").split("\n")[i]);
  assert.equal(changed.length, 3, "lattice, lattice-core and lattice-cli");
});

test("drift and bad input are reported", () => {
  const dir = copyRepo();
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ ...pkg, version: "9.9.9" }));
  assert.throws(() => checkVersions(dir), /version drift: package\.json=9\.9\.9/);
  assert.throws(() => setVersion(dir, "v1.0"), /not a semver/);
});
