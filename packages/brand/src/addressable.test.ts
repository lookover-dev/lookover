// The drawings the site animates: the wordmark and the mark with their parts addressable, and the loader with both
// its themes. Each draws the flat drawing's shapes, part for part (a solid eye's hole cut by a mask is the same
// picture as the flat file's evenodd hole), so the site shows the brand's numbers. Hand-worked values: the mark's
// solid hole at (19.4, 21.25 + 2.23) is 3.8 × 4.23, its ring pupil r 3.5 at 21.25 + 2.65; the wordmark's solid
// hole is the o's counter 62 units down (262 − 118 − 82), its ring pupil r 79.5 at −174.05.
import { expect, test } from "bun:test";
import {
  addressableLoader,
  addressableMark,
  addressableWordmark,
  GAZE,
  icon,
  loader,
  MARK_STATES,
  wordmark,
} from "./index.ts";

/** Every value of `attr` in `svg`, in order. */
const all = (svg: string, attr: string) =>
  [...svg.matchAll(new RegExp(` ${attr}="([^"]*)"`, "g"))].map((m) => m[1] ?? "");
/** The elements of `svg` whose class list holds `cls`, as their source text. */
const withClass = (svg: string, cls: string) =>
  [...svg.matchAll(/<[a-z]+ [^>]*>/g)]
    .map((m) => m[0])
    .filter((el) => (/ class="([^"]*)"/.exec(el)?.[1] ?? "").split(" ").includes(cls));
const d = (el: string) => / d="([^"]*)"/.exec(el)?.[1] ?? "";

test("the wordmark's letters, eyes and chunks are each addressable, and draw the flat wordmark's shapes", () => {
  const svg = addressableWordmark("hero");
  const solid = wordmark("#000", "#f00", true);
  const ring = wordmark("#000", "#f00");
  const letters = withClass(svg, "letter");
  expect(letters.map((el) => / class="letter (letter-[a-z])"/.exec(el)?.[1])).toEqual([
    "letter-l",
    "letter-k",
    "letter-o",
    "letter-v",
    "letter-e",
    "letter-r",
  ]);
  // The flat file's first six paths are the letters; then each eye's path (and, ring, its pupil).
  const flatSolid = all(solid, "d");
  expect(letters.map(d)).toEqual(flatSolid.slice(0, 6));
  // Solid: the o's outline, masked by its hole, is the flat evenodd path's two contours.
  const eyes = withClass(svg, "eye");
  expect(eyes).toHaveLength(2);
  expect(eyes.every((el) => el.includes(' data-eye=""'))).toBe(true);
  const holes = withClass(svg, "hole").map(d);
  const outlines = [...svg.matchAll(/<path d="([^"]*)" mask="url\(#hero-s[12]\)"\/>/g)].map((m) => m[1]);
  expect(outlines.map((o, i) => `${o}${holes[i]}`)).toEqual(flatSolid.slice(6, 8));
  // The hole sits 62 units under the letter's counter: its first point is the counter's, lowered.
  expect(holes[0]?.startsWith("M 533 -70L 533 -70Q 579 -70")).toBe(true);
  // Ring: the same evenodd path, and the pupil the flat circle.
  const ringEyes = withClass(svg, "eye-ring").length;
  expect(ringEyes).toBe(2);
  const ringPaths = [...svg.matchAll(/<path fill-rule="evenodd" d="([^"]*)"\/>/g)].map((m) => m[1]);
  expect(ringPaths).toEqual(all(ring, "d").slice(6, 8));
  const pupils = withClass(svg, "pupil");
  expect(
    pupils.map((el) => [
      / cx="([^"]*)"/.exec(el)?.[1],
      / cy="([^"]*)"/.exec(el)?.[1],
      / r="([^"]*)"/.exec(el)?.[1],
    ]),
  ).toEqual([
    ["531", "-174.05", "79.5"],
    ["1085", "-174.05", "79.5"],
  ]);
  expect(ring).toContain('<circle cx="531" cy="-174.05" r="79.5"/>');
  // The chunks: the flat rectangles, the accent one marked.
  const chunks = withClass(svg, "chunk");
  const box = (el: string) =>
    ["x", "y", "width", "height"].map((a) => new RegExp(` ${a}="([^"]*)"`).exec(el)?.[1]);
  const flatChunks = [...solid.matchAll(/<rect [^>]*\/>/g)].map((m) => m[0]);
  expect(chunks.map(box)).toEqual(flatChunks.map(box));
  expect(chunks.map((el) => el.includes("chunk-acc"))).toEqual([false, true, false, false, false]);
  expect(chunks.map((el) => / data-i="(\d)"/.exec(el)?.[1])).toEqual(["0", "1", "2", "3", "4"]);
  // Two wordmarks on one page don't share a mask.
  expect(addressableWordmark("footer")).not.toContain('id="hero-');
});

test("the mark's eyes, holes, lids, pupils and lines are each addressable, and draw the flat mark's shapes", () => {
  const svg = addressableMark("top");
  const solid = icon(null, "#000", "#f00", true);
  const ring = icon(null, "#000", "#f00", false);
  expect(svg).toContain('viewBox="0 0 64 64"');
  expect(withClass(svg, "eye")).toHaveLength(2);
  const holes = withClass(svg, "hole").map(d);
  const discs = [...svg.matchAll(/<path d="([^"]*)" mask="url\(#top-s[12]\)"\/>/g)].map((m) => m[1]);
  expect([`${discs[0]}${holes[0]}${discs[1]}${holes[1]}`]).toEqual(all(solid, "d").slice(0, 1));
  expect(holes[0]).toBe("M15.6 23.48a3.8 4.23 0 1 0 7.6 0a3.8 4.23 0 1 0 -7.6 0z");
  const rings = withClass(svg, "eye-ring");
  expect(rings).toHaveLength(2);
  const ringPaths = [...svg.matchAll(/<path fill-rule="evenodd" d="([^"]*)"\/>/g)].map((m) => m[1]);
  expect([ringPaths.join("")]).toEqual(all(ring, "d").slice(0, 1));
  const pupils = withClass(svg, "pupil").map(d);
  expect([pupils.join("")]).toEqual(all(ring, "d").slice(1, 2));
  expect(pupils[0]).toBe("M15.9 23.9a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0 -7 0z");
  // The lids cover each eye when open (scaleY(1) from the mark's top: 0 to the eye's bottom, 11.85 + 18.8), across
  // the mark's width, so no edge lies on the eye's outline; they are shut in the markup.
  const lids = withClass(svg, "lid");
  expect(lids).toHaveLength(4);
  expect(lids[0]).toContain('x="0" y="0" width="64" height="30.65"');
  expect(lids[0]).toContain('transform="scale(1 0)" style="transform-origin:19.4px 0px"');
  // The lines: the flat rectangles, the first in the accent.
  const lines = withClass(svg, "line");
  const box = (el: string) =>
    ["x", "y", "width", "height"].map((a) => new RegExp(` ${a}="([^"]*)"`).exec(el)?.[1]);
  expect(lines.map(box)).toEqual([
    ["10", "38.15", "44", "5.1"],
    ["10", "47.05", "29.04", "5.1"],
  ]);
  expect(lines.map((el) => / class="([^"]*)"/.exec(el)?.[1])).toEqual(["line line-1", "line line-2"]);
  expect(svg).toContain('class="mark" data-state="idle"');
  expect(addressableMark("top", "paused")).toContain('class="mark" data-state="paused"');
});

test("the loader draws both its eyes, each the flat loader's, and the theme shows one", () => {
  const svg = addressableLoader("wait", false);
  const inner = (s: string) => s.slice(s.indexOf(">") + 1, s.lastIndexOf("</svg>"));
  const solid = inner(loader({ solid: true, still: false, mask: "wait" }));
  const ring = inner(loader({ solid: false, still: false, mask: "wait" }));
  expect(svg).toBe(
    `<span class="eyes"><svg viewBox="0 0 64 44" aria-hidden="true" fill="currentColor"><g class="e-solid">${solid}</g><g class="e-ring">${ring}</g></svg></span>`,
  );
  expect(svg).toContain('<g class="h read"');
  expect(addressableLoader("wait", true)).toContain('<g class="h" fill="#000">');
  expect(addressableLoader("wait", true)).toContain('<g class="p">');
});

test("the pupils look left, down, right and up: on their travel circle, 30° below the horizontal, or centred", () => {
  // Offsets from where each drawing rests its pupil (straight down, as far out as it travels): a side stop is
  // (∓ rest · cos 30°, rest · sin 30° − rest), up is the eye's centre. Rests: the mark's dot 2.65, its hole 2.23,
  // the wordmark's hole 62, its dot 75.95 (147.5 − 79.5 × 0.9).
  expect(GAZE.mark.ring).toEqual({
    left: [-2.29, -1.33],
    rest: [0, 0],
    right: [2.29, -1.33],
    up: [0, -2.65],
  });
  expect(GAZE.mark.solid).toEqual({
    left: [-1.93, -1.12],
    rest: [0, 0],
    right: [1.93, -1.12],
    up: [0, -2.23],
  });
  expect(GAZE.wordmark.solid).toEqual({
    left: [-53.69, -31],
    rest: [0, 0],
    right: [53.69, -31],
    up: [0, -62],
  });
  expect(GAZE.wordmark.ring).toEqual({
    left: [-65.77, -37.98],
    rest: [0, 0],
    right: [65.77, -37.98],
    up: [0, -75.95],
  });
});

test("the mark's states are idle, reading, found, clear, waiting and paused", () => {
  expect(MARK_STATES).toEqual(["idle", "reading", "found", "clear", "waiting", "paused"]);
});
