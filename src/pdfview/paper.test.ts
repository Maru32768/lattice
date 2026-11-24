import assert from "node:assert/strict";
import test from "node:test";
import { paperColor, pixelsUnder } from "./paper.ts";

/** RGBA pixels: `count` of each colour, in turn. */
function pixels(...runs: [count: number, rgb: [number, number, number]][]) {
  return new Uint8ClampedArray(runs.flatMap(([count, rgb]) => Array.from({ length: count }, () => [...rgb, 255]).flat()));
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

test("dark blue is dark and a mid grey is not: the eye weighs the channels", () => {
  assert.equal(paperColor(pixels([10, [100, 140, 255]])), null);
  assert.equal(paperColor(pixels([10, [170, 170, 170]])), "rgb(170, 170, 170)");
});

test("red type on white paper falls apart from it", () => {
  assert.equal(paperColor(pixels([55, [255, 255, 255]], [45, [255, 0, 0]])), "rgb(255, 255, 255)");
});

test("no pixels give nothing", () => {
  assert.equal(paperColor(new Uint8ClampedArray()), null);
});

test("a box's pixels are those of it on the page", () => {
  assert.deepEqual(pixelsUnder({ left: 0.1, top: 0.25, width: 0.5, height: 0.25 }, 100, 200), [10, 50, 50, 50]);
  assert.deepEqual(pixelsUnder({ left: -0.1, top: 0.9, width: 0.2, height: 0.2 }, 100, 200), [0, 180, 10, 20]);
  assert.deepEqual(pixelsUnder({ left: 0.5, top: 0.5, width: 1e9, height: 0.001 }, 100, 200), [50, 100, 50, 1]);
});

test("a box off the page has no pixels", () => {
  assert.equal(pixelsUnder({ left: 1e9, top: 0, width: 0.1, height: 0.1 }, 100, 200), null);
  assert.equal(pixelsUnder({ left: 0, top: -2, width: 0.1, height: 0.1 }, 100, 200), null);
});
