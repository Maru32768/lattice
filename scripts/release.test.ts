import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSigning, releaseNotes } from "./release.ts";

test("release notes select the exact version, omit link definitions and support Windows newlines", () => {
  const changelog = "## [Unreleased]\r\n\r\n## [0.1.0] - 2026-10-26\r\n\r\n### Added\r\n\r\n- First release.\r\n\r\n[0.1.0]: https://example.com\r\n";
  assert.equal(releaseNotes(changelog, "0.1.0"), "### Added\n\n- First release.");
  assert.throws(() => releaseNotes(changelog, "0.1"), /no section/);
});

test("releases require a dated version section with actual notes", () => {
  assert.throws(() => releaseNotes("## [Unreleased]\n- Not released.", "0.1.0"), /no section/);
  assert.throws(() => releaseNotes("## [0.1.0]\n- First release.", "0.1.0"), /Date the/);
  assert.throws(() => releaseNotes("## [0.1.0] - 2026-10-26\n### Added\n\n## [0.0.1] - 2026-10-01\n- Old.", "0.1.0"), /no release notes/);
});

test("missing signing prerequisites stop a release without exposing secret values", () => {
  const configured = { plugins: { updater: { pubkey: "configured-public-key" } } };
  const secrets = { TAURI_SIGNING_PRIVATE_KEY: "private-do-not-log", TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "password-do-not-log" };
  assert.throws(() => checkSigning({ plugins: { updater: { pubkey: "NOT_CONFIGURED" } } }, secrets), /public key/);
  assert.throws(() => checkSigning(configured, {}), /TAURI_SIGNING_PRIVATE_KEY before/);
  assert.throws(() => checkSigning(configured, { TAURI_SIGNING_PRIVATE_KEY: secrets.TAURI_SIGNING_PRIVATE_KEY }), /TAURI_SIGNING_PRIVATE_KEY_PASSWORD/);
  assert.doesNotThrow(() => checkSigning(configured, secrets));
});
