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
import { FINDS_INSIDE, needle } from "../lib/places.ts";
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
  opensBrowserPrint,
  takesBeforePage,
  translatedShare,
  unitsByBlock,
  withAtoms,
} from "./logic.ts";
import { IDLE, REPEAT_MS, keyOf, passesOn, spacePages, stepKeys, type ActionId, type KeyStep, type PageKeys } from "../lib/keymap.ts";
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
      /** Without `at`, a search result's: centred and flashed. With it, a reading place's: that far down the block, on the reading line. */
      scrollToText(text: string, at?: number): boolean;
      translateBlocks(els: HTMLElement[], fresh: boolean): void;
      showSavedIdle(): void;
      scrollToUnfoundText(): void;
      snapshot(nonce: string, wait?: { quietMs: number; maxMs: number } | null): Promise<void>;
      /** Runs a document action in this page (`browser_run_doc`). */
      runDoc(action: ActionId, count: number): void;
      /** Opens the repeat window of a chord the app read for this page (`browser_repeat_keys`). */
      repeatKeys(first: string): void;
      /** The PDF viewer's: draws the text of all its pages. */
      allText?(more: () => void): void;
      /** The PDF viewer's: changes when its text does. */
      textVersion?(): number;
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
/** How long a page must rest before its reading place goes to the app. */
const PLACE_MS = 250;

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
  offered = null;
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
  saveWord: () => {
    offerSave();
    saveBtn?.btn.click();
  },
  ask: (quote) => void invoke("overlay_ask", { quote }).catch(() => {}),
  history: (d) => history.go(d),
  print: () => window.print(),
  allText: (more) => window.__lattice?.allText?.(more),
  textVersion: () => window.__lattice?.textVersion?.(),
};
const docNav = createDocNav(() => pageDoc);

/** `hinted`: whether the app was showing the sequence's hint when the key came. */
function applyStep(step: KeyStep, hinted: boolean) {
  if (step.kind === "run" && !step.action.local) {
    return tellApp(step.sequence, step.count);
  }
  // The hint first: labels take a moment to collect, and past its delay it would take the keyboard from under them.
  if (step.seq.first) {
    // On a busy page this runs after the next key, and a hint for a sequence already over would stay up.
    if (keySeq === step.seq) {
      tellApp(step.seq.first);
    }
  } else if (hinted) {
    tellApp("");
  }
  if (step.kind === "run") {
    docNav.run(step.action.id, step.count);
  }
}

/**
 * The browser defaults of a key that neither the overlay nor the page took. WebView2's own print preview opens behind the page in this
 * child webview, so a print key goes to the system dialog, as `window.print` does here. Space would page, which Lattice does with
 * Ctrl+F instead; on a button it still presses. After the page: with `print` unbound, Ctrl+Shift+P can be a web editor's command palette,
 * and a page may use Space itself.
 * shortcut: a page's own listener on window runs after this one, upgrade if a site needs it.
 */
function defaultsUnclaimed(e: KeyboardEvent) {
  const key = keyOf(e);
  if (e.defaultPrevented || !key) {
    return;
  }
  // composedPath: the field itself, not its shadow host.
  const target = e.composedPath()[0];
  if (opensBrowserPrint(key)) {
    e.preventDefault();
    window.print();
  } else if (target instanceof Element && spacePages(key, target, inField(target))) {
    e.preventDefault();
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
  const target = e.composedPath()[0];
  const field = inField(target);
  // The way out of a field that `f` or `gi` went into, unless the page has a use for Esc there.
  if (key === "Escape" && field) {
    setTimeout(() => {
      if (!e.defaultPrevented) {
        (target as HTMLElement).blur();
      }
    });
  }
  const step = stepKeys(keys.bindings, keySeq, key, { scope: "doc", inField: field, now: Date.now() });
  const taken = takesBeforePage(keySeq, key, step);
  const hinted = keySeq.first != null;
  // Now and not in the timer: on a busy page the next key of a chord or a count comes before it fires.
  keySeq = step.seq;
  if (step.kind === "none") {
    return;
  }
  if (taken) {
    e.preventDefault();
    e.stopImmediatePropagation();
    applyStep(step, hinted);
  } else if (passesOn(step, key)) {
    // The page has the key; the app only drops the hint it would show, which takes the keyboard.
    tellApp("");
  } else {
    setTimeout(() => {
      if (!e.defaultPrevented) {
        applyStep(step, hinted);
      } else if (keySeq === step.seq) {
        keySeq = IDLE;
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
let unfound: { text: string; at?: number; reader?: ReturnType<typeof watchReader> } | null = null;

/** Tries what was not found again (the PDF viewer, once it has drawn its pages); a place only while the reader has not moved. */
function scrollToUnfound(until?: number) {
  if (unfound?.reader?.moved()) {
    unfound.reader.stop();
    unfound = null;
  }
  return unfound != null && scrollToText(unfound.text, unfound.at, until);
}

/** How long a place not found is looked for again, each time the page settles: a page may fetch its text, or show it late. */
const LOOK_MS = 5000;

/** A block's text in the page's own language: a sentence that shows its translation keeps its original aside. */
function originalText(n: Node): string {
  if (n instanceof HTMLElement && n.classList.contains(SENTENCE) && n.dataset.shown === "t") {
    return (n as SentenceSpan).latticeOriginal?.textContent ?? "";
  }
  return n.nodeType === Node.TEXT_NODE ? (n.nodeValue ?? "") : Array.from(n.childNodes, originalText).join("");
}

function scrollToText(text: string, at?: number, until = Date.now() + LOOK_MS): boolean {
  unfound?.reader?.stop();
  unfound = null;
  const want = needle(text);
  if (!want) {
    return false;
  }
  const blocks = pageBlocks();
  const texts = blocks.map((b) => normalizeText(originalText(b)));
  const place = at !== undefined;
  // A place names its block by the block's start; a search result's passage may lie anywhere in it.
  // A block not shown (yet: the page may reveal its text by script) is not a place, nor a hidden copy before the shown one.
  const shown = (k: number) => !place || blocks[k]!.getClientRects().length > 0;
  // The block that is that start, before one that only begins with it (a heading "Usage", a paragraph "Usage of the
  // API…"), and one that holds it only when it is long enough to tell. A short start begins a block only when no word
  // follows it (a heading drawn as "Installation¶"): a table cell's "No" is not "No such file…" nor "Note that…".
  // shortcut: two blocks of the same text (a table of contents) go to the first.
  const inside = !place || want.length >= FINDS_INSIDE;
  const begins = (t: string) => t.startsWith(want) && (inside || !/[\p{L}\p{N}]/u.test(t.slice(want.length)));
  const exactly = place ? texts.findIndex((t, k) => t.startsWith(want) && needle(t) === want && shown(k)) : -1;
  const i = exactly >= 0 ? exactly : place ? texts.findIndex((t, k) => begins(t) && shown(k)) : -1;
  const el = blocks[i >= 0 ? i : inside ? texts.findIndex((t, k) => t.includes(want) && shown(k)) : -1];
  if (!el) {
    // A place waits only until the reader moves the page: from then on, where they are is the place.
    unfound = { text, at, reader: place ? watchReader() : undefined };
    // A page that draws or shows its text after it has loaded: again each time it settles, for a few seconds. Only the
    // newest try goes on (the PDF viewer tries again itself once it has drawn).
    const mine = unfound;
    if (place && Date.now() < until) {
      void settle(document.documentElement, 400, until - Date.now()).then(() => unfound === mine && scrollToUnfound(until));
    }
    return false;
  }
  if (at === undefined) {
    el.scrollIntoView({ block: "center" });
    el.classList.add("lattice-flash");
    setTimeout(() => el.classList.remove("lattice-flash"), 2000);
  } else {
    holdPlace(el, at);
  }
  return true;
}

/** The page's leaf blocks, those the translation has taken too, in the page's order; `keep` picks before the sort, which costs most on a page of thousands. */
function pageBlocks(keep: (block: HTMLElement) => boolean = () => true): HTMLElement[] {
  return findLeafBlocks(document.body)
    .concat(Array.from(document.querySelectorAll<HTMLElement>("[data-lattice-block]")))
    .filter(keep)
    .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
}

const READER_MOVED = "lattice-reader-moved";

/** Whether the reader moves the page (wheel, keys, pointer, touch) from now until `stop`; the page's own scrolling is not them. */
function watchReader() {
  let moved = false;
  const mark = () => {
    moved = true;
  };
  // READER_MOVED: the app's own keys, which scroll the page with no event of the page's (runDoc).
  const events = ["wheel", "keydown", "pointerdown", "touchstart", READER_MOVED];
  events.forEach((e) => addEventListener(e, mark, { capture: true, passive: true }));
  return { moved: () => moved, stop: () => events.forEach((e) => removeEventListener(e, mark, true)) };
}

/** Where the last place was put, until the page moves from it: a report from there would only name it again, perhaps by another block. */
let placed: { scroller: Element; top: number } | null = null;

/**
 * Puts `at` of `el` on the reading line, and keeps it there while the page still lays itself out (pictures arriving, the
 * PDF viewer sizing its pages, which moved a place there by half a screen), until the reader moves the page or a moment passes.
 */
function holdPlace(el: Element, at: number) {
  const scroller = scrollerOf(el);
  const reader = watchReader();
  const align = () => {
    const r = el.getBoundingClientRect();
    // Gone or hidden (the page drew its text again): an empty box would pull the page up by the line each time.
    if (reader.moved() || !el.isConnected || r.height === 0) {
      return stop();
    }
    const off = r.top + at * r.height - readingLine();
    if (Math.abs(off) >= 1) {
      // Not smooth, whatever the page's CSS says: where it lands is what `placed` keeps.
      scroller.scrollBy({ top: off, behavior: "instant" });
    }
    placed = { scroller, top: scroller.scrollTop };
  };
  const sizes = new ResizeObserver(align);
  const stop = () => {
    sizes.disconnect();
    clearTimeout(timer);
    reader.stop();
  };
  const timer = setTimeout(stop, 3000);
  // What grows as the page lays itself out: the block, the page, or the box that scrolls it. Watched before the first
  // align, so that a hold which stops at once also stops watching.
  const page = scroller === document.scrollingElement;
  [el, document.documentElement, document.body, page ? null : scroller.firstElementChild].forEach((box) => box && sizes.observe(box));
  align();
}

/**
 * Where a place is read in a page: a little below the top, clear of the fixed header many sites have. The Reader reads
 * at its top edge; the same block comes up at either.
 */
const readingLine = () => innerHeight * 0.15;

/** What scrolls `el`: the nearest scrolling box around it (an app that scrolls a box of its own), else the page. */
function scrollerOf(el: Element): Element {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    if (p.scrollHeight > p.clientHeight && /auto|scroll/u.test(getComputedStyle(p).overflowY)) {
      return p;
    }
  }
  return document.scrollingElement ?? document.documentElement;
}

/**
 * Whether `el` is inside what the translation leaves alone (a line of the PDF viewer's text layer, whose spans lay out as
 * blocks; a site's header), as findLeafBlocks looks: from the body down, so a page may say translate="no" on html.
 */
function skipped(el: Element): Element | null {
  for (let e: Element | null = el; e && e !== document.documentElement; e = e.parentElement) {
    if (e.matches(SKIP)) {
      return e;
    }
  }
  return null;
}

/** The leaf block `el` is in: a paragraph the translation would take, or one it has. */
function blockAround(el: Element): HTMLElement | null {
  for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
    if (e instanceof HTMLElement && (e.dataset.latticeBlock || (isBlock(e) && !Array.from(e.children).some(isBlock)))) {
      return e;
    }
  }
  return null;
}

/** The block on the reading line, or the first below it, and how far down it the line is: the page's reading place. */
function placeHere(): { text: string; at: number } | null {
  const line = readingLine();
  const placeOf = (block: HTMLElement | null) => {
    const text = block && needle(originalText(block));
    const r = block?.getBoundingClientRect();
    // A block below the line is put about there, not as many of its heights down: the Reader measures by its own.
    return text && r ? { text, at: r.height > 0 ? Math.max(-1, (line - r.top) / r.height) : 0 } : null;
  };
  /** Set when a probe met a layer marked not to translate: the PDF viewer's text layer, over its paragraphs. */
  let layered = false;
  const probe = (y: number) => {
    for (const x of [0.5, 0.35, 0.65]) {
      const hit = document.elementFromPoint(innerWidth * x, y);
      const skip = hit && skipped(hit);
      if (skip) {
        layered ||= skip.matches("[translate='no'],.notranslate");
        continue;
      }
      const place = hit && placeOf(blockAround(hit));
      if (place) {
        return place;
      }
    }
    return null;
  };
  // Paragraphs the pointer passes through (the PDF viewer's, under its text layer, until the translation takes them):
  // found by where they are, in reading order (of two columns on the line, the left one is read first): the first that
  // spans the line, else the first below it. Only those: another block that the probes miss is not where the reader is
  // (a cookie bar, a sidebar). Those on screen are put in order, not the page's thousands.
  const passedThrough = () => {
    // Seen, too: an invisible drawer or a box moved aside keeps its place and its text.
    const shown = pageBlocks((block) => {
      const r = block.getBoundingClientRect();
      return (
        r.bottom > line &&
        r.top < innerHeight &&
        r.right > 0 &&
        r.left < innerWidth &&
        getComputedStyle(block).pointerEvents === "none" &&
        block.checkVisibility({ opacityProperty: true, visibilityProperty: true })
      );
    });
    const block = shown.find((b) => b.getBoundingClientRect().top <= line) ?? shown[0];
    return block && { block, top: block.getBoundingClientRect().top };
  };
  /**
   * Looked for once, and only once a probe has met a text layer: on an ordinary page a block the probes miss (under a
   * code block, a picture) is not a paragraph passed through, and the look walks the whole page.
   */
  let through: { block: HTMLElement; top: number } | null | undefined;
  const lookThrough = () => (!layered ? null : through === undefined ? (through = passedThrough() ?? null) : through);
  const onLineThrough = () => {
    const t = lookThrough();
    return t && t.top <= line ? placeOf(t.block) : null;
  };
  // On the line; then, under a text layer, the paragraph it covers there (one translated just below must not win: a PDF
  // page translated below one that is not); then just below, as the line often falls between two paragraphs.
  const found = probe(line) ?? onLineThrough() ?? probe(line + 16) ?? onLineThrough();
  if (found) {
    return found;
  }
  for (let y = line + 32; y < line + innerHeight / 2; y += 16) {
    // Not past a passed-through paragraph for a translated one further down.
    const t = lookThrough();
    if (t && t.top <= y) {
      return placeOf(t.block);
    }
    const place = probe(y);
    if (place) {
      return place;
    }
  }
  const t = lookThrough();
  return t ? placeOf(t.block) : null;
}

/**
 * The app keeps a saved article's place as the page comes to rest, so that the Reader, or the page opened again, starts
 * there. The page at its top is no place (null): the article opens at its top.
 */
let placeTimer = 0;
/** The last report: the same again would only make an old place look new (a carousel scrolling a box of its own). */
let reported = "";
function placeChanged(e: Event) {
  clearTimeout(placeTimer);
  const page = e.target === document;
  placeTimer = window.setTimeout(() => {
    // A place put back, until the page moves from it; one still waited for, until the reader moves (a carousel scrolling
    // by itself is not reading).
    if ((placed && Math.abs(placed.scroller.scrollTop - placed.top) < 2) || (unfound?.reader && !unfound.reader.moved())) {
      return;
    }
    placed = null;
    const top = page && (document.scrollingElement?.scrollTop ?? 0) === 0;
    // Nothing found is not the top: the place the app keeps stays.
    const place = top ? null : placeHere();
    const report = JSON.stringify(place);
    if ((top || place) && report !== reported) {
      reported = report;
      invoke("overlay_place", { place }).catch(() => {});
    }
  }, PLACE_MS);
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
    scrollToUnfoundText: scrollToUnfound,
    snapshot,
    runDoc: (action, count) => {
      dispatchEvent(new Event(READER_MOVED));
      docNav.run(action, count);
    },
    repeatKeys: (first) => {
      keySeq = { ...IDLE, repeat: { first, until: Date.now() + REPEAT_MS } };
    },
  };
  // WebView2's print preview opened behind the page in this child webview: the app shows the system dialog instead.
  // Refused (the page is loading or hidden), it stays unprinted: the preview is what this keeps away.
  const pagePrint = window.print.bind(window);
  window.print = () =>
    void invoke("overlay_print").then(
      (shown) => shown || pagePrint(),
      () => {},
    );
  // Capture on window: ahead of the page's own handlers.
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("keydown", defaultsUnclaimed);
  window.addEventListener("pointerdown", onPagePress, true);
  // Capture: a box that scrolls by itself sends its scroll events to no one else.
  window.addEventListener("scroll", placeChanged, { capture: true, passive: true });
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
