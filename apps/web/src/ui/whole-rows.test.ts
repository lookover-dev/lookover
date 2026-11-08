// A scrolling list shows whole rows only (design-system.md "Command palette", round 6): its height ends under the last
// row that fits, never through one (round 5: the palette cut "Depth" in half at its edge).
import { expect, test } from "bun:test";
import { laidOutBottoms, wholeRowsHeight } from "./whole-rows.ts";

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
