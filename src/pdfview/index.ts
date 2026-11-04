/**
 * The Page view of a saved PDF. pdf.js draws each page, with its text layer for selecting. Over them
 * lies one element per run of body text (`pdf::regions`), invisible until the page overlay
 * (`src/overlay`), which sees them as any page's paragraphs, shows a translated sentence in one: the
 * element then covers the original with its text. Translation, 混在 and flipping are all the overlay's.
 */
import { GlobalWorkerOptions, getDocument, TextLayer, type PDFDocumentProxy, type PDFPageProxy } from "pdfjs-dist";

GlobalWorkerOptions.workerSrc = "/assets/pdf.worker.js";

interface Region {
  page: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  size: number;
  text: string;
}

/** How far a translation longer than the original may shrink to fit. */
const MIN_FIT = 0.55;
const RENDER_MARGIN = "1500px";
/** Canvas pixels per CSS pixel: a page's small type blurs and thickens at 1 on an ordinary display. */
const MIN_DENSITY = 2;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.1;

const percent = (v: number, of: number) => `${(v / of) * 100}%`;

/** Sets the text's size so it fills its box without spilling out of it. */
function fit(el: HTMLElement) {
  let scale = 1;
  el.style.setProperty("--fit", "1");
  while (el.scrollHeight > el.clientHeight && scale > MIN_FIT) {
    scale -= 0.05;
    el.style.setProperty("--fit", String(scale));
  }
}

function regionEl(r: Region, width: number, height: number) {
  const el = document.createElement("div");
  el.className = "region";
  el.textContent = r.text;
  Object.assign(el.style, {
    left: percent(r.x0, width),
    top: percent(r.y0, height),
    width: percent(r.x1 - r.x0, width),
    height: percent(r.y1 - r.y0, height),
  });
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

async function open(doc: PDFDocumentProxy, regions: Region[]) {
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
    host.append(text, ...regions.filter((r) => r.page === n - 1).map((r) => regionEl(r, width, height)));
    drawOn.set(host, () => void draw(page, host).catch((e: unknown) => console.warn("[lattice] drawing a page", e)));
    pages.append(host);
    visible.observe(host);
    resized.observe(host);
  }
  // The overlay changes a region's text: only ever its children, never its style.
  new MutationObserver((records) => {
    const changed = new Set(records.map((r) => (r.target instanceof Element ? r.target : r.target.parentElement)?.closest<HTMLElement>(".region")));
    changed.forEach((el) => el && fit(el));
  }).observe(pages, { childList: true, characterData: true, subtree: true });
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
