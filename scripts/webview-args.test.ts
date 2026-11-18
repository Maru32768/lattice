import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

// WebView2 never runs under test: these read the Rust source instead.
const dir = new URL("../src-tauri/src/", import.meta.url);
const src = readdirSync(dir)
  .filter((f) => f.endsWith(".rs"))
  .map((f) => readFileSync(new URL(f, dir), "utf8"))
  .join("\n");

test("every webview builder passes WEBVIEW_ARGS, which keeps wry's --disable-features and asks for a user's input before sound, even on a site the user often played sound on", () => {
  const builders = src.match(/Webview(Window)?(Builder::(new|from_config)|::builder)\(/g) ?? [];
  const passing = src.match(/\.additional_browser_args\((crate::)?WEBVIEW_ARGS\)/g) ?? [];
  assert.ok(builders.length > 0);
  assert.equal(passing.length, builders.length);
  assert.equal((src.match(/\.additional_browser_args\(/g) ?? []).length, passing.length);
  const args = (/const WEBVIEW_ARGS: &str =\s*"([^"]*)"/.exec(src)?.[1] ?? "").split(" ");
  assert.ok(args.includes("--autoplay-policy=document-user-activation-required"));
  const disabled =
    args
      .find((a) => a.startsWith("--disable-features="))
      ?.slice("--disable-features=".length)
      .split(",") ?? [];
  for (const feature of ["msWebOOUI", "msPdfOOUI", "msSmartScreenProtection", "MediaEngagementBypassAutoplayPolicies"]) {
    assert.ok(disabled.includes(feature), feature);
  }
});

test("the app runs its scripts in a page through run_script, as eval would count as the user's input and let the page play sound", () => {
  assert.equal((src.match(/\.eval(_with_callback)?\(/g) ?? []).length, 1, "only run_script's fallback off Windows may call eval");
  assert.match(src, /#\[cfg\(not\(windows\)\)\]\s*pub\(crate\) fn run_script\([^)]*\)[^{]*\{\s*wv\.eval\(js\)/, "run_script may call eval only off Windows");
  assert.ok(!src.includes("userGesture"), "Runtime.evaluate's userGesture would count as the user's input");
});
