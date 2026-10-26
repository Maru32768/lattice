import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function verifyUpdater(publicKey, signature, content) {
  const keyLines = Buffer.from(publicKey.trim(), "base64").toString("utf8").split(/\r?\n/);
  const sigLines = Buffer.from(signature.trim(), "base64").toString("utf8").split(/\r?\n/);
  const key = Buffer.from(keyLines[1] ?? "", "base64");
  const sig = Buffer.from(sigLines[1] ?? "", "base64");
  const global = Buffer.from(sigLines[3] ?? "", "base64");
  const comment = sigLines[2] ?? "";
  if (key.length !== 42 || sig.length !== 74 || global.length !== 64 || !comment.startsWith("trusted comment: ")) {
    throw new Error("Invalid updater public key or signature format");
  }
  if (key.subarray(0, 2).toString() !== "Ed" || !["Ed", "ED"].includes(sig.subarray(0, 2).toString())) {
    throw new Error("Unsupported updater signature algorithm");
  }
  if (!key.subarray(2, 10).equals(sig.subarray(2, 10))) {
    throw new Error("Updater public key does not match the signing key");
  }
  const publicKeyObject = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key.subarray(10)]),
    format: "der",
    type: "spki",
  });
  const message = sig.subarray(0, 2).toString() === "ED" ? createHash("blake2b512").update(content).digest() : content;
  if (!verify(null, message, publicKeyObject, sig.subarray(10))) {
    throw new Error("Updater signature verification failed");
  }
  const trusted = Buffer.concat([sig.subarray(10), Buffer.from(comment.slice("trusted comment: ".length))]);
  if (!verify(null, trusted, publicKeyObject, global)) {
    throw new Error("Updater signature comment verification failed");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [keyFile, signatureFile, signedFile] = process.argv.slice(2);
    if (!keyFile || !signatureFile || !signedFile) {
      throw new Error("Usage: node scripts/verify-updater.mjs <public-key-file> <signature-file> <signed-file>");
    }
    verifyUpdater(readFileSync(keyFile, "utf8"), readFileSync(signatureFile, "utf8"), readFileSync(signedFile));
    console.log("Updater signature verified");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
