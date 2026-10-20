import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ENGINE, homeOf, toNavigation, validTemplate } from "./engines.ts";

const ddg = DEFAULT_ENGINE;

test("toNavigation: URLs as typed, hosts get https://, everything else is searched", () => {
  assert.equal(toNavigation("https://example.com/a?b=1", ddg), "https://example.com/a?b=1");
  assert.equal(toNavigation("  HTTP://Example.com  ", ddg), "http://example.com/");
  assert.equal(toNavigation("example.com", ddg), "https://example.com/");
  assert.equal(toNavigation("ja.wikipedia.org/wiki/MVCC#x", ddg), "https://ja.wikipedia.org/wiki/MVCC#x");
  assert.equal(toNavigation("localhost:3000/x", ddg), "https://localhost:3000/x");
  assert.equal(toNavigation("192.168.0.1", ddg), "https://192.168.0.1/");
  assert.equal(toNavigation("snapshot isolation", ddg), "https://duckduckgo.com/?q=snapshot%20isolation");
  assert.equal(toNavigation("v1.2", ddg), "https://duckduckgo.com/?q=v1.2", "a numeric TLD is not a host");
  assert.equal(toNavigation("example.com is down", ddg), "https://duckduckgo.com/?q=example.com%20is%20down");
  assert.equal(toNavigation("日本語 & c++", ddg), `https://duckduckgo.com/?q=${encodeURIComponent("日本語 & c++")}`);
  assert.equal(toNavigation("   ", ddg), null);
});

test("toNavigation never leaves http(s)", () => {
  assert.equal(toNavigation("javascript:alert(1)", ddg), "https://duckduckgo.com/?q=javascript%3Aalert(1)");
  assert.equal(toNavigation("file:///C:/Windows", ddg), `https://duckduckgo.com/?q=${encodeURIComponent("file:///C:/Windows")}`);
  assert.equal(toNavigation("http://", ddg), null);
  assert.equal(toNavigation("q", { id: "custom", custom: "javascript:%s" }), "https://duckduckgo.com/?q=q", "an unusable template falls back");
});

test("engines: built-in and custom search and home pages", () => {
  assert.equal(toNavigation("a b", { id: "google", custom: "" }), "https://www.google.com/search?q=a%20b");
  assert.equal(homeOf({ id: "kagi", custom: "" }), "https://kagi.com/");
  const custom = { id: "custom" as const, custom: "https://search.example.org/find?q=%s&lang=ja" };
  assert.equal(toNavigation("$1 %s", custom), "https://search.example.org/find?q=%241%20%25s&lang=ja");
  assert.equal(homeOf(custom), "https://search.example.org/");
  assert.ok(validTemplate(custom.custom));
  assert.ok(!validTemplate("https://search.example.org/find"), "no %s");
  assert.ok(!validTemplate("ftp://x/%s"));
  assert.equal(homeOf({ id: "custom", custom: "" }), "https://duckduckgo.com/");
});
