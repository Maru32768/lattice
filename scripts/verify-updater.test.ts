import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { verifyUpdater } from "./verify-updater.ts";

function signed(prehashed: boolean) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = Buffer.from("01234567");
  const rawKey = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const content = Buffer.from("Lattice installer contents");
  const message = prehashed ? createHash("blake2b512").update(content).digest() : content;
  const signature = sign(null, message, privateKey);
  const comment = "timestamp:123\tfile:installer.exe\tprehashed";
  const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
  const publicText = `untrusted comment: public key\n${Buffer.concat([Buffer.from("Ed"), keyId, rawKey]).toString("base64")}\n`;
  const sigText = `untrusted comment: signature\n${Buffer.concat([Buffer.from(prehashed ? "ED" : "Ed"), keyId, signature]).toString("base64")}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`;
  return { key: Buffer.from(publicText).toString("base64"), signature: Buffer.from(sigText).toString("base64"), content };
}

test("updater verification accepts raw and prehashed Minisign signatures and rejects modified content", () => {
  for (const prehashed of [false, true]) {
    const fixture = signed(prehashed);
    assert.doesNotThrow(() => verifyUpdater(fixture.key, fixture.signature, fixture.content));
    assert.throws(() => verifyUpdater(fixture.key, fixture.signature, Buffer.from("modified installer")), /verification failed/);
    assert.throws(() => verifyUpdater(signed(prehashed).key, fixture.signature, fixture.content), /verification failed/);
    const modifiedComment = Buffer.from(fixture.signature, "base64").toString().replace("timestamp:123", "timestamp:124");
    assert.throws(() => verifyUpdater(fixture.key, Buffer.from(modifiedComment).toString("base64"), fixture.content), /comment verification failed/);
  }
});
