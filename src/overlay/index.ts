/**
 * Page overlay injected into the in-app browser. Translates the page in place, sentence by
 * sentence, without changing its layout: leaf blocks are sent as inline-HTML snippets,
 * returned reading units are wrapped in spans, and a seeded share of them shows the translation
 * (Japanese, or English on a Japanese page).
 * Hovering a sentence shows the other language; clicking that tooltip flips the sentence.
 *
 * Adapted from Mazelingo's content script (MIT License, Copyright (c) 2026 Yeq6X).
 *
 * Selecting an English word shows 単語を登録 (G56), which sends the word and its sentence to the
 * app's vocabulary.
 *
 * Runs inside untrusted pages: it only ever inserts sanitized HTML, and the backend only
 * honours its translate calls while the user has translation switched on.
 */
import { type SentenceSpan, locate, normalizeText, renderOriginal, renderVariant, settle, tokenize, wrapRange } from "./dom.ts";
import {
  type Target,
  assignTranslated,
  endsSpaced,
  isWrittenIn,
  keepsAtoms,
  pageTarget,
  plainText,
  sanitize,
  snippetHtml,
  splitByLineBreaks,
  takesBeforePage,
  translatedShare,
  unitsByBlock,
  withAtoms,
} from "./logic.ts";
import { IDLE, keyOf, stepKeys, type ActionId, type KeyStep, type PageKeys } from "../lib/keymap.ts";
import { createDocNav, type DocHost } from "../docnav/controller.ts";
import { pageScroller } from "../docnav/scroll.ts";
import type { OverlayLabels } from "../api.ts";
import { captureIn, collapse, isWord } from "../vocab/vocab.ts";

interface Unit {
  source: string;
  translation: string;
}
interface Config {
  enabled: boolean;
  /** 混在's share of text in the display language; null for 訳文. */
  percent: number | null;
  /** Tooltip text in the app's display language. */
  labels: OverlayLabels;
  /** Only what is saved shows by itself; the rest waits as `idle` for `translateBlocks`. */
  manual: boolean;
}
interface Pending {
  el: HTMLElement;
  parts: string[];
  /** Translate again even with a translation saved. */
  fresh?: boolean;
}
type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

declare global {
  interface Window {
    __lattice?: {
      configure(c: Partial<Config>): void;
      setKeys(k: PageKeys | null): void;
      scrollToText(text: string): boolean;
      translateBlocks(els: HTMLElement[], fresh: boolean): void;
      showSavedIdle(): void;
      scrollToUnfoundText(): void;
      snapshot(nonce: string, wait?: { quietMs: number; maxMs: number } | null): Promise<void>;
      /** Runs a document action in this page (`browser_run_doc`). */
      runDoc(action: ActionId, count: number): void;
    };
    __TAURI_INTERNALS__?: { invoke: Invoke };
  }
}

// Not aside: boxed sidebars inside articles are content.
const SKIP =
  "script,style,textarea,input,code,pre,noscript,svg,math,select,option,button,nav,header,footer," +
  "[role='navigation'],[role='banner'],[role='contentinfo'],[contenteditable=''],[contenteditable='true']," +
  "[translate='no'],.notranslate,[data-lattice-ui]";
const BLOCK_DISPLAY = new Set(["block", "flex", "grid", "list-item", "table", "table-row", "table-cell", "table-caption", "flow-root"]);
const SENTENCE = "lattice-sentence";
const HOVER_MS = 300;
const BATCH_PARTS = 12;
const BATCH_CHARS = 6000;
const MAX_INFLIGHT = 3;

const state = {
  config: {
    enabled: false,
    percent: 70,
    labels: {
      lang: "",
      original: "",
      translated: "",
      flip: "",
      translating: "",
      failed: "",
      retry: "",
      save_word: "",
      saved_word: "",
      outline: "",
      translate_page: "",
      retranslate_page: "",
      find: "",
    },
    manual: false,
  } as Config,
  /** Decided once per page from the first blocks seen. */
  target: null as Target | null,
  pending: [] as Pending[],
  queue: [] as Pending[][],
  inflight: 0,
  flushTimer: 0,
  started: false,
  io: null as IntersectionObserver | null,
  mo: null as MutationObserver | null,
};

const invoke: Invoke = (cmd, args) => (window.__TAURI_INTERNALS__ ? window.__TAURI_INTERNALS__.invoke(cmd, args) : Promise.reject(new Error("no IPC")));

const isSentence = (n: Node): n is SentenceSpan => n instanceof HTMLElement && n.classList.contains(SENTENCE);
const isBlock = (el: Element) => BLOCK_DISPLAY.has(getComputedStyle(el).display);

function findLeafBlocks(root: Element): HTMLElement[] {
  const out: HTMLElement[] = [];
  const walk = (el: Element) => {
    if (el.matches(SKIP) || (el instanceof HTMLElement && el.dataset.latticeBlock)) {
      return;
    }
    const kids = Array.from(el.children);
    if (kids.some(isBlock)) {
      kids.forEach(walk);
    } else if (el instanceof HTMLElement && (el.textContent ?? "").trim().length >= 2) {
      out.push(el);
    }
  };
  walk(root);
  return out;
}

// ---- translation pipeline -------------------------------------------------------------

function processRoot(root: Element) {
  if (!state.config.enabled || root.closest(SKIP)) {
    return;
  }
  state.io ??= new IntersectionObserver(
    (entries) =>
      entries.forEach((e) => {
        if (!e.isIntersecting) {
          return;
        }
        state.io!.unobserve(e.target);
        enqueue(e.target as HTMLElement);
      }),
    { rootMargin: "1000px" },
  );
  const blocks = findLeafBlocks(root);
  // Not from an empty page: the PDF viewer's paragraphs arrive after the document has loaded.
  if (blocks.length) {
    state.target ??= pageTarget(
      document.documentElement.lang,
      blocks
        .slice(0, 30)
        .map((b) => b.textContent ?? "")
        .join(" "),
    );
  }
  for (const el of blocks) {
    el.dataset.latticeBlock = "pending";
    bindBlockHover(el);
    state.io.observe(el);
  }
}

let progressTimer = 0;
/** Tells the app how far the page's translation is (blocks sent so far), for its toolbar. */
function reportProgress() {
  clearTimeout(progressTimer);
  progressTimer = window.setTimeout(() => {
    const count = (s: string) => document.querySelectorAll(`[data-lattice-block='${s}']`).length;
    const done = count("done");
    // Failed blocks are left out: they wait for a retry from their tooltip, not in the status. 原文 shows none.
    const total = state.config.enabled ? done + count("translating") : 0;
    invoke("overlay_progress", { done: Math.min(done, total), total }).catch(() => {});
  }, 200);
}

/** The snippets of a block; null when it needs no translation, now `skip`. */
function partsOf(el: HTMLElement): string[] | null {
  if (isWrittenIn(el.textContent ?? "", state.target ?? "ja")) {
    el.dataset.latticeBlock = "skip";
    return null;
  }
  const { parts } = splitByLineBreaks(snippetHtml(el));
  if (parts.length === 0 || !parts.some((p) => normalizeText(plainText(p).replace(/⟦\d+⟧/gu, "")))) {
    el.dataset.latticeBlock = "skip";
    return null;
  }
  return parts;
}

/** What to send for a block, now `translating`; null when it needs no translation. */
function prepare(el: HTMLElement, fresh: boolean): Pending | null {
  const parts = partsOf(el);
  if (!parts) {
    return null;
  }
  el.dataset.latticeBlock = "translating";
  reportProgress();
  return { el, parts, fresh };
}

function enqueue(el: HTMLElement) {
  if (!el.isConnected || !state.config.enabled) {
    return;
  }
  const pending = prepare(el, false);
  if (!pending) {
    return;
  }
  state.pending.push(pending);
  clearTimeout(state.flushTimer);
  state.flushTimer = window.setTimeout(() => void flush(), 200);
}

function batchesOf(blocks: Pending[]): Pending[][] {
  const out: Pending[][] = [];
  let batch: Pending[] = [];
  let parts = 0,
    chars = 0;
  for (const p of blocks) {
    const len = p.parts.reduce((n, s) => n + s.length, 0);
    if (batch.length && (parts + p.parts.length > BATCH_PARTS || chars + len > BATCH_CHARS)) {
      out.push(batch);
      batch = [];
      parts = chars = 0;
    }
    batch.push(p);
    parts += p.parts.length;
    chars += len;
  }
  if (batch.length) {
    out.push(batch);
  }
  return out;
}

/**
 * What is saved shows at once; only the rest waits for the LLM, whose one call can take a minute
 * and would otherwise hold up every block that shares its batch (a page's sidebar, its article's text).
 */
async function unsavedOf(blocks: Pending[]): Promise<Pending[]> {
  return (await Promise.all(batchesOf(blocks).map(showSaved))).flat();
}

function send(blocks: Pending[]) {
  state.queue.push(...batchesOf(blocks));
  pump();
}

function setIdle(blocks: Pending[]) {
  blocks.forEach((p) => (p.el.dataset.latticeBlock = "idle"));
  reportProgress();
}

async function flush() {
  const unsaved = await unsavedOf(state.pending.splice(0));
  if (state.config.manual) {
    setIdle(unsaved);
  } else {
    send(unsaved);
  }
}

/** Takes a block's sentences apart, so that its DOM is the page's own again. */
function unwrapSentences(el: HTMLElement) {
  for (const span of spansOf(el)) {
    renderOriginal(span);
    span.replaceWith(...span.childNodes);
  }
  el.normalize();
}

/**
 * Translates these blocks because the user asked, also in manual mode. `fresh`: sends them to the LLM
 * even if they are done; otherwise those stay, and what is saved shows without a call. A failed block
 * goes to the LLM too, since what is saved may be what failed. A block already being translated is left to that.
 */
function translateBlocks(els: HTMLElement[], fresh: boolean) {
  if (!state.config.enabled) {
    return;
  }
  const anew: Pending[] = [];
  const blocks: Pending[] = [];
  for (const el of els) {
    const s = el.dataset.latticeBlock;
    if (s === "translating" || (!fresh && s === "done")) {
      continue;
    }
    state.io?.unobserve(el);
    const again = fresh || s === "failed";
    if (again) {
      unwrapSentences(el);
    }
    const pending = prepare(el, again);
    if (pending) {
      (again ? anew : blocks).push(pending);
    }
  }
  send(anew);
  void unsavedOf(blocks).then(send);
}

/** The article's job has saved more: a block waiting in manual mode shows it, as it would have at load. Stays `idle` meanwhile: this runs often and asks only for what is saved. */
function showSavedIdle() {
  if (!state.config.enabled) {
    return;
  }
  const idle = Array.from(document.querySelectorAll<HTMLElement>("[data-lattice-block='idle']"));
  void unsavedOf(
    idle.flatMap((el) => {
      const parts = partsOf(el);
      return parts ? [{ el, parts, fresh: false }] : [];
    }),
  );
}

async function showSaved(batch: Pending[]): Promise<Pending[]> {
  const units = unitsByBlock(batch, await translated(batch, true));
  return batch.filter((p, i) => {
    const mine = units[i];
    // A lookup that crossed another may find the block done already.
    if (mine && p.el.isConnected && p.el.dataset.latticeBlock !== "done") {
      apply(p.el, mine);
    }
    return !mine && p.el.isConnected;
  });
}

function pump() {
  while (state.inflight < MAX_INFLIGHT && state.queue.length) {
    const batch = state.queue.shift()!;
    state.inflight++;
    void translateBatch(batch).finally(() => {
      state.inflight--;
      pump();
    });
  }
}

async function translated(batch: Pending[], cachedOnly: boolean): Promise<(Unit[] | null)[]> {
  try {
    const fresh = batch.some((p) => p.fresh) ? { fresh: true } : {};
    return (await invoke("overlay_translate", { snippets: batch.flatMap((p) => p.parts), target: state.target, cachedOnly, ...fresh })) as (Unit[] | null)[];
  } catch (e) {
    console.warn("[lattice] translate failed", e);
    return [];
  }
}

async function translateBatch(batch: Pending[]) {
  const units = unitsByBlock(batch, await translated(batch, false));
  batch.forEach((p, i) => {
    const mine = units[i];
    if (!p.el.isConnected) {
      return;
    }
    if (!mine) {
      p.el.dataset.latticeBlock = "failed";
      reportProgress();
      return;
    }
    apply(p.el, mine);
  });
}

function apply(el: HTMLElement, units: Unit[]) {
  const spans: SentenceSpan[] = [];
  let from = 0;
  for (const u of units) {
    const plain = plainText(sanitize(u.source));
    // The sentence stays in the original: a translation that lost a formula or an image would say less.
    if (!keepsAtoms(plain, u.translation)) {
      continue;
    }
    const loc = locate(el, tokenize(el, isSentence), plain, from);
    if (!loc) {
      break;
    } // page changed under us or the model altered the source; keep the rest original
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
  reportProgress();
  assignBlock(el);
}

// ---- display ------------------------------------------------------------------------------

function spansOf(el: Element): SentenceSpan[] {
  return Array.from(el.querySelectorAll<SentenceSpan>(`span.${SENTENCE}`));
}

function render(span: SentenceSpan) {
  const translated = state.config.enabled && (span.dataset.manual ? span.dataset.manual === "t" : span.dataset.default === "t");
  if (translated) {
    const html = span.dataset.translation ?? "";
    // Unit translations carry no space between sentences ("key.An"); the source's own spaces went with it.
    renderVariant(span, endsSpaced(plainText(html)) ? `${html} ` : html);
  } else {
    renderOriginal(span);
  }
  span.dataset.shown = translated ? "t" : "o";
}

function assignBlock(el: Element) {
  const spans = spansOf(el);
  const picks = assignTranslated(
    spans.map((s) => s.dataset.source ?? ""),
    translatedShare(state.config.percent, state.target ?? "ja", state.config.labels.lang),
    location.href,
  );
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
let showTimer = 0,
  hideTimer = 0;

function ensureTip() {
  if (tip) {
    return tip;
  }
  const host = document.createElement("div");
  host.dataset.latticeUi = "1";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>
    .tip{position:fixed;z-index:2147483647;max-width:min(420px,90vw);padding:10px 12px;border-radius:8px;
      font:13px/1.6 system-ui,"Segoe UI","Hiragino Sans","Yu Gothic UI",sans-serif;color:#45474C;background:#fff;
      border:1px solid #D2CFC6;box-shadow:0 10px 30px rgba(30,28,24,.14);cursor:pointer;display:none;text-align:left}
    .tip:hover{border-color:#B9B5AA}
    .head{display:flex;gap:12px;margin-bottom:2px;font-size:11px;color:#67696E}
    .head span:last-child{margin-left:auto}
    @media (prefers-color-scheme: dark){.tip{color:#C3C1BB;background:#26272A;border-color:#3B3C40}.tip:hover{border-color:#55565B}.head{color:#9A9893}}
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

/** `label` / `hint`: the header line ("Original … click to flip"); omitted when both are empty. */
function showTip(target: Element, label: string, text: string, hint: string, onClick: (() => void) | null, at?: { x: number; y: number }) {
  const t = ensureTip();
  t.target = target;
  t.onClick = onClick;
  t.box.textContent = "";
  if (label || hint) {
    const head = document.createElement("div");
    head.className = "head";
    for (const v of [label, hint]) {
      head.append(Object.assign(document.createElement("span"), { textContent: v }));
    }
    t.box.append(head);
  }
  t.box.append(text);
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
      if (!state.config.enabled || !span.matches(":hover")) {
        return;
      }
      const translated = span.dataset.shown === "t";
      const raw = translated ? (span.dataset.source ?? "") : plainText(span.dataset.translation ?? "");
      const other = withAtoms(raw, (n) => span.latticeAtoms?.get(n)?.textContent ?? "");
      const l = state.config.labels;
      showTip(
        span,
        translated ? l.original : l.translated,
        other,
        l.flip,
        () => {
          span.dataset.manual = translated ? "o" : "t";
          render(span);
        },
        at,
      );
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
    if (!state.config.enabled || (s !== "translating" && s !== "failed")) {
      return;
    }
    clearTimeout(hideTimer);
    const l = state.config.labels;
    if (s === "translating") {
      showTip(el, "", l.translating, "", null, { x: e.clientX, y: e.clientY });
    } else {
      showTip(el, "", l.failed, l.retry, () => translateBlocks([el], false), { x: e.clientX, y: e.clientY });
    }
  });
  el.addEventListener("mouseleave", () => {
    if (tip?.target === el) {
      scheduleHide();
    }
  });
}

// ---- 単語を登録 -------------------------------------------------------------------------------

let saveBtn: { host: HTMLElement; btn: HTMLButtonElement } | null = null;
let saveTimer = 0;
/** What the button saves. */
let offered: { selection: string; sentence: string } | null = null;

function ensureSaveButton() {
  if (saveBtn) {
    return saveBtn;
  }
  const host = document.createElement("div");
  host.dataset.latticeUi = "1";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>
    button{position:fixed;z-index:2147483647;display:none;transform:translate(-50%,6px);height:28px;padding:0 12px;border-radius:6px;border:1px solid #2F5D8A;
      font:500 12.5px/1 system-ui,"Segoe UI","Hiragino Sans","Yu Gothic UI",sans-serif;color:#fff;background:#2F5D8A;
      box-shadow:0 8px 24px rgba(30,28,24,.18);cursor:pointer}
    button:disabled{cursor:default;opacity:.9}
  </style><button type="button"></button>`;
  const btn = root.querySelector("button")!;
  // Keep the page's selection when the button is pressed.
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", () => {
    if (!offered) {
      return;
    }
    btn.disabled = true;
    invoke("overlay_vocab", offered)
      .then(() => {
        btn.textContent = state.config.labels.saved_word;
        saveTimer = window.setTimeout(hideSave, 1200);
      })
      .catch((e: unknown) => {
        console.warn("[lattice] save word failed", e);
        hideSave();
      });
  });
  document.documentElement.append(host);
  saveBtn = { host, btn };
  return saveBtn;
}

function hideSave() {
  clearTimeout(saveTimer);
  if (saveBtn) {
    saveBtn.btn.style.display = "none";
  }
}

/** The selected word and its sentence, cut from the nearest block around it. */
/** The PDF viewer's paragraph lying over a selection in its text layer, whose elements are a line's run each. */
function paragraphOver(range: Range, el: Element, text: string): string | null {
  const at = range.getBoundingClientRect();
  // Its middle: pdf.js rounds a run's place, so a line's first word can start just outside the paragraph's box.
  const [x, y] = [at.left + at.width / 2, at.top + at.height / 2];
  const regions = el.closest(".textLayer")?.parentElement?.querySelectorAll(".region") ?? [];
  for (const region of regions) {
    const box = region.getBoundingClientRect();
    if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom && region.textContent?.includes(text)) {
      return region.textContent;
    }
  }
  return null;
}

function selectedWord(): { selection: string; sentence: string; rect: DOMRect } | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !isWord(sel.toString())) {
    return null;
  }
  const range = sel.getRangeAt(0);
  const node = range.commonAncestorContainer;
  let block = node instanceof Element ? node : node.parentElement;
  if (!block || block.closest("input, textarea, [contenteditable=''], [contenteditable='true'], [data-lattice-ui]")) {
    return null;
  }
  while (block.parentElement && block !== document.body && !isBlock(block)) {
    block = block.parentElement;
  }
  const before = document.createRange();
  before.setStart(block, 0);
  before.setEnd(range.startContainer, range.startOffset);
  const text = sel.toString();
  // shortcut: a word the paragraph has twice is taken from its first sentence that has it, as the text layer does not say which; none has shown wrong so far.
  const paragraph = paragraphOver(range, block, text);
  const c = paragraph ? captureIn(paragraph, text, paragraph.indexOf(text)) : captureIn(block.textContent ?? "", text, before.toString().length);
  return { selection: c?.surface ?? collapse(text), sentence: c?.sentence ?? collapse(text), rect: range.getBoundingClientRect() };
}

function offerSave() {
  const word = state.config.labels.save_word ? selectedWord() : null;
  if (!word) {
    return hideSave();
  }
  const { btn } = ensureSaveButton();
  clearTimeout(saveTimer);
  btn.textContent = state.config.labels.save_word;
  btn.disabled = false;
  btn.style.left = `${Math.min(Math.max(60, word.rect.left + word.rect.width / 2), window.innerWidth - 60)}px`;
  btn.style.top = `${Math.min(word.rect.bottom, window.innerHeight - 40)}px`;
  btn.style.display = "block";
  offered = { selection: word.selection, sentence: word.sentence };
}

// ---- public API -------------------------------------------------------------------------------

function start() {
  if (state.started) {
    return processRoot(document.body);
  }
  state.started = true;
  const style = document.createElement("style");
  style.dataset.latticeUi = "1";
  style.textContent = `.${SENTENCE}{cursor:help;border-radius:2px}.${SENTENCE}:hover{background:#F4EAD9}
    .lattice-flash{outline:3px solid rgba(47,93,138,.55)!important;outline-offset:4px;transition:outline-color 1.5s}`;
  document.head?.append(style);
  processRoot(document.body);
  state.mo ??= new MutationObserver((records) => {
    for (const r of records) {
      r.addedNodes.forEach((n) => {
        if (n instanceof Element && !n.closest("[data-lattice-block],[data-lattice-ui]")) {
          processRoot(n);
        }
      });
    }
  });
  state.mo.observe(document.body, { childList: true, subtree: true });
}

/** Back/forward availability for the toolbar, from Chromium's Navigation API (absent: both stay enabled). */
function reportHistory() {
  const nav = (window as { navigation?: { canGoBack?: unknown; canGoForward?: unknown } }).navigation;
  if (typeof nav?.canGoBack !== "boolean" || typeof nav.canGoForward !== "boolean") {
    return;
  }
  invoke("overlay_history", { canGoBack: nav.canGoBack, canGoForward: nav.canGoForward }).catch(() => {});
}

// ---- app shortcuts ----------------------------------------------------------------------------
// The page's webview has keyboard focus, so the app's shortcuts are picked up here and forwarded.

let keys: PageKeys | null = null;
let keySeq = IDLE;

function setKeys(k: PageKeys | null) {
  keys = k;
  keySeq = IDLE;
}

const inField = (t: EventTarget | undefined) =>
  t instanceof HTMLElement && (t.isContentEditable || !!t.closest("input, textarea, select, [data-lattice-field]"));

/** Tells the app: a whole sequence to run, a chord's first key for its hint, or nothing ("") to hide that hint. */
const tellApp = (key: string, count = 1) => void invoke("overlay_key", { key, count }).catch(() => {});

const pageDoc: DocHost = {
  root: () => document.body,
  scroller: pageScroller,
  findLabel: () => state.config.labels.find,
  print: () => window.print(),
};
const docNav = createDocNav(() => pageDoc);

function applyStep(step: KeyStep) {
  const hinted = keySeq.first != null;
  keySeq = step.seq;
  if (step.kind === "run" && !step.action.local) {
    return tellApp(step.sequence, step.count);
  }
  if (step.kind === "run") {
    docNav.run(step.action.id, step.count);
  }
  if (step.seq.first) {
    tellApp(step.seq.first);
  } else if (hinted) {
    tellApp("");
  }
}

function onKey(e: KeyboardEvent) {
  if (e.isComposing || !keys) {
    return;
  }
  const key = keyOf(e);
  if (!key) {
    return;
  }
  if (docNav.onKey(key)) {
    e.preventDefault();
    e.stopImmediatePropagation();
    return;
  }
  // composedPath: the field itself, not its shadow host.
  const step = stepKeys(keys.bindings, keySeq, key, { scope: "doc", inField: inField(e.composedPath()[0]), now: Date.now() });
  if (step.kind === "none") {
    keySeq = step.seq;
  } else if (takesBeforePage(keySeq, key, step)) {
    e.preventDefault();
    e.stopImmediatePropagation();
    applyStep(step);
  } else {
    setTimeout(() => {
      if (e.defaultPrevented) {
        keySeq = IDLE;
      } else {
        applyStep(step);
      }
    });
  }
}

/** A press in the page ends a sequence under way. */
function onPagePress() {
  if (keySeq.first) {
    tellApp("");
  }
  keySeq = IDLE;
}

function configure(c: Partial<Config>) {
  const was = state.config;
  state.config = { ...was, ...c };
  // The PDF viewer's paragraphs take the pointer only while there is a translation to show on hover.
  document.documentElement.toggleAttribute("data-lattice-on", state.config.enabled);
  if (state.config.enabled && !was.enabled && document.body) {
    start();
  }
  if (was.enabled !== state.config.enabled || was.percent !== state.config.percent) {
    refreshAll();
  }
  if (!state.config.enabled) {
    hideTip();
  }
  if (was.enabled !== state.config.enabled) {
    reportProgress();
  }
  if (state.config.manual && !was.manual) {
    // In-flight calls were already paid for: let them finish.
    setIdle(state.queue.splice(0).flat());
  } else if (was.manual && !state.config.manual) {
    document.querySelectorAll<HTMLElement>("[data-lattice-block='idle']").forEach((el) => {
      el.dataset.latticeBlock = "pending";
      state.io?.observe(el);
    });
  }
}

/** What `scrollToText` could not find yet: the PDF viewer's paragraphs arrive after the page has loaded. */
let unfoundText: string | null = null;

function scrollToText(text: string): boolean {
  unfoundText = null;
  const needle = normalizeText(text).slice(0, 80);
  if (!needle) {
    return false;
  }
  const el = findLeafBlocks(document.body)
    .concat(Array.from(document.querySelectorAll<HTMLElement>("[data-lattice-block]")))
    .find((b) => normalizeText(b.textContent ?? "").includes(needle));
  if (!el) {
    unfoundText = text;
    return false;
  }
  el.scrollIntoView({ block: "center" });
  el.classList.add("lattice-flash");
  setTimeout(() => el.classList.remove("lattice-flash"), 2000);
  return true;
}

/**
 * Sends the rendered DOM to the app ("Indexに追加", or the background renderer, which first
 * lets the page finish rendering), with every sentence in its original language.
 */
async function snapshot(nonce: string, wait?: { quietMs: number; maxMs: number } | null) {
  // The PDF viewer's DOM is not the document: an empty answer has the app fetch the file instead.
  if (document.contentType === "application/pdf") {
    return void invoke("overlay_snapshot", { nonce, html: "" }).catch(() => {});
  }
  if (wait) {
    await settle(document.documentElement, wait.quietMs, wait.maxMs);
  }
  const shown = Array.from(document.querySelectorAll<SentenceSpan>(`span.${SENTENCE}[data-shown='t']`));
  shown.forEach(renderOriginal);
  const html = `<!DOCTYPE html>${document.documentElement.outerHTML}`;
  shown.forEach(render);
  invoke("overlay_snapshot", { nonce, html }).catch((e: unknown) => console.warn("[lattice] snapshot failed", e));
}

if (window.top === window && !window.__lattice) {
  window.__lattice = {
    configure,
    setKeys,
    scrollToText,
    translateBlocks,
    showSavedIdle,
    scrollToUnfoundText: () => unfoundText != null && scrollToText(unfoundText),
    snapshot,
    runDoc: (action, count) => docNav.run(action, count),
  };
  // WebView2's print preview opened behind the page in this child webview: the app shows the system dialog instead.
  const pagePrint = window.print.bind(window);
  window.print = () =>
    void invoke("overlay_print").then(
      (shown) => shown || pagePrint(),
      () => pagePrint(),
    );
  // Capture on window: ahead of the page's own handlers.
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("pointerdown", onPagePress, true);
  // Quietly: the app takes the keyboard to read a second key once its hint covers the page.
  window.addEventListener("blur", () => {
    keySeq = IDLE;
  });
  // After the selection settles (a click inside it collapses it only after mouseup).
  document.addEventListener("mouseup", (e) => {
    if (!e.composedPath().some((n) => n === saveBtn?.host)) {
      setTimeout(offerSave);
    }
  });
  document.addEventListener("selectionchange", () => {
    if (saveBtn && !saveBtn.btn.disabled && window.getSelection()?.isCollapsed) {
      hideSave();
    }
  });
  window.addEventListener(
    "scroll",
    () => {
      if (!saveBtn?.btn.disabled) {
        hideSave();
      }
    },
    { passive: true },
  );
  const boot = () =>
    void invoke("overlay_config")
      .then((c) => {
        const { keys: k, ...config } = c as Config & { keys: PageKeys | null };
        setKeys(k);
        configure(config);
      })
      .catch(() => {});
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
  reportHistory();
  // Same-document navigations (pushState, fragments) fire no page-load event.
  (window as { navigation?: EventTarget }).navigation?.addEventListener("currententrychange", reportHistory);
}
