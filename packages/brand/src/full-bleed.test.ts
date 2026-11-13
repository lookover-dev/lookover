// The icon full bleed (ADR 0098): ink to every edge, the solid mark where the icon places it, so whoever crops it
// to a circle or a rounded square crops only ink. As SVG text, the rounded icon's with the tile's corner radius
// gone; as a picture at each side its copies have: the site's favicons and apple-touch icon, and the GitHub App's
// logo at 200, which GitHub crops to a circle on its badge colour.
import { expect, test } from "bun:test";
import {
  COLOURS,
  FULL_BLEED_PICTURES,
  icon,
  iconFullBleed,
  iconFullBleedPicture,
  MARK_REACH,
} from "./index.ts";

const hex = (h: string) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
const INK = [...hex(COLOURS.ink), 255];
const PAPER = [...hex(COLOURS.paper), 255];
const ACCENT = [...hex(COLOURS.accent), 255];

test("the SVG is the rounded icon's text with the tile's corner radius gone: the same mark on an ink square", () => {
  const rounded = icon("#16130F", "#F7F6F2", "#E5347B", true);
  expect(rounded).toContain('<rect width="64" height="64" rx="14.4" fill="#16130F"/>');
  expect(iconFullBleed()).toBe(rounded.replace(' rx="14.4"', ""));
  // No transparent corner: the square covers the whole view box, with no radius.
  expect(iconFullBleed()).toContain('viewBox="0 0 64 64"');
  expect(iconFullBleed()).toContain('<rect width="64" height="64" fill="#16130F"/>');
  expect(iconFullBleed()).not.toContain("rx=");
});

test("the pictures are the App's logo at GitHub's recommended 200 px and the site's at 48, 96, 192 and 180", () => {
  expect(FULL_BLEED_PICTURES.app).toEqual({ path: "docs/product/brand/lookover-app-icon.png", side: 200 });
  expect(FULL_BLEED_PICTURES.site.map(({ side }) => side)).toEqual([48, 96, 192, 180]);
});

test("the mark's farthest point is within 29.85 of the centre, on the 64 grid whose crop has a radius of 32", () => {
  expect(MARK_REACH).toBeGreaterThan(29.7);
  expect(MARK_REACH).toBeLessThanOrEqual(29.85);
});

test.each([48, 96, 180, 192, 200])("at %i px", (side) => {
  const image = iconFullBleedPicture(side);
  const pixel = (x: number, y: number) => [
    ...image.rgba.subarray((y * side + x) * 4, (y * side + x) * 4 + 4),
  ];
  expect([image.width, image.height]).toEqual([side, side]);
  expect(image.rgba.length).toBe(side * side * 4);

  // Its corners and its edges are ink: no tile, nothing transparent.
  const last = side - 1;
  const half = side / 2;
  for (const [x, y] of [
    [0, 0],
    [last, 0],
    [0, last],
    [last, last],
    [half, 0],
    [0, half],
    [half, last],
    [last, half],
  ] as const) {
    expect(pixel(x, y)).toEqual(INK);
  }
  for (let i = 3; i < image.rgba.length; i += 4) expect(image.rgba[i]).toBe(255);

  // Every pixel outside the mark's reach is ink: a circle cropped from it crops only ink.
  const scale = side / 64;
  const reach = MARK_REACH * scale + Math.SQRT1_2;
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      if (Math.hypot(x + 0.5 - half, y + 0.5 - half) > reach) expect(pixel(x, y)).toEqual(INK);
    }
  }

  // The solid eyes in paper, the first line in the accent, the second in paper, the left eye's hole ink: on the
  // 64 grid, points whose whole pixel lies inside the shape at each of these sides.
  expect(pixel(Math.floor(13 * scale), Math.floor(21.25 * scale))).toEqual(PAPER);
  expect(pixel(Math.floor(32 * scale), Math.floor(40.7 * scale))).toEqual(ACCENT);
  expect(pixel(Math.floor(12 * scale), Math.floor(49.6 * scale))).toEqual(PAPER);
  expect(pixel(Math.floor(19.4 * scale), Math.floor(25 * scale))).toEqual(INK);
});
