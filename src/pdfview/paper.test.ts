import assert from "node:assert/strict";
import test from "node:test";
import { paperColor } from "./paper.ts";

/** RGBA pixels: `count` of each colour, in turn. */
function pixels(...runs: [count: number, rgb: [number, number, number]][]) {
  const out: number[] = [];
  for (const [count, [r, g, b]] of runs) {
    for (let i = 0; i < count; i++) {
      out.push(r, g, b, 255);
    }
  }
  return new Uint8ClampedArray(out);
}

test("text on white paper gives white", () => {
  assert.equal(paperColor(pixels([70, [255, 255, 255]], [20, [0, 0, 0]], [10, [128, 128, 128]])), "rgb(255, 255, 255)");
});

test("an aside's grey box gives its grey, whatever the glyphs on it", () => {
  assert.equal(paperColor(pixels([20, [20, 20, 20]], [55, [230, 231, 232]], [25, [255, 255, 255]])), "rgb(230, 231, 232)");
});

test("a scan's noise falls together and gives its mean", () => {
  assert.equal(paperColor(pixels([30, [241, 238, 225]], [30, [243, 236, 227]], [40, [0, 0, 0]])), "rgb(242, 237, 226)");
});

test("dark paper gives nothing, as the translation is set in dark type", () => {
  assert.equal(paperColor(pixels([80, [40, 40, 60]], [20, [255, 255, 255]])), null);
});

test("no pixels give nothing", () => {
  assert.equal(paperColor(new Uint8ClampedArray()), null);
});
