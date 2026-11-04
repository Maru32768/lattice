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
}

/** How far a translation longer than the original may shrink to fit. */
const MIN_FIT = 0.55;
const RENDER_MARGIN = "1500px";
/** Canvas pixels per CSS pixel: a page's small type blurs and thickens at 1 on an ordinary display. */
const MIN_DENSITY = 2;
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
const places: { host: HTMLElement; size: { height: number; convertToViewportPoint(x: number, y: number): number[] } }[] = [];

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

/** The labels come from the app's catalog, by the overlay's call: it is the one this webview may make. */
async function viewerLabels() {
  const config = (await window.__TAURI_INTERNALS__?.invoke("overlay_config").catch(() => null)) as { labels?: Partial<OverlayLabels> } | null | undefined;
  const l = config?.labels;
  return {
    outline: l?.outline || "Contents",
    translate_page: l?.translate_page || "Translate this page",
    retranslate_page: l?.retranslate_page || "Translate this page again",
    translating: l?.translating || "Translating…",
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
  let scale = 1;
  el.style.setProperty("--fit", "1");
  const box = boxes.get(el);
  if (box) {
    place(el, box.top, box.height);
    const over = (el.scrollHeight - el.clientHeight) / (el.parentElement?.clientHeight || 1);
    if (over > 0) {
      const up = Math.min(over, box.up);
      place(el, box.top - up, box.height + up + Math.min(over - up, box.down));
    }
  }
  while (el.scrollHeight > el.clientHeight && scale > MIN_FIT) {
    scale -= 0.05;
    el.style.setProperty("--fit", String(scale));
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
  boxes.set(el, { top: r.y0 / height, height: (r.y1 - r.y0) / height, up: r.room_up / height, down: r.room_down / height });
  Object.assign(el.style, {
    left: percent(r.x0, width),
    width: percent(r.x1 - r.x0, width),
  });
  place(el, r.y0 / height, (r.y1 - r.y0) / height);
  el.style.setProperty("--size", String(r.size / width));
  return el;
}

/** Draws a page at its width on screen; again when that changes. */
async function draw(page: PDFPageProxy, host: HTMLElement) {
  const width = Math.round(host.clientWidth * Math.max(devicePixelRatio, MIN_DENSITY));
  if (!width || host.dataset.drawn === String(width)) {
    return;
  }
  host.dataset.drawn = String(width);
  const pageWidth = page.getViewport({ scale: 1 }).width;
  const viewport = page.getViewport({ scale: width / pageWidth });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvas, viewport }).promise;
  // Resized or scrolled away meanwhile.
  if (host.dataset.drawn !== String(width)) {
    return;
  }
  host.querySelector("canvas")?.remove();
  host.prepend(canvas);
  const text = host.querySelector<HTMLElement>(".textLayer")!;
  text.replaceChildren();
  const cssViewport = page.getViewport({ scale: host.clientWidth / pageWidth });
  text.style.setProperty("--total-scale-factor", String(cssViewport.scale));
  await new TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport: cssViewport }).render();
}

/** A long PDF would hold hundreds of MB of canvases: only pages near the screen keep theirs. */
function forget(host: HTMLElement) {
  delete host.dataset.drawn;
  host.querySelector("canvas")?.remove();
  host.querySelector(".textLayer")?.replaceChildren();
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
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const { width, height } = page.getViewport({ scale: 1 });
    const host = document.createElement("div");
    host.className = "page";
    host.style.aspectRatio = `${width} / ${height}`;
    const text = document.createElement("div");
    text.className = "textLayer";
    text.translate = false;
    const links = document.createElement("div");
    links.className = "links";
    links.translate = false;
    host.append(text, links, ...regions.filter((r) => r.page === n - 1).map((r) => regionEl(r, width, height)), pageButton(host));
    showPageAction(host, labels);
    const failed = (e: unknown) => console.warn("[lattice] drawing a page", e);
    drawOn.set(host, () => {
      void draw(page, host).catch(failed);
      void addLinks(doc, page, host).catch(failed);
    });
    places.push({ host, size: page.getViewport({ scale: 1 }) });
    pages.append(host);
    visible.observe(host);
    resized.observe(host);
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
  await addOutline(doc, regions, labels);
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
  const next = !e.ctrlKey ? null : e.key === "+" || e.key === "=" ? zoom * ZOOM_STEP : e.key === "-" ? zoom / ZOOM_STEP : e.key === "0" ? 1 : null;
  if (next != null) {
    e.preventDefault();
    setZoom(next);
  }
});

const here = location.pathname;
const layout = fetch(`${here}/layout`).then((r): Promise<Region[]> => (r.ok ? (r.json() as Promise<Region[]>) : Promise.resolve([])));
// shortcut: no CMaps or standard fonts are bundled, so a PDF that does not embed its CJK fonts draws without that text; serve pdfjs-dist/cmaps if such PDFs turn up.
getDocument({ url: `${here}/file`, disableRange: true, disableStream: true })
  .promise.then(async (doc) => open(doc, await layout))
  .catch((e: unknown) => console.warn("[lattice] opening the PDF", e));
