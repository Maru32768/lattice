/** Below this luma a translation's dark type would not read: such a box keeps white. */
const LIGHT = 160;

/** How many pixels fell in a step of the colours, and the sums of their channels. */
type Step = { n: number; r: number; g: number; b: number };

/**
 * The colour the page is printed on, from the RGBA pixels under a box: the commonest, so the glyphs drawn on
 * it do not count. Pixels go by colour in steps of 16, so a scan's noise still falls in one, and the colour
 * is the mean of that step's pixels. `null` for a dark one.
 */
export function paperColor(pixels: Uint8ClampedArray): string | null {
  const steps = new Map<number, Step>();
  let best: Step | undefined;
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const [r, g, b] = [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    let step = steps.get(key);
    if (!step) {
      step = { n: 0, r: 0, g: 0, b: 0 };
      steps.set(key, step);
    }
    step.n++;
    step.r += r;
    step.g += g;
    step.b += b;
    if (!best || step.n > best.n) {
      best = step;
    }
  }
  if (!best) {
    return null;
  }
  const { n } = best;
  const [r, g, b] = [Math.round(best.r / n), Math.round(best.g / n), Math.round(best.b / n)];
  return 0.299 * r + 0.587 * g + 0.114 * b >= LIGHT ? `rgb(${r}, ${g}, ${b})` : null;
}

/**
 * The pixels of a canvas under a box given in fractions of it: left, top, width and height. `null` for a box off the
 * page, which a PDF can place anywhere and `getImageData` refuses.
 */
export function pixelsUnder(box: { left: number; top: number; width: number; height: number }, width: number, height: number) {
  const on = (at: number, length: number) => Math.min(Math.max(at, 0), length);
  const [x0, x1] = [on(Math.floor(box.left * width), width), on(Math.ceil((box.left + box.width) * width), width)];
  const [y0, y1] = [on(Math.floor(box.top * height), height), on(Math.ceil((box.top + box.height) * height), height)];
  return x1 > x0 && y1 > y0 ? ([x0, y0, x1 - x0, y1 - y0] as const) : null;
}
