// The loader: the mark's two eyes alone on a 64 × 44 box, no lines, the pupils free to move. Its numbers are the
// mark's as rounded on the 64 grid, scaled by the pair's width (44 on the mark's grid) onto the box's 64.
import { type Point, px, readingKeyframes, rule, type Three } from "./css.ts";
import { MARK, PAIR, PUPIL_REST, r2, STOP_ANGLE } from "./numbers.ts";

/** The loader's box, in the drawing's units: the pair's width, and the eyes' height with their room to read. */
const BOX = { width: 64, height: 44 } as const;
/** The pair's scale: its 44 units on the mark's grid onto the box's width. */
const K = BOX.width / PAIR;
const dotRest = PUPIL_REST.ring * K;
const holeRest = PUPIL_REST.solid * K;
/** The dot's stops are (∓3.34, +1.93) on its circle of 3.85, the hole's (∓2.81, +1.62) on its circle of 3.24. */
const stops = (rest: number): Three<Point> => [
  [r2(-rest * Math.cos(STOP_ANGLE)), r2(rest * Math.sin(STOP_ANGLE))],
  [0, r2(rest)],
  [r2(rest * Math.cos(STOP_ANGLE)), r2(rest * Math.sin(STOP_ANGLE))],
];
const ratio = BOX.height / BOX.width;
/**
 * Next to words, the box's width, and how high the eyes' centre sits above the baseline (em). The centre is the
 * old loader's: its 1 em box at `vertical-align: -0.15em` centred the eyes 0.35 em above the baseline, kept so
 * the eyes don't move against the words.
 */
const TEXT = { width: 1.2, centre: 0.35 } as const;
const textHeight = Math.round(1000 * TEXT.width * ratio) / 1000;
const holds: Three<Point> = [
  [0, 21],
  [27, 48],
  [54, 75],
];

/** The loader's numbers on its box, each rounded to two decimals; offsets are from an eye's centre. */
export const LOADER = {
  /** An eye's radius, the centres of the two eyes and their height. */
  eye: r2(MARK.eye * K),
  centres: [r2(MARK.eye * K), r2((3 * MARK.eye + MARK.eyeGap) * K)],
  cy: BOX.height / 2,
  /** The space between the two eyes. */
  gap: r2(MARK.eyeGap * K),
  /** A ring eye's thickness, the radius its stroke is drawn on, and its dot's radius. */
  ring: r2(MARK.ring * K),
  ringRadius: r2((MARK.eye - MARK.ring / 2) * K),
  dot: r2(MARK.ringPupil * K),
  /** A solid eye's hole. */
  hole: { rx: r2(MARK.solidPupilRx * K), ry: r2(MARK.solidPupilRy * K) },
  /** Where the dot and the hole rest, straight down; each travels on a circle of that radius. */
  dotRest: r2(dotRest),
  holeRest: r2(holeRest),
  /** The three stops of each, left, middle, right, on the lower half of its eye. */
  dotStops: stops(dotRest),
  holeStops: stops(holeRest),
  /** The percentages of the loop each stop holds, when it is back at the first, and the loop's length. */
  holds,
  back: 87,
  seconds: 1.8,
  /**
   * The box the drawing sits in, at its own ratio: next to words (em, to four decimals), lowered so the eyes'
   * centre is `TEXT.centre` above the baseline, and large (px).
   */
  box: {
    drawing: BOX,
    text: {
      width: TEXT.width,
      height: textHeight,
      align: Math.round(10000 * (TEXT.centre - textHeight / 2)) / 10000,
    },
    large: { width: 48, height: r2(48 * ratio) },
  },
} as const;

/** The loader's solid eyes, cut by the holes in the mask `mask`; the holes read unless `still`. */
export function solidEyes(mask: string, still: boolean): string {
  const { centres, cy, eye, hole } = LOADER;
  const [c1, c2] = centres;
  const { width: w, height: h } = BOX;
  const read = still ? "" : " read";
  return `<defs><mask id="${mask}" maskUnits="userSpaceOnUse" x="0" y="0" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#fff"/><g class="h${read}" fill="#000"><ellipse cx="${c1}" cy="${cy}" rx="${hole.rx}" ry="${hole.ry}"/><ellipse cx="${c2}" cy="${cy}" rx="${hole.rx}" ry="${hole.ry}"/></g></mask></defs><g mask="url(#${mask})"><circle cx="${c1}" cy="${cy}" r="${eye}"/><circle cx="${c2}" cy="${cy}" r="${eye}"/></g>`;
}

/** The loader's ring eyes and their dots; the dots read unless `still`. */
export function ringEyes(still: boolean): string {
  const { centres, cy, ring, ringRadius, dot } = LOADER;
  const [c1, c2] = centres;
  const read = still ? "" : " read";
  return `<g fill="none" stroke="currentColor" stroke-width="${ring}"><circle cx="${c1}" cy="${cy}" r="${ringRadius}"/><circle cx="${c2}" cy="${cy}" r="${ringRadius}"/></g><g class="p${read}"><circle cx="${c1}" cy="${cy}" r="${dot}"/><circle cx="${c2}" cy="${cy}" r="${dot}"/></g>`;
}

/** The loader's box as an SVG element's opening tag, coloured by `currentColor`. */
export const LOADER_SVG = `<svg viewBox="0 0 ${BOX.width} ${BOX.height}" aria-hidden="true" fill="currentColor">`;

/** The loader as SVG text, coloured by `currentColor`: ring eyes with dots, or solid eyes with holes. */
export function loader({ solid, still, mask }: { solid: boolean; still: boolean; mask: string }): string {
  return `${LOADER_SVG}${solid ? solidEyes(mask, still) : ringEyes(still)}</svg>`;
}

const keyframes = (name: string, stops: Three<Point>) =>
  readingKeyframes(name, stops, LOADER.holds, LOADER.back);

/**
 * The loader's box and motion as CSS text, formatted as Biome formats CSS: the box at the drawing's ratio, next
 * to words and large (`.lg`), the ring's dot (`.p`) and the solid eye's hole (`.h`) at rest, and moving through
 * the `read` and `read-solid` keyframes when `.read`.
 */
export function loaderCss(): string {
  const { dotRest, holeRest, seconds, dotStops, holeStops, box } = LOADER;
  const lines = [
    ...rule(
      [".eyes"],
      [
        `width: ${box.text.width}em;`,
        `height: ${box.text.height}em;`,
        `vertical-align: ${box.text.align}em;`,
      ],
    ),
    ...rule([".eyes.lg"], [`width: ${px(box.large.width)};`, `height: ${px(box.large.height)};`]),
    ...rule([".eyes .p"], [`transform: translateY(${px(dotRest)});`]),
    ...rule([".eyes .p.read"], [`animation: read ${seconds}s infinite;`]),
    ...rule([".eyes .h"], [`transform: translateY(${px(holeRest)});`]),
    ...rule([".eyes .h.read"], [`animation: read-solid ${seconds}s infinite;`]),
    ...keyframes("read", dotStops),
    ...keyframes("read-solid", holeStops),
  ];
  return `${lines.join("\n")}\n`;
}
