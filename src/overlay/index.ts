/**
 * Page overlay injected into the in-app browser. Translates the page in place, sentence by
 * sentence, without changing its layout: leaf blocks are sent as inline-HTML snippets,
 * returned reading units are wrapped in spans, and a seeded share of them shows Japanese.
 * Hovering a sentence shows the other language; clicking that tooltip flips the sentence.
 *
 * Adapted from Mazelingo's content script (MIT License, Copyright (c) 2026 Yeq6X).
 *
 * Runs inside untrusted pages: it only ever inserts sanitized HTML, and the backend only
 * honours its translate calls while the user has translation switched on.
 */
import { type SentenceSpan, locate, normalizeText, renderOriginal, renderVariant, tokenize, wrapRange } from "./dom.ts";
import { assignTranslated, isCjkDominant, plainText, sanitize, snippetHtml, splitByLineBreaks } from "./logic.ts";

interface Unit {
  source: string;
  translation: string;
}
interface Config {
  enabled: boolean;
  percent: number;
}
interface Pending {
  el: HTMLElement;
  parts: string[];
}
type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

declare global {
  interface Window {
    __lattice?: { configure(c: Partial<Config>): void; scrollToText(text: string): boolean };
    __TAURI_INTERNALS__?: { invoke: Invoke };
  }
}

const SKIP =
  "script,style,textarea,input,code,pre,noscript,svg,math,select,option,button,nav,header,footer,aside," +
  "[role='navigation'],[role='banner'],[role='contentinfo'],[contenteditable=''],[contenteditable='true']," +
  "[translate='no'],.notranslate,[data-lattice-ui]";
const BLOCK_DISPLAY = new Set(["block", "flex", "grid", "list-item", "table", "table-row", "table-cell", "table-caption", "flow-root"]);
const SENTENCE = "lattice-sentence";
const HOVER_MS = 300;
const BATCH_PARTS = 12;
const BATCH_CHARS = 6000;
const MAX_INFLIGHT = 3;

const state = {
  config: { enabled: false, percent: 70 } as Config,
  pending: [] as Pending[],
  queue: [] as Pending[][],
  inflight: 0,
  flushTimer: 0,
  started: false,
  io: null as IntersectionObserver | null,
  mo: null as MutationObserver | null,
};

const invoke: Invoke = (cmd, args) =>
  window.__TAURI_INTERNALS__ ? window.__TAURI_INTERNALS__.invoke(cmd, args) : Promise.reject(new Error("no IPC"));

const isSentence = (n: Node): n is SentenceSpan => n instanceof HTMLElement && n.classList.contains(SENTENCE);
const isBlock = (el: Element) => BLOCK_DISPLAY.has(getComputedStyle(el).display);

function findLeafBlocks(root: Element): HTMLElement[] {
  const out: HTMLElement[] = [];
  const walk = (el: Element) => {
    if (el.matches(SKIP) || (el instanceof HTMLElement && el.dataset.latticeBlock)) return;
    const kids = Array.from(el.children);
    if (kids.some(isBlock)) kids.forEach(walk);
    else if (el instanceof HTMLElement && (el.textContent ?? "").trim().length >= 2) out.push(el);
  };
  walk(root);
  return out;
}

// ---- translation pipeline -------------------------------------------------------------

function processRoot(root: Element) {
  if (!state.config.enabled || root.closest(SKIP)) return;
  state.io ??= new IntersectionObserver(
    (entries) => entries.forEach((e) => {
      if (!e.isIntersecting) return;
      state.io!.unobserve(e.target);
      enqueue(e.target as HTMLElement);
    }),
    { rootMargin: "1000px" },
  );
  for (const el of findLeafBlocks(root)) {
    el.dataset.latticeBlock = "pending";
    bindBlockHover(el);
    state.io.observe(el);
  }
}

function enqueue(el: HTMLElement) {
  if (!el.isConnected || !state.config.enabled) return;
  if (isCjkDominant(el.textContent ?? "")) {
    el.dataset.latticeBlock = "skip"; // already Japanese
    return;
  }
  const { parts } = splitByLineBreaks(snippetHtml(el));
  if (parts.length === 0 || !parts.some((p) => normalizeText(plainText(p).replace(/⟦\d+⟧/gu, "")))) {
    el.dataset.latticeBlock = "skip";
    return;
  }
  el.dataset.latticeBlock = "translating";
  state.pending.push({ el, parts });
  clearTimeout(state.flushTimer);
  state.flushTimer = window.setTimeout(flush, 200);
}

function flush() {
  let batch: Pending[] = [];
  let parts = 0, chars = 0;
  for (const p of state.pending.splice(0)) {
    const len = p.parts.reduce((n, s) => n + s.length, 0);
    if (batch.length && (parts + p.parts.length > BATCH_PARTS || chars + len > BATCH_CHARS)) {
      state.queue.push(batch);
      batch = [];
      parts = chars = 0;
    }
    batch.push(p);
    parts += p.parts.length;
    chars += len;
  }
  if (batch.length) state.queue.push(batch);
  pump();
}

function pump() {
  while (state.inflight < MAX_INFLIGHT && state.queue.length) {
    const batch = state.queue.shift()!;
    state.inflight++;
    translateBatch(batch).finally(() => {
      state.inflight--;
      pump();
    });
  }
}

async function translateBatch(batch: Pending[]) {
  const snippets = batch.flatMap((p) => p.parts);
  let results: (Unit[] | null)[] = [];
  try {
    results = (await invoke("overlay_translate", { snippets })) as (Unit[] | null)[];
  } catch (e) {
    console.warn("[lattice] translate failed", e);
  }
  let offset = 0;
  for (const p of batch) {
    const mine = results.slice(offset, offset + p.parts.length);
    offset += p.parts.length;
    if (!p.el.isConnected) continue;
    if (mine.length !== p.parts.length || mine.some((r) => !r?.length)) {
      p.el.dataset.latticeBlock = "failed";
      continue;
    }
    apply(p.el, mine.flat() as Unit[]);
  }
}

function apply(el: HTMLElement, units: Unit[]) {
  const spans: SentenceSpan[] = [];
  let from = 0;
  for (const u of units) {
    const plain = plainText(sanitize(u.source));
    const loc = locate(el, tokenize(el, isSentence), plain, from);
    if (!loc) break; // page changed under us or the model altered the source; keep the rest original
    const range = document.createRange();
    range.setStart(loc.start.container, loc.start.offset);
    range.setEnd(loc.end.container, loc.end.offset);
    const span = wrapRange(range, SENTENCE);
    span.dataset.source = normalizeText(plain);
    span.dataset.translation = sanitize(u.translation);
    bindSentenceHover(span);
    spans.push(span);
    from = loc.nextIndex;
  }
  el.dataset.latticeBlock = spans.length ? "done" : "failed";
  assignBlock(el);
}

// ---- display ------------------------------------------------------------------------------

function spansOf(el: Element): SentenceSpan[] {
  return Array.from(el.querySelectorAll<SentenceSpan>(`span.${SENTENCE}`));
}

function render(span: SentenceSpan) {
  const translated = state.config.enabled && (span.dataset.manual ? span.dataset.manual === "t" : span.dataset.default === "t");
  if (translated) renderVariant(span, span.dataset.translation ?? "");
  else renderOriginal(span);
  span.dataset.shown = translated ? "t" : "o";
}

function assignBlock(el: Element) {
  const spans = spansOf(el);
  const picks = assignTranslated(spans.map((s) => s.dataset.source ?? ""), state.config.percent, location.href);
  spans.forEach((s, i) => {
    s.dataset.default = picks[i] ? "t" : "o";
    render(s);
  });
}

function refreshAll() {
  document.querySelectorAll<HTMLElement>("[data-lattice-block='done']").forEach((el) => {
    spansOf(el).forEach((s) => delete s.dataset.manual);
    assignBlock(el);
  });
}

// ---- tooltip --------------------------------------------------------------------------------

let tip: { host: HTMLElement; box: HTMLElement; target: Element | null; onClick: (() => void) | null } | null = null;
let showTimer = 0, hideTimer = 0;

function ensureTip() {
  if (tip) return tip;
  const host = document.createElement("div");
  host.dataset.latticeUi = "1";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>
    .tip{position:fixed;z-index:2147483647;max-width:min(36em,90vw);padding:8px 14px;border-radius:10px;
      font:13px/1.55 system-ui,"Segoe UI","Hiragino Sans","Yu Gothic UI",sans-serif;color:#1f1d1a;background:#fff;
      border:1px solid #dedad0;box-shadow:0 6px 24px rgba(0,0,0,.14);cursor:pointer;display:none}
    .tip:hover{background:#f3f6fb}
    .hint{display:block;margin-top:4px;font-size:11px;color:#6b665d}
    @media (prefers-color-scheme: dark){.tip{color:#e8e4dc;background:#2b2a27;border-color:#3a3834}.tip:hover{background:#33322e}.hint{color:#9b958a}}
  </style><div class="tip" role="tooltip"></div>`;
  const box = root.querySelector<HTMLElement>(".tip")!;
  box.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  box.addEventListener("mouseleave", scheduleHide);
  box.addEventListener("click", (e) => {
    e.stopPropagation();
    tip?.onClick?.();
    hideTip();
  });
  document.documentElement.append(host);
  tip = { host, box, target: null, onClick: null };
  return tip;
}

function showTip(target: Element, text: string, hint: string, onClick: (() => void) | null, at?: { x: number; y: number }) {
  const t = ensureTip();
  t.target = target;
  t.onClick = onClick;
  t.box.textContent = text;
  if (hint) {
    const h = document.createElement("span");
    h.className = "hint";
    h.textContent = hint;
    t.box.append(h);
  }
  t.box.style.display = "block";
  const r = target.getBoundingClientRect();
  const box = t.box.getBoundingClientRect();
  const x = Math.min(Math.max(8, (at?.x ?? r.left) - 24), window.innerWidth - box.width - 8);
  const above = r.top - box.height - 8;
  t.box.style.left = `${x}px`;
  t.box.style.top = `${above >= 8 ? above : r.bottom + 8}px`;
}

function hideTip() {
  clearTimeout(showTimer);
  if (tip) {
    tip.box.style.display = "none";
    tip.target = null;
  }
}

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = window.setTimeout(hideTip, 150);
}

function bindSentenceHover(span: SentenceSpan) {
  let at = { x: 0, y: 0 };
  span.addEventListener("mousemove", (e) => (at = { x: e.clientX, y: e.clientY }));
  span.addEventListener("mouseenter", (e) => {
    at = { x: e.clientX, y: e.clientY };
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    showTimer = window.setTimeout(() => {
      if (!state.config.enabled || !span.matches(":hover")) return;
      const translated = span.dataset.shown === "t";
      const other = translated ? span.dataset.source ?? "" : plainText(span.dataset.translation ?? "");
      showTip(span, other, translated ? "クリックで原文に切替" : "クリックで訳文に切替", () => {
        span.dataset.manual = translated ? "o" : "t";
        render(span);
      }, at);
    }, HOVER_MS);
  });
  span.addEventListener("mouseleave", () => {
    clearTimeout(showTimer);
    scheduleHide();
  });
}

function bindBlockHover(el: HTMLElement) {
  el.addEventListener("mouseenter", (e) => {
    const s = el.dataset.latticeBlock;
    if (!state.config.enabled || (s !== "translating" && s !== "failed")) return;
    clearTimeout(hideTimer);
    if (s === "translating") showTip(el, "翻訳中…", "", null, { x: e.clientX, y: e.clientY });
    else showTip(el, "翻訳に失敗しました", "クリックで再試行", () => {
      el.dataset.latticeBlock = "pending";
      enqueue(el);
    }, { x: e.clientX, y: e.clientY });
  });
  el.addEventListener("mouseleave", () => {
    if (tip?.target === el) scheduleHide();
  });
}

// ---- public API -------------------------------------------------------------------------------

function start() {
  if (state.started) return processRoot(document.body);
  state.started = true;
  const style = document.createElement("style");
  style.dataset.latticeUi = "1";
  style.textContent = `.${SENTENCE}{cursor:help;border-radius:2px}.${SENTENCE}:hover{background:rgba(47,93,138,.12)}
    .lattice-flash{outline:3px solid rgba(47,93,138,.55)!important;outline-offset:4px;transition:outline-color 1.5s}`;
  document.head?.append(style);
  processRoot(document.body);
  state.mo ??= new MutationObserver((records) => {
    for (const r of records) {
      r.addedNodes.forEach((n) => {
        if (n instanceof Element && !n.closest("[data-lattice-block],[data-lattice-ui]")) processRoot(n);
      });
    }
  });
  state.mo.observe(document.body, { childList: true, subtree: true });
}

function configure(c: Partial<Config>) {
  const was = state.config;
  state.config = { ...was, ...c };
  if (state.config.enabled && !was.enabled && document.body) start();
  if (was.enabled !== state.config.enabled || was.percent !== state.config.percent) refreshAll();
  if (!state.config.enabled) hideTip();
}

function scrollToText(text: string): boolean {
  const needle = normalizeText(text).slice(0, 80);
  if (!needle) return false;
  const el = findLeafBlocks(document.body)
    .concat(Array.from(document.querySelectorAll<HTMLElement>("[data-lattice-block]")))
    .find((b) => normalizeText(b.textContent ?? "").includes(needle));
  if (!el) return false;
  el.scrollIntoView({ block: "center" });
  el.classList.add("lattice-flash");
  setTimeout(() => el.classList.remove("lattice-flash"), 2000);
  return true;
}

if (window.top === window && !window.__lattice) {
  window.__lattice = { configure, scrollToText };
  const boot = () =>
    invoke("overlay_config")
      .then((c) => configure(c as Config))
      .catch(() => {});
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
}
