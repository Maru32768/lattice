// Run with `npm test` (Node strips the types natively).
import { test } from "node:test";
import assert from "node:assert/strict";
import { skippedLines } from "./urlLines.ts";

test("pasted lines without an http(s) URL are counted by why", () => {
  const text = "https://a.dev/post\n\nnot-a-url at all\r\nftp://example.com/file\nsee http://b.dev/x\n  \nexample.com/feed\n";
  assert.deepEqual(skippedLines(text), { scheme: 1, noUrl: 2 });
  assert.deepEqual(skippedLines("https://a.dev\nhttp://b.dev"), { scheme: 0, noUrl: 0 });
});
