import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const { window } = new JSDOM("<!doctype html><body></body>");
Object.assign(globalThis, {
  document: window.document,
  Node: window.Node,
  Text: window.Text,
  Element: window.Element,
  HTMLElement: window.HTMLElement,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
});

const { locate, renderOriginal, renderVariant, settle, tokenize, wrapRange } = await import("./dom.ts");
const { assignTranslated, isWrittenIn, pageTarget, plainText, routeKey, sanitize, snippetHtml, splitByLineBreaks } = await import("./logic.ts");
const { DEFAULT_BINDINGS, pageKeys } = await import("../lib/keys.ts");

test("settle waits for DOM mutations to stop, up to a cap", async () => {
  const root = document.createElement("div");
  const t0 = Date.now();
  const tick = setInterval(() => root.append("x"), 10);
  setTimeout(() => clearInterval(tick), 120);
  await settle(root, 50, 1000);
  const quietAfter = Date.now() - t0;
  assert.ok(quietAfter >= 140 && quietAfter < 600, `waited ${quietAfter} ms`);

  const busy = setInterval(() => root.append("y"), 10);
  const t1 = Date.now();
  await settle(root, 50, 150);
  clearInterval(busy);
  assert.ok(Date.now() - t1 < 400, "capped while the page keeps changing");
});

test("Japanese pages translate into English, others into Japanese", () => {
  assert.equal(pageTarget("ja-JP", "English words only"), "en", "declared lang wins");
  assert.equal(pageTarget("en", "日本語の本文です"), "ja");
  assert.equal(pageTarget("", "日本語の本文で MVCC を説明する"), "en", "no lang: decided by the text");
  assert.equal(pageTarget("", "An English page about MVCC"), "ja");
  assert.equal(pageTarget("", "这是一篇关于数据库并发控制的中文文章"), "ja", "kanji without kana is Chinese");
  assert.ok(isWrittenIn("スナップショット分離", "ja") && !isWrittenIn("スナップショット分離", "en"));
  assert.ok(isWrittenIn("Snapshot isolation", "en") && !isWrittenIn("Snapshot isolation", "ja"));
  assert.ok(!isWrittenIn("GitHub Actionsによる自動化", "en") && isWrittenIn("GitHub Actionsによる自動化", "ja"));
  assert.ok(!isWrittenIn("SRE業務", "en") && !isWrittenIn("the word 改善 (kaizen)", "ja"));
  assert.ok(isWrittenIn("2026/10/21 — v1.2 beta", "en") && !isWrittenIn("Tokyo・Osaka", "ja"));
  assert.ok(!isWrittenIn("多版本并发控制让读写互不阻塞。", "ja"), "Chinese is translated into Japanese");
});

test("splitByLineBreaks splits on blank lines and after sentence ends only", () => {
  assert.deepEqual(splitByLineBreaks("One.\nTwo<br>three\n\nFour").parts, ["One.", "Two<br>three", "Four"]);
  assert.deepEqual(splitByLineBreaks("no breaks").parts, ["no breaks"]);
});

test("assignTranslated is exact by count and deterministic", () => {
  const src = Array.from({ length: 10 }, (_, i) => `s${i}`);
  for (const p of [0, 30, 70, 100]) {
    assert.equal(assignTranslated(src, p, "seed").filter(Boolean).length, p / 10);
  }
  assert.deepEqual(assignTranslated(src, 50, "seed"), assignTranslated(src, 50, "seed"));
});

test("sanitize drops scripts, handlers and unsafe URLs", () => {
  const out = sanitize(`<a href="javascript:alert(1)" onclick="x()">a</a><script>bad()</script><img src=x onerror=y><code class="k">c</code>`);
  assert.equal(out, `<a>a</a>bad()<img src="x"><code>c</code>`);
});

test("sanitize keeps http(s) links and image data URLs only, however the scheme is disguised", () => {
  const out = sanitize(
    `<a href=" JaVa&#x09;Script:alert(1)">a</a><a href="data:text/html;base64,PHNjcmlwdD4=">b</a><a href="https://x.dev/w">c</a>` +
      `<img src="data:image/png;base64,AAAA" alt="i"><img src="data:text/html;base64,AAAA"><div><iframe src="https://x.dev/"></iframe><em>d</em></div>`,
  );
  assert.equal(out, `<a>a</a><a>b</a><a href="https://x.dev/w">c</a><img src="data:image/png;base64,AAAA" alt="i"><img><em>d</em>`);
});

function block(html: string) {
  const p = document.createElement("p");
  p.innerHTML = html;
  document.body.replaceChildren(p);
  return p;
}

test("snippetHtml strips attributes, keeps links and numbers atoms", () => {
  const p = block(`The <a href="https://x.dev/w" class="k">WAL</a> <img src="i.png"> is <span class="hl">durable</span>.`);
  assert.equal(snippetHtml(p), `The <a href="https://x.dev/w">WAL</a> ⟦1⟧ is <span>durable</span>.`);
  assert.equal(plainText(snippetHtml(p)), "The WAL ⟦1⟧ is durable.");
});

test("sentences are wrapped in place and swapped without losing page elements", () => {
  const p = block(`The <a href="https://x.dev/w" class="k">WAL</a> <img src="i.png"> is durable. It <b>never</b> loses data.`);
  const img = p.querySelector("img")!;
  const isSentence = (n: Node) => n instanceof window.HTMLElement && n.classList.contains("s");
  const units = ["The WAL ⟦1⟧ is durable. ", "It never loses data."];
  let from = 0;
  const spans = units.map((u) => {
    const loc = locate(p, tokenize(p, isSentence), u, from)!;
    assert.ok(loc, u);
    const r = document.createRange();
    r.setStart(loc.start.container, loc.start.offset);
    r.setEnd(loc.end.container, loc.end.offset);
    from = loc.nextIndex;
    return wrapRange(r, "s");
  });
  assert.equal(p.querySelectorAll("span.s").length, 2);
  assert.equal(p.textContent, "The WAL  is durable. It never loses data.");

  // Same inline structure: translated text flows into the page's own <a class="k">.
  renderVariant(spans[0], `<a href="https://x.dev/w">WAL</a>⟦1⟧は永続的です。`);
  assert.equal(spans[0].querySelector("a")!.className, "k");
  assert.equal(spans[0].querySelector("a")!.textContent, "WAL");
  assert.ok(spans[0].textContent.includes("は永続的です。"));
  assert.equal(p.querySelector("img"), img, "the live image node is reused, not recreated");

  // Different structure falls back to plain text but keeps the atom.
  renderVariant(spans[1], `データを<i>決して</i>失いません。`);
  assert.equal(spans[1].textContent, "データを決して失いません。");

  renderOriginal(spans[0]);
  renderOriginal(spans[1]);
  assert.equal(p.textContent, "The WAL  is durable. It never loses data.");
  assert.equal(p.querySelector("b")!.textContent, "never");
  assert.equal(p.querySelector("img"), img);
});

test("routeKey: which keys pressed in the page go to the app, and when", () => {
  const keys = pageKeys(DEFAULT_BINDINGS);
  assert.equal(routeKey(keys, "Ctrl+K", true, false), "take", "Ctrl+K even from a page field, before the page");
  assert.equal(routeKey(keys, "Ctrl+B", false, false), "take");
  assert.equal(routeKey(keys, "J", false, false), "unlessHandled", "after the page, which may claim it");
  assert.equal(routeKey(keys, "J", true, false), null, "typing in a page field");
  assert.equal(routeKey(keys, "ArrowDown", false, false), null, "the page scrolls with arrows");
  assert.equal(routeKey(keys, "Enter", false, false), null);
  assert.equal(routeKey(keys, "Q", false, false), null, "not an app shortcut");
  assert.equal(routeKey(keys, "ArrowLeft", true, true), "take", "the key after the pane prefix");
  assert.equal(routeKey(keys, null, false, true), null, "a lone modifier");
});
