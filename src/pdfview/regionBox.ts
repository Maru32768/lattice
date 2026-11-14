interface Measured {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  left: number;
  top: number;
  room_left: number;
  room_right: number;
  room_up: number;
  room_down: number;
}

/**
 * A region's box on the page pdf.js draws: its CropBox, turned by its /Rotate. The extractor measures from the MediaBox, unturned.
 * The room around the box turns with it: on a turned page the room along a line runs up and down.
 */
export function onViewport<R extends Measured>(r: R, viewport: { convertToViewportPoint(x: number, y: number): number[] }): R {
  const turn = (x0: number, y0: number, x1: number, y1: number) => {
    const [ax = 0, ay = 0] = viewport.convertToViewportPoint(r.left + x0, r.top - y0);
    const [bx = 0, by = 0] = viewport.convertToViewportPoint(r.left + x1, r.top - y1);
    return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)] as const;
  };
  const [x0, y0, x1, y1] = turn(r.x0, r.y0, r.x1, r.y1);
  const [ox0, oy0, ox1, oy1] = turn(r.x0 - r.room_left, r.y0 - r.room_up, r.x1 + r.room_right, r.y1 + r.room_down);
  return { ...r, x0, y0, x1, y1, room_left: x0 - ox0, room_right: ox1 - x1, room_up: y0 - oy0, room_down: oy1 - y1 };
}
