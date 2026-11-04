import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptsFile, fileStem } from "./files.ts";

test("a file is accepted by its extension in any case, or by its type", () => {
  assert.ok(acceptsFile({ name: "Paper.PDF", type: "" }, ".pdf,application/pdf"));
  assert.ok(acceptsFile({ name: "download", type: "application/pdf" }, ".pdf,application/pdf"));
  assert.ok(!acceptsFile({ name: "paper.pdf.txt", type: "text/plain" }, ".pdf,application/pdf"));
  assert.ok(!acceptsFile({ name: "pdf", type: "" }, ".pdf,application/pdf"));
});

test("a file's stem drops only its last extension", () => {
  assert.equal(fileStem("論文 v1.2.pdf"), "論文 v1.2");
  assert.equal(fileStem("notes"), "notes");
});
