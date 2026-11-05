/**
 * The Page view of a saved PDF. pdf.js draws each page, with its text layer for selecting. Over them
 * lies one element per run of body text (`pdf::regions`), invisible until the page overlay
 * (`src/overlay`), which sees them as any page's paragraphs, shows a translated sentence in one: the
 * element then covers the original with its text. Translation, 混在 and flipping are all the overlay's.
 * Each page has a button that asks the overlay to translate its paragraphs, or to translate them again.
 */
import { GlobalWorkerOptions, getDocument, TextLayer, type PDFDocumentProxy, type PDFPageProxy } from "pdfjs-dist";
import { bookmarkTree, headingTree, topOf, webLink, type Entry, type Target } from "./outline.ts";
import { pageAction } from "./pageAction.ts";
import { onViewport } from "./regionBox.ts";
import type { OverlayLabels } from "../api.ts";

GlobalWorkerOptions.workerSrc = "/assets/pdf.worker.js";

interface Region {
  page: number;
  /** The same on all the pieces of a block broken across columns or pages. */
  block: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  size: number;
  text: string;
  /** `text` with its superscripts, subscripts and formulas told apart. */
  runs: { text: string; script: "sub" | "sup" | null; math: boolean; italic: boolean }[];
  /** A heading's level. */
  level: number | null;
  /** How far a translation may run past the box: the margin, at the edge of the page's text. */
  room_up: number;
  room_down: number;
  /** The top left of the page's MediaBox in the PDF's own coordinates, which the box is measured from. */
  left: number;
  top: number;
}

/**
 * What a paragraph gives up to fit its box, in order. Japanese needs more line spacing than the 1.25 of
 * dense English, and 1.5 everywhere left many paragraphs small (one in seven at 80% or less in a long paper).
 * So spacing goes before the type drops below 90%, which it then does only for those that still spill.
 */
const FIT_STEPS = [
  ...[1, 0.95, 0.9].map((scale) => ({ scale, leading: 1.5 })),
  ...[1.45, 1.4, 1.35, 1.3, 1.25].map((leading) => ({ scale: 0.9, leading })),
  ...[0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55].map((scale) => ({ scale, leading: 1.25 })),
];
const RENDER_MARGIN = "1500px";
/** Canvas pixels per CSS pixel: a page's small type blurs and thickens at 1 on an ordinary display. */
const MIN_DENSITY = 2;
/** A page's canvas at most: at 400% it would take hundreds of MB, each. */
const MAX_DRAWN_WIDTH = 4096;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.1;
/** Bookmarks open down to this depth; a long PDF's whole tree would bury the top level. */
const OPEN_DEPTH = 1;
const OUTLINE_KEY = "lattice.pdfOutline";

const percent = (v: number, of: number) => `${(v / of) * 100}%`;

/** The app's shortcuts include Enter and Space: pressing a button here is not one. */
function pressButtons(e: KeyboardEvent) {
  if ((e.key === "Enter" || e.key === " ") && e.target instanceof HTMLButtonElement) {
    e.preventDefault();
    e.target.click();
  }
}

// ---- moving around the document -----------------------------------------------------------------

/** Every page, in order, once it is laid out. */
const places: { page: PDFPageProxy; host: HTMLElement; size: { height: number; convertToViewportPoint(x: number, y: number): number[] } }[] = [];

async function placeOf(doc: PDFDocumentProxy, target: Target): Promise<{ page: number; y: number } | null> {
  if ("page" in target) {
    return target;
  }
  const dest = typeof target.dest === "string" ? await doc.getDestination(target.dest) : target.dest;
  if (!Array.isArray(dest)) {
    return null;
  }
  const ref = dest[0] as number | Parameters<PDFDocumentProxy["getPageIndex"]>[0];
  const page = typeof ref === "number" ? ref : await doc.getPageIndex(ref);
  const at = places[page];
  const top = topOf(dest);
  return at ? { page, y: top == null ? 0 : (at.size.convertToViewportPoint(0, top)[1] ?? 0) } : null;
}

/** As a share of the document, since a zoom moves everything. */
const whereNow = () => ({ at: scrollY / document.documentElement.scrollHeight });

/** A history entry for each jump: back returns from a reference to the sentence that cited it. */
function jump(doc: PDFDocumentProxy, target: Target) {
  void placeOf(doc, target)
    .then((place) => {
      if (!place) {
        return;
      }
      const { host, size } = places[place.page]!;
      history.replaceState(whereNow(), "");
      scrollTo({ top: host.getBoundingClientRect().top + scrollY + (place.y / size.height) * host.clientHeight - 8 });
      history.pushState(whereNow(), "");
    })
    .catch((e: unknown) => console.warn("[lattice] following a link in the PDF", e));
}

history.scrollRestoration = "manual";
addEventListener("popstate", (e) => {
  const state = e.state as { at?: number } | null;
  if (state?.at != null) {
    scrollTo({ top: state.at * document.documentElement.scrollHeight });
  }
});

/** The page's links, once: not with what `forget` drops, since they are a few small elements. */
async function addLinks(doc: PDFDocumentProxy, page: PDFPageProxy, host: HTMLElement) {
  const layer = host.querySelector<HTMLElement>(".links")!;
  if (layer.dataset.done) {
    return;
  }
  layer.dataset.done = "1";
  const viewport = page.getViewport({ scale: 1 });
  for (const a of (await page.getAnnotations()) as { subtype?: string; rect: number[]; url?: string; dest?: unknown }[]) {
    const url = a.url ? webLink(a.url) : null;
    if (a.subtype !== "Link" || (!url && !a.dest)) {
      continue;
    }
    const [px0 = 0, py0 = 0, px1 = 0, py1 = 0] = a.rect;
    const [x0 = 0, y0 = 0] = viewport.convertToViewportPoint(px0, py0) as number[];
    const [x1 = 0, y1 = 0] = viewport.convertToViewportPoint(px1, py1) as number[];
    const link = document.createElement("a");
    Object.assign(link.style, {
      left: percent(Math.min(x0, x1), viewport.width),
      top: percent(Math.min(y0, y1), viewport.height),
      width: percent(Math.abs(x1 - x0), viewport.width),
      height: percent(Math.abs(y1 - y0), viewport.height),
    });
    if (url) {
      // A new tab, as for any page's link that asks for one: the PDF stays where it was.
      link.href = url;
      link.target = "_blank";
      link.title = url;
    } else {
      link.href = "#";
      link.addEventListener("click", (e) => {
        e.preventDefault();
        jump(doc, { dest: a.dest });
      });
    }
    layer.append(link);
  }
}

// ---- table of contents --------------------------------------------------------------------------

function outlineList(doc: PDFDocumentProxy, entries: Entry[], depth: number) {
  const list = document.createElement("ul");
  for (const e of entries) {
    const row = document.createElement("li");
    const item = document.createElement("button");
    item.className = "item";
    item.textContent = e.title;
    item.title = e.title;
    item.disabled = !e.target;
    item.addEventListener("click", () => e.target && jump(doc, e.target));
    if (e.items.length) {
      const sub = outlineList(doc, e.items, depth + 1);
      const fold = document.createElement("button");
      fold.className = "fold";
      fold.ariaLabel = e.title;
      const setOpen = (open: boolean) => {
        fold.ariaExpanded = String(open);
        sub.hidden = !open;
      };
      setOpen(depth < OPEN_DEPTH);
      fold.addEventListener("click", () => setOpen(sub.hidden === true));
      row.append(fold, item, sub);
    } else {
      row.append(item);
    }
    list.append(row);
  }
  return list;
}

function showOutline(doc: PDFDocumentProxy, entries: Entry[], label: string) {
  const nav = document.createElement("nav");
  nav.ariaLabel = label;
  nav.append(outlineList(doc, entries, 0));
  const toggle = document.createElement("button");
  toggle.id = "outline-toggle";
  toggle.textContent = "☰";
  toggle.ariaLabel = label;
  toggle.title = label;
  const setOpen = (open: boolean) => {
    document.body.classList.toggle("outline-open", open);
    toggle.ariaExpanded = String(open);
    try {
      localStorage.setItem(OUTLINE_KEY, open ? "1" : "0");
    } catch {
      /* the choice lasts for this view only */
    }
  };
  toggle.addEventListener("click", () => setOpen(!document.body.classList.contains("outline-open")));
  let wanted = false;
  try {
    wanted = localStorage.getItem(OUTLINE_KEY) === "1";
  } catch {
    /* closed */
  }
  const ui = document.createElement("div");
  // The overlay leaves it alone: these are controls, and the tooltip would cover them.
  ui.dataset.latticeUi = "1";
  ui.append(toggle, nav);
  ui.addEventListener("keydown", pressButtons);
  document.body.classList.add("has-outline");
  document.body.prepend(ui);
  setOpen(wanted);
}

/**
 * The labels come from the app's catalog, by the overlay's call: it is the one this webview may make.
 * shortcut: read when the document opens, so a change of language shows here after a reload; re-read on the overlay's configure if that matters.
 */
async function viewerLabels() {
  const config = (await window.__TAURI_INTERNALS__?.invoke("overlay_config").catch(() => null)) as { labels?: Partial<OverlayLabels> } | null | undefined;
  const l = config?.labels;
  return {
    outline: l?.outline || "Contents",
    translate_page: l?.translate_page || "Translate this page",
    retranslate_page: l?.retranslate_page || "Translate this page again",
    translating: l?.translating || "Translating…",
    pdf_failed: l?.pdf_failed || "This PDF cannot be opened.",
  };
}
type Labels = Awaited<ReturnType<typeof viewerLabels>>;

async function addOutline(doc: PDFDocumentProxy, regions: Region[], labels: Labels) {
  const bookmarks = await doc.getOutline().catch(() => null);
  const entries = bookmarks?.length ? bookmarkTree(bookmarks) : headingTree(regions);
  if (entries.length) {
    showOutline(doc, entries, labels.outline);
  }
}

// ---- pages --------------------------------------------------------------------------------------

/** Each region's box as a share of its page's height, and the room beyond it. */
const boxes = new WeakMap<HTMLElement, { top: number; height: number; up: number; down: number }>();

function place(el: HTMLElement, top: number, height: number) {
  el.style.top = `${top * 100}%`;
  el.style.height = `${height * 100}%`;
}

/** Sets the box and the text's size so the text shows whole: into the margin if there is room, then smaller. */
function fit(el: HTMLElement) {
  const apply = ({ scale, leading }: (typeof FIT_STEPS)[number]) => {
    el.style.setProperty("--fit", String(scale));
    el.style.setProperty("--leading", String(leading));
  };
  apply(FIT_STEPS[0]!);
  const box = boxes.get(el);
  if (box) {
    place(el, box.top, box.height);
    const over = (el.scrollHeight - el.clientHeight) / (el.parentElement?.clientHeight || 1);
    if (over > 0) {
      const up = Math.min(over, box.up);
      place(el, box.top - up, box.height + up + Math.min(over - up, box.down));
    }
  }
  for (const step of FIT_STEPS) {
    apply(step);
    if (el.scrollHeight <= el.clientHeight) {
      break;
    }
  }
}

function runNode(run: Region["runs"][number]) {
  let node: Node = document.createTextNode(run.text);
  for (const tag of [run.script, run.italic ? "i" : null]) {
    if (tag) {
      const wrap = document.createElement(tag);
      wrap.append(node);
      node = wrap;
    }
  }
  return node;
}

function regionEl(r: Region, width: number, height: number) {
  const el = document.createElement("div");
  el.className = "region";
  el.dataset.block = String(r.block);
  // A formula is a `math` element, which the overlay moves whole into a translation: the model sees a placeholder and it stays as printed.
  let formula: HTMLElement | null = null;
  for (const run of r.runs) {
    if (run.math) {
      if (!formula) {
        formula = document.createElement("math");
        el.append(formula);
      }
      formula.append(runNode(run));
    } else {
      formula = null;
      el.append(runNode(run));
    }
  }
  // What `]]` goes to, and what a screen reader calls it.
  if (r.level != null) {
    el.role = "heading";
    el.ariaLevel = String(r.level);
  }
  boxes.set(el, { top: r.y0 / height, height: (r.y1 - r.y0) / height, up: r.room_up / height, down: r.room_down / height });
  Object.assign(el.style, {
    left: percent(r.x0, width),
    width: percent(r.x1 - r.x0, width),
  });
  place(el, r.y0 / height, (r.y1 - r.y0) / height);
  el.style.setProperty("--size", String(r.size / width));
  return el;
}

/** The canvas width that keeps a page sharp at its width on screen. */
const drawnWidth = (host: HTMLElement) => Math.min(MAX_DRAWN_WIDTH, Math.round(host.clientWidth * Math.max(devicePixelRatio, MIN_DENSITY)));

function startDrawing(page: PDFPageProxy, width: number) {
  const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  return { canvas, task: page.render({ canvas, viewport }) };
}

/** What is being drawn on each page: a page scrolled past or drawn anew stops it, or it runs on and holds its canvas. */
const drawing = new WeakMap<HTMLElement, { cancel(): void }>();

const wasStopped = (e: unknown) => e instanceof Error && (e.name === "RenderingCancelledException" || e.name === "AbortException");

/** Draws a page at its width on screen; again when that changes. */
async function draw(page: PDFPageProxy, host: HTMLElement) {
  const width = drawnWidth(host);
  if (!width) {
    return;
  }
  const pageWidth = page.getViewport({ scale: 1 }).width;
  const cssViewport = page.getViewport({ scale: host.clientWidth / pageWidth });
  const text = host.querySelector<HTMLElement>(".textLayer")!;
  // Before the check below: at `MAX_DRAWN_WIDTH` the canvas stays as it is while the page grows, and the selectable text must keep up.
  text.style.setProperty("--total-scale-factor", String(cssViewport.scale));
  if (host.dataset.drawn === String(width)) {
    return;
  }
  drawing.get(host)?.cancel();
  host.dataset.drawn = String(width);
  const { canvas, task } = startDrawing(page, width);
  drawing.set(host, task);
  await task.promise;
  host.querySelector("canvas")?.remove();
  host.prepend(canvas);
  text.replaceChildren();
  const layer = new TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport: cssViewport });
  drawing.set(host, layer);
  await layer.render();
}

/** A long PDF would hold hundreds of MB of canvases: only pages near the screen keep theirs. */
function forget(host: HTMLElement) {
  drawing.get(host)?.cancel();
  delete host.dataset.drawn;
  host.querySelector("canvas")?.remove();
  host.querySelector(".textLayer")?.replaceChildren();
}

/**
 * Printing takes every page, but `forget` has dropped the canvases of those far from the screen. They go
 * in as images, one page at a time, since a long PDF's canvases would not fit in memory all at once.
 * The images stay for the next print; the page's canvas hides its image.
 */
async function imagesForPrint() {
  for (const { page, host } of places) {
    if (host.querySelector(".print-page")) {
      continue;
    }
    const { canvas, task } = startDrawing(page, drawnWidth(host));
    await task.promise;
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done));
    if (blob) {
      const image = document.createElement("img");
      image.className = "print-page";
      image.src = URL.createObjectURL(blob);
      await image.decode();
      host.prepend(image);
    }
  }
}

/** The overlay's `window.print` is what its print key calls. */
function printAllPages() {
  const print = window.print.bind(window);
  let preparing = false;
  window.print = () => {
    if (preparing) {
      return;
    }
    preparing = true;
    document.documentElement.classList.add("preparing-print");
    void imagesForPrint()
      .catch((e: unknown) => console.warn("[lattice] preparing to print", e))
      .then(() => {
        preparing = false;
        document.documentElement.classList.remove("preparing-print");
        print();
      });
  };
}

function regionsOf(root: Element) {
  return Array.from(root.querySelectorAll<HTMLElement>(".region"));
}

/** Sets a page's button from the state of its paragraphs. */
function showPageAction(host: Element, labels: Labels) {
  const button = host.querySelector<HTMLButtonElement>(".page-act")!;
  const action = pageAction(regionsOf(host).map((r) => r.dataset.latticeBlock));
  button.dataset.action = action;
  button.disabled = action === "busy";
  button.textContent = { none: "", busy: labels.translating, redo: labels.retranslate_page, translate: labels.translate_page }[action];
}

function pageButton(host: Element) {
  const button = document.createElement("button");
  button.className = "page-act";
  button.addEventListener("click", () => {
    // A block broken across pages goes whole: a sentence ending on the next page stays under this page's box otherwise.
    const blocks = new Set(regionsOf(host).map((r) => r.dataset.block));
    const els = regionsOf(document.getElementById("pages")!).filter((r) => blocks.has(r.dataset.block));
    window.__lattice?.translateBlocks(els, button.dataset.action === "redo");
  });
  const ui = document.createElement("div");
  // The overlay leaves it alone, as the outline.
  ui.dataset.latticeUi = "1";
  ui.append(button);
  ui.addEventListener("keydown", pressButtons);
  return ui;
}

async function open(doc: PDFDocumentProxy, regions: Region[]) {
  const labels = await viewerLabels();
  const pages = document.getElementById("pages")!;
  const drawOn = new Map<Element, () => void>();
  const visible = new IntersectionObserver(
    (entries) =>
      entries.forEach((e) => {
        if (e.isIntersecting) {
          drawOn.get(e.target)?.();
        } else {
          forget(e.target as HTMLElement);
        }
      }),
    { rootMargin: RENDER_MARGIN },
  );
  const resized = new ResizeObserver((entries) =>
    entries.forEach((e) => {
      if ((e.target as HTMLElement).dataset.drawn) {
        drawOn.get(e.target)?.();
      }
    }),
  );
  const placed: Region[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    const { width, height } = viewport;
    const onPage = regions.filter((r) => r.page === n - 1).map((r) => onViewport(r, viewport));
    placed.push(...onPage);
    const host = document.createElement("div");
    host.className = "page";
    host.style.aspectRatio = `${width} / ${height}`;
    host.style.setProperty("--aspect", String(width / height));
    const text = document.createElement("div");
    text.className = "textLayer";
    text.translate = false;
    const links = document.createElement("div");
    links.className = "links";
    links.translate = false;
    host.append(text, links, ...onPage.map((r) => regionEl(r, width, height)), pageButton(host));
    showPageAction(host, labels);
    const failed = (e: unknown) => wasStopped(e) || console.warn("[lattice] drawing a page", e);
    drawOn.set(host, () => {
      void draw(page, host).catch(failed);
      void addLinks(doc, page, host).catch(failed);
    });
    places.push({ page, host, size: viewport });
    pages.append(host);
    visible.observe(host);
    resized.observe(host);
  }
  // A PDF with no headings found: `]]` goes by page.
  if (!placed.some((r) => r.level != null)) {
    places.forEach(({ host }) => {
      host.dataset.docHeading = "1";
    });
  }
  // The overlay changes a region's text and state: only ever its children and that attribute, never its style.
  new MutationObserver((records) => {
    const refit = new Set<HTMLElement>();
    const stateOn = new Set<Element>();
    for (const r of records) {
      const region = (r.target instanceof Element ? r.target : r.target.parentElement)?.closest<HTMLElement>(".region");
      if (region) {
        if (r.type === "attributes") {
          stateOn.add(region.closest(".page")!);
        } else {
          refit.add(region);
        }
      }
    }
    refit.forEach(fit);
    stateOn.forEach((host) => showPageAction(host, labels));
  }).observe(pages, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["data-lattice-block"] });
  window.__lattice?.scrollToUnfoundText();
  await addOutline(doc, placed, labels);
}

/** A password or a broken or deleted file: the page stays empty otherwise, with no word why. */
async function showFailure(e: unknown) {
  console.warn("[lattice] opening the PDF", e);
  const message = document.createElement("p");
  message.id = "pdf-failed";
  // The overlay leaves it alone: it is in the display language already.
  message.dataset.latticeUi = "1";
  message.textContent = (await viewerLabels()).pdf_failed;
  document.getElementById("pages")!.append(message);
}

/** Pages are as wide as the window, so the browser's own zoom would change nothing on screen. */
let zoom = 1;
function setZoom(next: number) {
  zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
  document.documentElement.style.setProperty("--zoom", String(zoom));
}
addEventListener(
  "wheel",
  (e) => {
    if (e.ctrlKey) {
      e.preventDefault();
      setZoom(zoom * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP));
    }
  },
  { passive: false },
);
addEventListener("keydown", (e) => {
  // No Ctrl+- to zoom out: that is the app's 下に分割, which the overlay forwards before this sees it.
  const next = !e.ctrlKey ? null : e.key === "+" || e.key === "=" ? zoom * ZOOM_STEP : e.key === "0" ? 1 : null;
  if (next != null) {
    e.preventDefault();
    setZoom(next);
  }
});

printAllPages();

const here = location.pathname;
const layout = fetch(`${here}/layout`).then((r): Promise<Region[]> => (r.ok ? (r.json() as Promise<Region[]>) : Promise.resolve([])));
// shortcut: no CMaps or standard fonts are bundled, so a PDF that does not embed its CJK fonts draws without that text; serve pdfjs-dist/cmaps if such PDFs turn up.
getDocument({ url: `${here}/file`, disableRange: true, disableStream: true, wasmUrl: new URL("/assets/wasm/", location.href).href })
  .promise.then(async (doc) => open(doc, await layout))
  .catch(showFailure);
