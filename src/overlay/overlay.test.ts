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
const {
  assignTranslated,
  endsSpaced,
  isWrittenIn,
  keepsAtoms,
  withAtoms,
  pageTarget,
  plainText,
  sanitize,
  snippetHtml,
  splitByLineBreaks,
  takesBeforePage,
  translatedShare,
  unitsByBlock,
} = await import("./logic.ts");
const { DEFAULT_BINDINGS, IDLE, merge, pageKeys, stepKeys } = await import("../lib/keymap.ts");

test("settle waits for a full quiet period after the last DOM mutation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const root = document.createElement("div");
  let finished = false;
  const pending = settle(root, 50, 1000).then(() => {
    finished = true;
  });
  t.mock.timers.tick(49);
  await Promise.resolve();
  assert.equal(finished, false, "the initial quiet period is not over");
  root.append("x");
  await Promise.resolve();
  t.mock.timers.tick(49);
  await Promise.resolve();
  assert.equal(finished, false, "a mutation restarts the entire quiet period");
  t.mock.timers.tick(1);
  await pending;
  assert.equal(finished, true);
});

test("settle reaches its cap while DOM mutations continue", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const root = document.createElement("div");
  let finished = false;
  const pending = settle(root, 50, 150).then(() => {
    finished = true;
  });
  for (let i = 0; i < 14; i++) {
    t.mock.timers.tick(10);
    root.append("y");
    await Promise.resolve();
    assert.equal(finished, false, "neither the cap nor a quiet period has elapsed");
  }
  t.mock.timers.tick(9);
  await Promise.resolve();
  assert.equal(finished, false, "149 ms is still before the cap");
  t.mock.timers.tick(1);
  await pending;
  assert.equal(finished, true);
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

test("a formula in a math element goes to the model as a placeholder and comes back as it was", () => {
  const p = document.createElement("p");
  const formula = document.createElement("math");
  formula.innerHTML = "<i>t<sub>abs</sub></i>(<i>e</i>)";
  p.append("The time ", formula, " of an event.");
  assert.equal(snippetHtml(p), "The time ⟦1⟧ of an event.");
  const source = "The time ⟦1⟧ of an event.";
  const loc = locate(p, tokenize(p), source)!;
  const range = document.createRange();
  range.setStart(loc.start.container, loc.start.offset);
  range.setEnd(loc.end.container, loc.end.offset);
  const span = wrapRange(range, "s");
  renderVariant(span, "イベントの時刻⟦1⟧です。");
  assert.equal(span.innerHTML, "イベントの時刻<math><i>t<sub>abs</sub></i>(<i>e</i>)</math>です。");
  assert.equal(span.querySelector("math"), formula, "the page's own element");
});

test("a translation must keep every atom of its source", () => {
  assert.ok(keepsAtoms("The time ⟦1⟧ and ⟦2⟧.", "⟦2⟧と⟦1⟧の時刻。"), "in any order");
  assert.ok(keepsAtoms("No atoms.", "アトムなし。"));
  assert.ok(!keepsAtoms("The time ⟦1⟧ and ⟦2⟧.", "⟦1⟧の時刻。"));
});

test("text for reading has each atom's own text in its place", () => {
  const atoms = new Map([[1, "tabs(e)"]]);
  assert.equal(
    withAtoms("The time ⟦1⟧ of ⟦2⟧.", (n) => atoms.get(n) ?? ""),
    "The time tabs(e) of .",
  );
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
  /** The longest stretch of units in one language. */
  const runs = (picks: boolean[]) => {
    let best = 0,
      n = 0;
    picks.forEach((v, i) => {
      n = v === picks[i - 1] ? n + 1 : 1;
      best = Math.max(best, n);
    });
    return best;
  };
  assert.equal(runs(assignTranslated(src, 50, "seed")), 1, "half and half alternates");
  assert.ok(runs(assignTranslated(src, 70, "seed")) <= 3, "no long run in one language");
});

test("the mixed percent counts the display language, the same on Japanese and English pages", () => {
  assert.equal(translatedShare(70, "ja", "ja"), 70, "an English page in a Japanese UI: 70 % translated into Japanese");
  assert.equal(translatedShare(70, "en", "ja"), 30, "a Japanese page: 30 % translated into English");
  assert.equal(translatedShare(70, "en", ""), 70, "not configured yet: the translation's share");
});

test("訳文 shows the whole translation on Japanese and English pages alike", () => {
  assert.equal(translatedShare(null, "ja", "ja"), 100);
  assert.equal(translatedShare(null, "en", "ja"), 100, "a Japanese page reads in English");
});

test("a block has its units only when every one of its parts has them", () => {
  const unit = (s: string) => ({ source: s, translation: s });
  const blocks = [{ parts: ["a", "b"] }, { parts: ["c"] }, { parts: ["d"] }];
  assert.deepEqual(unitsByBlock(blocks, [[unit("a")], [unit("b")], null, [unit("d")]]), [[unit("a"), unit("b")], null, [unit("d")]]);
  assert.deepEqual(unitsByBlock(blocks, []), [null, null, null], "no answer at all");
  assert.deepEqual(unitsByBlock([{ parts: ["a"] }], [[]]), [null], "an empty answer is none");
});

test("endsSpaced: Latin ends need a space before the next sentence, Japanese ends do not", () => {
  assert.deepEqual(["the abuse.", "isthe", "です。", "スポット", "（注）", "end "].map(endsSpaced), [true, true, false, false, false, false]);
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
  assert.equal(spans[1].querySelector("b"), null, "the emptied <b> is not left behind as an empty box");

  renderOriginal(spans[0]);
  renderOriginal(spans[1]);
  assert.equal(p.textContent, "The WAL  is durable. It never loses data.");
  assert.equal(p.querySelector("b")!.textContent, "never");
  assert.equal(p.querySelector("img"), img);
});

test("a plain-text fallback leaves no empty inline code box, and keeps elements holding atoms", () => {
  // Rust blog: "you can [get `rustup`](…) from …" translated without the link.
  const p = block(`If you can, <a href="https://x.dev/i">get <code>rustup</code></a> from <a href="https://x.dev/h"><img src="i.png"></a> here.`);
  const loc = locate(p, tokenize(p), "If you can, get rustup from ⟦1⟧ here.")!;
  const r = document.createRange();
  r.setStart(loc.start.container, loc.start.offset);
  r.setEnd(loc.end.container, loc.end.offset);
  const span = wrapRange(r, "s");
  renderVariant(span, `可能なら⟦1⟧から<code>rustup</code>を入手してください。`);
  assert.equal(span.querySelector("code"), null);
  assert.equal(span.textContent, "可能ならからrustupを入手してください。");
  assert.ok(span.querySelector("a > img"), "the link around the image survives");
  renderOriginal(span);
  assert.equal(p.querySelector("code")!.textContent, "rustup");
});

test("takesBeforePage: a second key, a repeat, a Ctrl / Alt key and a bound Space go ahead of the page; a plain key after it", () => {
  const { bindings } = pageKeys(DEFAULT_BINDINGS);
  const taken = (seq: typeof IDLE, key: string, inField = false) => {
    const step = stepKeys(bindings, seq, key, { scope: "doc", inField, now: 0 });
    return takesBeforePage(seq, key, step);
  };
  assert.equal(taken(IDLE, "Ctrl+B"), true, "may have a browser default");
  assert.equal(taken(IDLE, "Ctrl+P", true), true, "even from a page field");
  assert.equal(taken({ ...IDLE, first: "G" }, "T"), true, "the page never sees half a sequence");
  assert.equal(taken({ ...IDLE, first: "G" }, "Escape"), true);
  assert.equal(taken({ ...IDLE, repeat: { first: "Ctrl+B", until: 1, again: false } }, "Shift+H"), true, "a repeat is a second key");
  assert.equal(taken(IDLE, "J"), false, "sites with their own j keep it");
  assert.equal(taken(IDLE, "G"), false);
  assert.equal(taken(IDLE, "5"), false);
  assert.equal(taken({ ...IDLE, count: 5 }, "J"), false);

  const spaced = pageKeys(merge({ view: ["Space"], summary: ["Shift+Space Y"] })).bindings;
  const takenSpace = (key: string) => takesBeforePage(IDLE, key, stepKeys(spaced, IDLE, key, { scope: "doc", inField: false, now: 0 }));
  assert.equal(takenSpace("Space"), true, "a bound Space, whose default pages");
  assert.equal(takenSpace("Shift+Space"), true, "and the first key of a Space chord");
});
