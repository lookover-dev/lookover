// The GitHub App's logo: the icon full bleed, ink to every edge, so GitHub's circle crops nothing of the mark.
import { expect, test } from "bun:test";
import { APP_ICON_SIZE, appIcon, COLOURS, MARK_REACH } from "./index.ts";

const hex = (h: string) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
const INK = [...hex(COLOURS.ink), 255];
const PAPER = [...hex(COLOURS.paper), 255];
const ACCENT = [...hex(COLOURS.accent), 255];

const image = appIcon();
const pixel = (x: number, y: number) => [
  ...image.rgba.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4),
];

test("it is GitHub's recommended size, 200 × 200", () => {
  expect(APP_ICON_SIZE).toBe(200);
  expect([image.width, image.height]).toEqual([200, 200]);
});

test("its corners and its edges are ink: no tile, nothing transparent", () => {
  for (const [x, y] of [
    [0, 0],
    [199, 0],
    [0, 199],
    [199, 199],
    [100, 0],
    [0, 100],
  ] as const) {
    expect(pixel(x, y)).toEqual(INK);
  }
  for (let i = 3; i < image.rgba.length; i += 4) expect(image.rgba[i]).toBe(255);
});

test("the mark's farthest point is within 29.85 of the centre, on the 64 grid whose crop has a radius of 32", () => {
  expect(MARK_REACH).toBeGreaterThan(29.7);
  expect(MARK_REACH).toBeLessThanOrEqual(29.85);
});

test("every pixel outside the mark's reach is ink: GitHub's circle crops only ink", () => {
  const scale = APP_ICON_SIZE / 64;
  const reach = MARK_REACH * scale + Math.SQRT1_2;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (Math.hypot(x + 0.5 - 100, y + 0.5 - 100) > reach) expect(pixel(x, y)).toEqual(INK);
    }
  }
});

test("it draws the icon's solid eyes in paper and the first line in the accent", () => {
  const scale = APP_ICON_SIZE / 64;
  // An eye's disc beside its hole, the first line's middle and the second line's start, on the 64 grid.
  expect(pixel(Math.floor(13 * scale), Math.floor(21.25 * scale))).toEqual(PAPER);
  expect(pixel(Math.floor(32 * scale), Math.floor(40.7 * scale))).toEqual(ACCENT);
  expect(pixel(Math.floor(12 * scale), Math.floor(49.6 * scale))).toEqual(PAPER);
  // The hole in the left eye: the ground shows through.
  expect(pixel(Math.floor(19.4 * scale), Math.floor(25 * scale))).toEqual(INK);
});
