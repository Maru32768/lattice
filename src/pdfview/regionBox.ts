interface Measured {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  left: number;
  top: number;
}

/** A region's box on the page pdf.js draws: its CropBox, turned by its /Rotate. The extractor measures from the MediaBox, unturned. */
export function onViewport<R extends Measured>(r: R, viewport: { convertToViewportPoint(x: number, y: number): number[] }): R {
  const [ax = 0, ay = 0] = viewport.convertToViewportPoint(r.left + r.x0, r.top - r.y0);
  const [bx = 0, by = 0] = viewport.convertToViewportPoint(r.left + r.x1, r.top - r.y1);
  return { ...r, x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
}
