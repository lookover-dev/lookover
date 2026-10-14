// Where the pupils look, and the mark's states on the site. Every pupil travels as the loader's do (brand.md, "The
// eyes, exactly"): on a circle around its eye's centre, as far out as it rests, its side stops 30° below the
// horizontal; up is the eye's centre. The offsets are from where each drawing rests its pupil, straight down.
import { type Point, px, readingKeyframes, rule, type Three } from "./css.ts";
import { MARK_SHAPES } from "./icon.ts";
import { LOADER } from "./loader.ts";
import { MARK, PUPIL_REST, r2, STOP_ANGLE } from "./numbers.ts";
import { WORDMARK_SHAPES } from "./wordmark.ts";

/** A pupil's four places, as offsets from its rest. */
type Gaze = { left: Point; rest: Point; right: Point; up: Point };

function gaze(rest: number): Gaze {
  const side = r2(rest * Math.cos(STOP_ANGLE));
  const rise = r2(rest * Math.sin(STOP_ANGLE) - rest);
  return { left: [-side, rise], rest: [0, 0], right: [side, rise], up: [0, r2(-rest)] };
}

/**
 * Where each pupil looks, in its drawing's units: the wordmark's (font units) and the mark's (its 64 grid), the
 * solid eye's hole and the ring eye's dot.
 */
export const GAZE = {
  wordmark: { solid: gaze(WORDMARK_SHAPES.rest.solid), ring: gaze(WORDMARK_SHAPES.rest.ring) },
  mark: { solid: gaze(PUPIL_REST.solid), ring: gaze(PUPIL_REST.ring) },
} as const;

/** What a state does to the mark: where its pupils look, how far its lids close, its lines' colour, its loops. */
type Look = { looks?: "right" | "up"; lid?: number; lines?: "--ok" | "--faint"; reads?: true; blinks?: true };

export type Box = { x: number; y: number; width: number; height: number };

/**
 * A lid's box: the drawing's width, from its top down to `bottom`, its eye's, so none of its edges lies on the
 * eye's outline (where antialiasing would leave a hairline). Its mask cuts its own eye only.
 */
export const lidBox = (view: Box, bottom: number): Box => ({
  x: view.x,
  y: view.y,
  width: view.width,
  height: r2(bottom - view.y),
});

/** The share of an eye a paused mark's lids cover: past its centred pupil, a sliver of the eye left under it. */
const PAUSED_SHARE = 0.74;
/** That share as the lid's scale: the lid closes from the mark's top, above its eyes. */
const { band } = MARK_SHAPES;
const pausedLid = r2(
  (band.y + PAUSED_SHARE * band.height) /
    lidBox({ x: 0, y: 0, width: MARK.grid, height: MARK.grid }, band.y + band.height).height,
);
/** The idle blink: once every 6 s, shut at 95 % of the loop. */
const BLINK = { seconds: 6, shut: 95, from: 92, to: 98 } as const;

/** The mark's states on the site, in the order the site shows them; `data-state` on the mark's `svg` picks one. */
const STATES = {
  idle: { blinks: true },
  reading: { reads: true },
  found: { looks: "right" },
  clear: { lines: "--ok" },
  waiting: { looks: "up", lines: "--faint" },
  paused: { looks: "up", lid: pausedLid },
} satisfies Record<string, Look>;

export type MarkState = keyof typeof STATES;

const keys = <K extends string>(record: Record<K, unknown>): K[] =>
  Object.keys(record).filter((k): k is K => k in record);

/** The mark's states, in order. */
export const MARK_STATES: readonly MarkState[] = keys(STATES);

const state = (s: MarkState, part: string) => `.mark[data-state="${s}"] ${part}`;
const moved = ([x, y]: Point) => (x === 0 ? `translateY(${px(y)})` : `translate(${px(x)}, ${px(y)})`);

/** A state's rules that hold still: where its pupils look, how far its lids close, its lines' colour. */
function stateRules(s: MarkState, look: Look): string[] {
  const { solid, ring } = GAZE.mark;
  return [
    ...(look.looks
      ? [
          ...rule([state(s, ".hole")], [`transform: ${moved(solid[look.looks])};`]),
          ...rule([state(s, ".pupil")], [`transform: ${moved(ring[look.looks])};`]),
        ]
      : []),
    ...(look.lid ? rule([state(s, ".lid")], [`transform: scaleY(${look.lid});`]) : []),
    ...(look.lines ? rule([state(s, ".line")], [`fill: var(${look.lines});`]) : []),
  ];
}

/** A state's loops, indented to sit in the no-preference block: the idle blink, the reading pupils. */
function stateLoops(s: MarkState, look: Look): string[] {
  const loop = (part: string, animation: string) =>
    rule([state(s, part)], [`animation: ${animation};`], "  ");
  return [
    ...(look.blinks ? loop(".lid", `mark-blink ${BLINK.seconds}s infinite`) : []),
    ...(look.reads
      ? [
          ...loop(".hole", `mark-read-solid ${LOADER.seconds}s infinite`),
          ...loop(".pupil", `mark-read ${LOADER.seconds}s infinite`),
        ]
      : []),
  ];
}

const reading = ({ left, rest, right }: Gaze): Three<Point> => [left, rest, right];

/**
 * The mark's states as CSS text, formatted as Biome formats CSS: each state's rules, then its loops only under
 * `prefers-reduced-motion: no-preference` (so under reduced motion the pupils rest and the lids stay open, whatever
 * outranks what), the reading loop of its hole and its dot (the loader's holds and length), and the idle blink.
 */
export function markStatesCss(): string {
  const shut = ["transform: scaleY(0);"];
  const lines = [
    ...MARK_STATES.flatMap((s) => stateRules(s, STATES[s])),
    "@media (prefers-reduced-motion: no-preference) {",
    ...MARK_STATES.flatMap((s) => stateLoops(s, STATES[s])),
    "}",
    ...readingKeyframes("mark-read", reading(GAZE.mark.ring), LOADER.holds, LOADER.back),
    ...readingKeyframes("mark-read-solid", reading(GAZE.mark.solid), LOADER.holds, LOADER.back),
    "@keyframes mark-blink {",
    ...rule(["0%", `${BLINK.from}%`], shut, "  "),
    ...rule([`${BLINK.shut}%`], ["transform: scaleY(1);"], "  "),
    ...rule([`${BLINK.to}%`, "100%"], shut, "  "),
    "}",
  ];
  return `${lines.join("\n")}\n`;
}
