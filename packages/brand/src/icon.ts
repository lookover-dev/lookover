// The mark and the icon: two eyes and two plain lines on a 64 grid, centred, the icon on its tile.
import { MARK, PAIR, PUPIL_REST, r2 } from "./numbers.ts";

/** A circle or an ellipse as path data: two arcs. */
function circle(cx: number, cy: number, rx: number, ry = rx): string {
  return `M${r2(cx - rx)} ${r2(cy)}a${r2(rx)} ${r2(ry)} 0 1 0 ${r2(2 * rx)} 0a${r2(rx)} ${r2(ry)} 0 1 0 ${r2(-2 * rx)} 0z`;
}

/** What the mark draws on its 64 grid, solid or ring: path data and the lines' boxes. */
export type MarkParts = {
  /** The eyes, drawn with `fill-rule="evenodd"`: each disc with its hole (solid) or its counter (ring). */
  eyes: string;
  /** The ring eyes' pupils; empty for solid eyes. */
  pupils: string;
  /** The lines' left edge, the first line's width, the second's, their tops and their height. */
  x0: number;
  span: number;
  span2: number;
  y1: number;
  y2: number;
  h: number;
};

const R = MARK.eye;
const x0 = (MARK.grid - PAIR) / 2;
const top = (MARK.grid - (2 * R + MARK.lineGap + 2 * MARK.lineH + MARK.lineSep)) / 2;
const ecy = top + R;
const y1 = top + 2 * R + MARK.lineGap;

/**
 * The mark's shapes one by one, for the drawing whose parts the site animates: each eye's disc, its solid hole,
 * its ring (the disc and its counter) and its ring pupil as path data, with its box; then the lines' boxes.
 */
export const MARK_SHAPES = {
  /** The band both eyes sit in: its top and its height. */
  band: { y: r2(ecy - R), height: 2 * R },
  eyes: [x0 + R, x0 + 3 * R + MARK.eyeGap].map((c) => ({
    centre: r2(c),
    disc: circle(c, ecy, R),
    hole: circle(c, ecy + PUPIL_REST.solid, MARK.solidPupilRx, MARK.solidPupilRy),
    ring: circle(c, ecy, R) + circle(c, ecy, R - MARK.ring),
    pupil: circle(c, ecy + PUPIL_REST.ring, MARK.ringPupil),
    box: { x: r2(c - R), y: r2(ecy - R), width: 2 * R, height: 2 * R },
  })),
  lines: [
    { x: r2(x0), y: r2(y1), width: r2(PAIR), height: MARK.lineH },
    { x: r2(x0), y: r2(y1 + MARK.lineH + MARK.lineSep), width: r2(PAIR * MARK.line2), height: MARK.lineH },
  ] as const,
};

/** The mark's drawing on its 64 grid. */
export function markParts(solid: boolean): MarkParts {
  const {
    eyes,
    lines: [line1, line2],
  } = MARK_SHAPES;
  return {
    eyes: eyes.map((e) => (solid ? e.disc + e.hole : e.ring)).join(""),
    pupils: solid ? "" : eyes.map((e) => e.pupil).join(""),
    x0: line1.x,
    span: line1.width,
    span2: line2.width,
    y1: line1.y,
    y2: line2.y,
    h: MARK.lineH,
  };
}

/** The icon as an SVG file's text: the mark on its tile, or the mark alone when `tile` is null. */
export function icon(tile: string | null, ink: string, accent: string, solid: boolean): string {
  const p = markParts(solid);
  const g = MARK.grid;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${g} ${g}" role="img" aria-label="Lookover">
${tile ? `<rect width="${g}" height="${g}" rx="${MARK.tileRx}" fill="${tile}"/>` : ""}
<path fill-rule="evenodd" fill="${ink}" d="${p.eyes}"/>${p.pupils ? `<path fill="${ink}" d="${p.pupils}"/>` : ""}<rect x="${p.x0}" y="${p.y1}" width="${p.span}" height="${p.h}" fill="${accent}"/><rect x="${p.x0}" y="${p.y2}" width="${p.span2}" height="${p.h}" fill="${ink}"/>
</svg>`;
}
