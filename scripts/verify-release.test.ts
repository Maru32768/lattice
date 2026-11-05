import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseProblems, type ReleaseFacts } from "./verify-release.ts";

const INSTALLER = "https://api.github.com/repos/Maru32768/lattice/releases/assets/1";

const good: ReleaseFacts = {
  version: "1.2.3",
  manifest: { version: "1.2.3", platforms: { "windows-x86_64": { url: INSTALLER, signature: "sig\n" } } },
  installerUrl: INSTALLER,
  signature: "sig",
  publicKey: "key",
  previousPublicKey: "key",
  licenses: "Rust crates:\n  lattice 1.2.3\n",
  portableFiles: ["Lattice.exe", "lattice-cli.exe", "portable", "LICENSE", "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_LICENSES"],
};

test("a complete release has no problems", () => {
  assert.deepEqual(releaseProblems(good), []);
});

test("each way a release can be wrong is named", () => {
  const cases: [Partial<ReleaseFacts>, RegExp][] = [
    [{ manifest: { ...good.manifest, version: "1.2.2" } }, /names version 1\.2\.2/],
    [{ manifest: { ...good.manifest, platforms: {} } }, /no platform/],
    [{ installerUrl: `${INSTALLER}0` }, /not the uploaded installer/],
    [{ signature: "other" }, /differs from the \.sig file/],
    [{ previousPublicKey: "old key" }, /public key changed/],
    [{ licenses: "  lattice 1.2.2\n" }, /does not list lattice 1\.2\.3/],
    [{ portableFiles: good.portableFiles.filter((file) => file !== "portable") }, /portable zip has no portable/],
  ];
  for (const [change, expected] of cases) {
    const problems = releaseProblems({ ...good, ...change });
    assert.equal(problems.length, 1, `one problem for ${expected}: ${problems.join("; ")}`);
    assert.match(problems[0], expected);
  }
});
