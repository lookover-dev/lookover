// The app's eyes are the source's: `Mark`, `Eyes` and the GitHub avatar's icon, rendered to static markup, draw the
// numbers of the module `bun run brand` writes (the package's own test keeps that module what the source draws).
// What is compared is the numbers parsed from each element's attributes, not the markup's text, and every element
// is listed: a component that draws something of its own fails, and so does an attribute the test does not know.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BrandIcon, Eyes, Mark } from "./basics.tsx";
import { ICON_TILE, LOADER, MARK } from "./eyes.generated.ts";

/** The attributes that draw: each one's numbers, in order. */
const DRAWN = [
  "viewBox",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x",
  "y",
  "width",
  "height",
  "stroke-width",
  "d",
  "transform",
];
/** The attributes that say how it is painted and which state it is in, kept as text. */
const PAINTED = ["class", "fill", "fill-rule", "stroke", "style", "maskUnits"];
/** The attributes that neither draw nor paint: the namespace, how it is read out, and the mask's id and its use. */
const INERT = ["xmlns", "role", "aria-label", "aria-hidden", "id", "mask"];

type Shape = { tag: string; at: Record<string, number[] | string> };

const numbers = (text: string) => [...text.matchAll(/-?\d*\.?\d+/g)].map(([n]) => Number(n));

/** Each element of `markup`, in order, with the numbers of its drawing attributes and its paint. */
function shapes(markup: string): Shape[] {
  return [...markup.matchAll(/<(\w+)([^>]*)>/g)].map(([, tag = "", attrs = ""]) => {
    const at: Shape["at"] = {};
    for (const [, name = "", value = ""] of attrs.matchAll(/([\w:-]+)="([^"]*)"/g)) {
      if (DRAWN.includes(name)) at[name] = numbers(value);
      else if (PAINTED.includes(name)) at[name] = value;
      else if (!INERT.includes(name))
        throw new Error(`<${tag}> has ${name}, an attribute this test does not know`);
    }
    return { tag, at };
  });
}

const shape = (tag: string, at: Shape["at"] = {}): Shape => ({ tag, at });

const { lines } = MARK;
const markLines = (accent: string, ink: string): Shape[] => [
  shape("rect", { x: [lines.x], y: [lines.y1], width: [lines.width1], height: [lines.height], fill: accent }),
  shape("rect", { x: [lines.x], y: [lines.y2], width: [lines.width2], height: [lines.height], fill: ink }),
];

/** What `Mark` draws: both drawings, the styles show the one that fits the theme. */
const mark: Shape[] = [
  shape("svg", { class: "mark", viewBox: [0, 0, MARK.grid, MARK.grid] }),
  shape("path", {
    class: "mark-solid",
    "fill-rule": "evenodd",
    fill: "currentColor",
    d: numbers(MARK.solid),
  }),
  shape("g", { class: "mark-ring", fill: "currentColor" }),
  shape("path", { "fill-rule": "evenodd", d: numbers(MARK.ring) }),
  shape("path", { d: numbers(MARK.pupils) }),
  ...markLines("var(--acc)", "currentColor"),
];

const { width, height, centres, cy } = LOADER;
const disc = (r: number) => centres.map((cx) => shape("circle", { cx: [cx], cy: [cy], r: [r] }));

/** What `Eyes` draws: the solid eyes cut by their holes, and the ring eyes with their dots. */
const eyes = ({ read, large }: { read: boolean; large: boolean }): Shape[] => [
  shape("span", { class: large ? "eyes lg" : "eyes " }),
  shape("svg", { viewBox: [0, 0, width, height], fill: "currentColor" }),
  shape("defs"),
  shape("mask", { maskUnits: "userSpaceOnUse", x: [0], y: [0], width: [width], height: [height] }),
  shape("rect", { width: [width], height: [height], fill: "#fff" }),
  shape("g", { class: read ? "h read" : "h", fill: "#000" }),
  ...centres.map((cx) =>
    shape("ellipse", { cx: [cx], cy: [cy], rx: [LOADER.hole.rx], ry: [LOADER.hole.ry] }),
  ),
  shape("g", { class: "e-solid" }),
  ...disc(LOADER.eye),
  shape("g", { class: "e-ring" }),
  shape("g", { fill: "none", stroke: "currentColor", "stroke-width": [LOADER.ring] }),
  ...disc(LOADER.ringRadius),
  shape("g", { class: read ? "p read" : "p" }),
  ...disc(LOADER.dot),
];

test("the mark draws the source's eyes and lines, ring and solid", () => {
  expect(shapes(renderToStaticMarkup(<Mark />))).toEqual(mark);
});

test("the loader draws the source's eyes, ring and solid, still and reading, next to words and large", () => {
  for (const read of [false, true]) {
    for (const large of [false, true]) {
      const markup = renderToStaticMarkup(<Eyes still={!read} large={large} />);
      expect(shapes(markup)).toEqual(eyes({ read, large }));
    }
  }
});

test("the avatar's icon is the file's: the solid mark on its own tile, in the file's colours", () => {
  expect(shapes(renderToStaticMarkup(<BrandIcon />))).toEqual([
    shape("svg", { viewBox: [0, 0, MARK.grid, MARK.grid] }),
    shape("rect", { width: [MARK.grid], height: [MARK.grid], rx: [ICON_TILE.rx], fill: ICON_TILE.tile }),
    shape("path", { "fill-rule": "evenodd", fill: ICON_TILE.eyes, d: numbers(MARK.solid) }),
    ...markLines(ICON_TILE.accent, ICON_TILE.eyes),
  ]);
});

test("a mark that moves or scales its drawing fails", () => {
  const markup = renderToStaticMarkup(<Mark />);
  const scaled = markup.replace(
    `<path d="${MARK.pupils}"`,
    `<path transform="scale(1.1)" d="${MARK.pupils}"`,
  );
  expect(scaled).not.toBe(markup);
  expect(shapes(markup)).toEqual(mark);
  expect(shapes(scaled)).not.toEqual(mark);
});

test("an attribute the test does not know fails", () => {
  const markup = renderToStaticMarkup(<Mark />).replace("<path ", '<path vector-effect="none" ');
  expect(() => shapes(markup)).toThrow("vector-effect");
});

test("a loader drawn with a different radius fails", () => {
  const markup = renderToStaticMarkup(<Eyes />);
  const wider = markup.replaceAll(`r="${LOADER.eye}"`, 'r="14.25"');
  expect(wider).not.toBe(markup);
  expect(shapes(markup)).toEqual(eyes({ read: true, large: false }));
  expect(shapes(wider)).not.toEqual(eyes({ read: true, large: false }));
});
