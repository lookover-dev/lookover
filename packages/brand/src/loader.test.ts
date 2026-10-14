// The loader's numbers, derived from the mark's as rounded on its 64 grid by the pair's scale onto the 64 × 44 box
// (k = 64/44), and the CSS that moves its pupils. Expected values worked out by hand: R 9.4k, ring 3.6k, dot 3.5k,
// hole 3.8k × 4.23k, rest offsets (23.9 − 21.25)k and (23.48 − 21.25)k, stops 30° below the horizontal.
import { expect, test } from "bun:test";
import { LOADER, loader, loaderCss } from "./index.ts";

test("the loader's eyes are the mark's, scaled onto its 64 × 44 box", () => {
  expect(LOADER.eye).toBe(13.67);
  expect(LOADER.centres).toEqual([13.67, 50.33]);
  expect(LOADER.cy).toBe(22);
  expect(LOADER.ring).toBe(5.24);
  expect(LOADER.ringRadius).toBe(11.05);
  expect(LOADER.dot).toBe(5.09);
  expect(LOADER.hole).toEqual({ rx: 5.53, ry: 6.15 });
});

test("at rest the pupils look down, and they read along three stops on the lower arc", () => {
  expect(LOADER.dotRest).toBe(3.85);
  expect(LOADER.holeRest).toBe(3.24);
  expect(LOADER.dotStops).toEqual([
    [-3.34, 1.93],
    [0, 3.85],
    [3.34, 1.93],
  ]);
  expect(LOADER.holeStops).toEqual([
    [-2.81, 1.62],
    [0, 3.24],
    [2.81, 1.62],
  ]);
  expect(LOADER.holds).toEqual([
    [0, 21],
    [27, 48],
    [54, 75],
  ]);
  expect(LOADER.back).toBe(87);
  expect(LOADER.seconds).toBe(1.8);
});

test("every stop lies on its travel circle, on the lower half of its eye, never above the centre", () => {
  for (const [stops, radius] of [
    [LOADER.dotStops, LOADER.dotRest],
    [LOADER.holeStops, LOADER.holeRest],
  ] as const) {
    for (const [x, y] of stops) {
      expect(y).toBeGreaterThan(0);
      expect(Math.abs(Math.hypot(x, y) - radius)).toBeLessThan(0.01);
    }
  }
});

test("the loader's box has the drawing's ratio", () => {
  expect(LOADER.box).toEqual({
    drawing: { width: 64, height: 44 },
    text: { width: 1.2, height: 0.825, align: -0.0625 },
    large: { width: 48, height: 33 },
  });
});

test("next to words the eyes' centre sits 0.35 em above the baseline, where the 1 em box at -0.15 em had it", () => {
  const { height, align } = LOADER.box.text;
  expect(align + height / 2).toBeCloseTo(-0.15 + 1 / 2, 6);
  expect(loaderCss()).toContain(
    ".eyes {\n  width: 1.2em;\n  height: 0.825em;\n  vertical-align: -0.0625em;\n}\n",
  );
});

test("the CSS rests the pupils low and moves them through the stops, back to the first at 87 %", () => {
  const css = loaderCss();
  expect(css).toContain(".eyes .p {\n  transform: translateY(3.85px);\n}\n");
  expect(css).toContain(".eyes .h {\n  transform: translateY(3.24px);\n}\n");
  expect(css).toContain(".eyes .p.read {\n  animation: read 1.8s infinite;\n}\n");
  expect(css).toContain(".eyes .h.read {\n  animation: read-solid 1.8s infinite;\n}\n");
  expect(css).toContain(
    "@keyframes read {\n  0%,\n  21% {\n    transform: translate(-3.34px, 1.93px);\n  }\n  27%,\n  48% {\n    transform: translate(0, 3.85px);\n  }\n  54%,\n  75% {\n    transform: translate(3.34px, 1.93px);\n  }\n  87%,\n  100% {\n    transform: translate(-3.34px, 1.93px);\n  }\n}\n",
  );
  expect(css).toContain(
    "@keyframes read-solid {\n  0%,\n  21% {\n    transform: translate(-2.81px, 1.62px);\n  }\n",
  );
});

test("the loader draws ring eyes with their dots, or solid eyes with their holes cut by a mask", () => {
  const ring = loader({ solid: false, still: false, mask: "m1" });
  expect(ring).toContain('<circle cx="13.67" cy="22" r="11.05"/>');
  expect(ring).toContain('stroke-width="5.24"');
  expect(ring).toContain(
    '<g class="p read"><circle cx="13.67" cy="22" r="5.09"/><circle cx="50.33" cy="22" r="5.09"/></g>',
  );
  const solid = loader({ solid: true, still: true, mask: "m2" });
  expect(solid).toContain('<g class="h" fill="#000"><ellipse cx="13.67" cy="22" rx="5.53" ry="6.15"/>');
  expect(solid).toContain('<g mask="url(#m2)"><circle cx="13.67" cy="22" r="13.67"/>');
});
