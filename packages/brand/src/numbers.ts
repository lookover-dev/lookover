// The numbers of the eyes: the colours, the o of Figtree the wordmark's eyes are made from, and the mark's eyes on
// its 64 grid. Every other drawing's numbers are derived from these, never retyped.

/** Rounds to two decimals, as every number a copy prints is. */
export function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The brand's colours: ink, paper and the accent (a trial). */
export const COLOURS = { ink: "#16130F", paper: "#F7F6F2", accent: "#E5347B" } as const;

/**
 * The o of Figtree ExtraBold as placed in "over" (1 unit = 1 font unit, upm 1000): its centre, its half-sizes and
 * the half-sizes of its counter.
 */
export const O = { cx: 2160, cy: -250, rx: 266, ry: 262, counterRx: 106, counterRy: 118 } as const;

/** What is left of a solid eye's o under its lowered counter (144 in the letter). */
export const SOLID_FLOOR = 82;

/**
 * The mark's eyes and lines on its 64 grid. Light on dark, an eye is solid with the pupil cut out, in the
 * proportions of the wordmark's solid eyes (the letter's counter, to scale); dark on light, it is a ring with a
 * pupil, since solid eyes there read as two black dots.
 */
export const MARK = {
  /** The grid's side: the mark and the icon's tile are drawn on a square this wide. */
  grid: 64,
  /** An eye's outer radius. */
  eye: 9.4,
  /** The space between the two eyes. */
  eyeGap: 6.4,
  /** A solid eye's pupil: the letter's counter, to scale. */
  solidPupilRx: r2((9.4 * O.counterRx) / O.ry),
  solidPupilRy: r2((9.4 * O.counterRy) / O.ry),
  /** What is left of a solid eye under that pupil. */
  solidFloor: r2((9.4 * SOLID_FLOOR) / O.ry),
  /** A ring eye's thickness. */
  ring: 3.6,
  /** A ring eye's pupil radius. */
  ringPupil: 3.5,
  /** How far that pupil sinks into the ring. */
  ringSink: 0.35,
  /** The lines: their height, the space above them, the space between them, and the second one's share. */
  lineH: 5.1,
  lineGap: 7.5,
  lineSep: 3.8,
  line2: 0.66,
  /** The icon's tile radius. */
  tileRx: 14.4,
} as const;

/**
 * How far below the horizontal a pupil's side stops lie, on its travel circle around its eye's centre (as far out
 * as it rests): 30°, eight and four o'clock.
 */
export const STOP_ANGLE = Math.PI / 6;

/** The pair's width on the mark's grid: two eyes and the space between them. */
export const PAIR = 4 * MARK.eye + MARK.eyeGap;

/**
 * How far below its eye's centre each pupil rests on the mark's grid: the ring eye's dot, sunk into the ring, and
 * the solid eye's hole, above its floor.
 */
export const PUPIL_REST = {
  ring: MARK.eye - MARK.ring - MARK.ringPupil + MARK.ringSink,
  solid: MARK.eye - MARK.solidFloor - MARK.solidPupilRy,
} as const;
