// A scrolling list shows whole rows only (design-system.md "Command palette", round 6): its height ends under the last
// row that fits, never through one (round 5: the palette cut "Depth" in half at its edge).
import { expect, test } from "bun:test";
import { laidOutBottoms, refitWhenRowsMove, wholeRowsHeight } from "./whole-rows.ts";

test("a list whose rows all fit keeps its own height", () => {
  expect(wholeRowsHeight([40, 80, 120], 200, 6)).toBeNull();
  expect(wholeRowsHeight([40, 80, 194], 200, 6)).toBeNull();
});

test("a list taller than its room ends under the last row that fits, its padding under it", () => {
  // 40 + 6 fits, 80 + 6 fits, 120 + 6 is past 100
  expect(wholeRowsHeight([40, 80, 120], 100, 6)).toBe(86);
  expect(wholeRowsHeight([40, 80, 120], 86, 6)).toBe(86);
  expect(wholeRowsHeight([40, 80, 120], 85, 6)).toBe(46);
});

test("a first row taller than the room takes the room: the list never shuts", () => {
  expect(wholeRowsHeight([300, 340], 200, 6)).toBe(200);
  expect(wholeRowsHeight([], 200, 6)).toBeNull();
});

test("a list drawn scaled, as the dialog opens at 98 %, measures its rows at their laid-out size, scrolled or not", () => {
  // drawn at 98 %: a row whose bottom is 490 px under the list's top on screen is 500 px under it laid out
  expect(laidOutBottoms(100, 0.98, 0, [100 + 49, 100 + 490])).toEqual([50, 500]);
  expect(laidOutBottoms(100, 1, 40, [100 + 10, 100 + 60])).toEqual([50, 100]);
});

test("a row measured at any moment of the dialog's opening has one bottom, in the layout's 1/64 px", () => {
  // The browser draws in single precision: a bottom laid out at 469 + 10/64 px comes back a hair off it, a different
  // hair at each scale, and the height set from it moved the dialog by a hair between two openings (ADR 0093).
  const laidOut = 469 + 10 / 64;
  const drawnAt = (scale: number) => Math.fround(Math.fround(196.44) + Math.fround(laidOut * scale));
  const seen = [0.98, 0.9873, 0.99512, 1].map((scale) =>
    laidOutBottoms(Math.fround(196.44), scale, 0, [drawnAt(scale)]),
  );
  for (const bottoms of seen) expect(bottoms).toEqual([laidOut]);
});

test("a list is fitted again when the window resizes and when a font comes in, until it stops watching", () => {
  // A font the page hadn't used yet (the palette's mono headings) loads as the palette opens: fitted with the fallback
  // font's rows, the list ended 3 px off its last row once the real font came in (ADR 0093).
  const window = new EventTarget();
  const fonts = new EventTarget();
  let fits = 0;
  const stop = refitWhenRowsMove(() => fits++, { window, fonts });
  window.dispatchEvent(new Event("resize"));
  fonts.dispatchEvent(new Event("loadingdone"));
  expect(fits).toBe(2);
  stop();
  window.dispatchEvent(new Event("resize"));
  fonts.dispatchEvent(new Event("loadingdone"));
  expect(fits).toBe(2);
});

test("a document with no font set still refits on a resize", () => {
  // The tests' DOM has no `document.fonts`: the palette opened there threw, and its boundary showed instead.
  const window = new EventTarget();
  let fits = 0;
  const stop = refitWhenRowsMove(() => fits++, { window, fonts: undefined });
  window.dispatchEvent(new Event("resize"));
  stop();
  expect(fits).toBe(1);
});
