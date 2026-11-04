import assert from "node:assert/strict";
import test from "node:test";
import { onViewport } from "./regionBox.ts";

const region = { x0: 100, y0: 200, x1: 300, y1: 220, left: 0, top: 792 };

/** What pdf.js's PageViewport computes at scale 1, for a page whose view starts at (left, bottom) and ends at (right, top). */
const upright = (left: number, top: number) => ({ convertToViewportPoint: (x: number, y: number) => [x - left, top - y] });
const turned90 = (left: number, bottom: number) => ({ convertToViewportPoint: (x: number, y: number) => [y - bottom, x - left] });

const box = (r: typeof region) => [r.x0, r.y0, r.x1, r.y1];

test("a page shown whole keeps its box", () => {
  assert.deepEqual(box(onViewport(region, upright(0, 792))), [100, 200, 300, 220]);
});

test("a CropBox moves the box by what it cuts off", () => {
  assert.deepEqual(box(onViewport(region, upright(50, 742))), [50, 150, 250, 170]);
});

test("a turned page turns the box", () => {
  assert.deepEqual(box(onViewport(region, turned90(0, 0))), [572, 100, 592, 300]);
});

test("a MediaBox away from the origin is measured from its corner", () => {
  assert.deepEqual(box(onViewport({ ...region, left: 10, top: 812 }, upright(10, 812))), [100, 200, 300, 220]);
});
