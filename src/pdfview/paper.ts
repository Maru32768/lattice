/** Below this luma a translation's dark type would not read: such a box keeps white. */
const LIGHT = 160;

/**
 * The colour the page is printed on, from the RGBA pixels under a box: the commonest, so the glyphs drawn on
 * it do not count. Pixels go by colour in steps of 16, so a scan's noise still falls in one, and the colour
 * is the mean of that step's pixels. `null` for a dark one.
 */
export function paperColor(pixels: Uint8ClampedArray): string | null {
  const steps = new Map<number, { n: number; sums: [number, number, number] }>();
  let best: { n: number; sums: [number, number, number] } | undefined;
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const rgb = [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!] as const;
    const key = ((rgb[0] >> 4) << 8) | ((rgb[1] >> 4) << 4) | (rgb[2] >> 4);
    let step = steps.get(key);
    if (!step) {
      step = { n: 0, sums: [0, 0, 0] };
      steps.set(key, step);
    }
    step.n++;
    for (let c = 0; c < 3; c++) {
      step.sums[c]! += rgb[c]!;
    }
    if (!best || step.n > best.n) {
      best = step;
    }
  }
  if (!best) {
    return null;
  }
  const { n, sums } = best;
  const [r, g, b] = sums.map((s) => Math.round(s / n)) as [number, number, number];
  return 0.299 * r + 0.587 * g + 0.114 * b >= LIGHT ? `rgb(${r}, ${g}, ${b})` : null;
}
