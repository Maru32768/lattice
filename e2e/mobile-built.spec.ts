// The built phone page as crates/lattice-server serves it, under its real CSP. The dev server's page
// (mobile.spec.ts) has no CSP and injects styles of its own, so it would not notice what the policy blocks.
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const DIST = new URL("../crates/lattice-server/mobile-dist/", import.meta.url);
const SERVER = readFileSync(new URL("../crates/lattice-server/src/lib.rs", import.meta.url), "utf8");
const CSP = /const CSP: &str = "([^"]+)"/.exec(SERVER)![1];
const TYPES: Record<string, string> = { html: "text/html", js: "text/javascript", css: "text/css", webmanifest: "application/manifest+json", png: "image/png" };

const ARTICLE = {
  format: 1,
  article: { id: 1, title: "First article", original_url: "https://example.com/1", domain: "example.com", read_status: "unread", favorite: false },
  target_language: "ja",
  summary: null,
  blocks: [
    { id: 10, ordinal: 0, kind: "list_item", text: "An indented item.", attrs: { depth: 2 }, translation: "字下げした項目。" },
    { id: 11, ordinal: 1, kind: "code", text: "<script>alert(1)</script>", attrs: {}, translation: null },
  ],
};

test.use({ viewport: { width: 390, height: 844 }, locale: "ja-JP" });

test("the built page runs under the server's CSP", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") {
      violations.push(m.text());
    }
  });
  page.on("pageerror", (e) => violations.push(String(e)));
  await page.route("http://phone.test/**", (route) => {
    const path = new URL(route.request().url()).pathname.slice(1) || "index.html";
    if (path === "api/index") {
      return route.fulfill({ json: { format: 1, generated_at: 1, ui_language: "ja", applied_ops: [], articles: [ARTICLE.article] } });
    }
    if (path === "api/ops") {
      return route.fulfill({ json: { status: "applied" } });
    }
    if (path === "api/articles/1") {
      return route.fulfill({ json: ARTICLE });
    }
    return route.fulfill({
      body: readFileSync(new URL(path, DIST)),
      headers: { "content-type": TYPES[path.split(".").pop()!], "content-security-policy": CSP },
    });
  });
  await page.goto("http://phone.test/#t=secret");
  await page.getByRole("link", { name: /First article/ }).click();
  await expect(page.getByText("字下げした項目。")).toBeVisible();
  await expect(page.locator(".li")).toHaveCSS("margin-left", /^[1-9]/);
  await expect(page.getByText("<script>alert(1)</script>")).toBeVisible();
  expect(violations).toEqual([]);
});
