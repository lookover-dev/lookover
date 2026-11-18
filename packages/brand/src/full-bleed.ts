// The icon full bleed as a picture (ADR 0098): the ink to every edge and no tile's corners, at a side in pixels.
// Where a ground that is not ours crops the icon to a circle or a rounded square (GitHub's App badge, a search
// result, a phone's home screen), a rounded tile would sit in a ring of another colour; on ink to the edges, the
// crop takes only ink. The mark is the icon's, at its place on the 64 grid: its farthest point, the second line's
// outer corners, is `MARK_REACH` from the centre, inside the crop's radius of 32. Drawn pixel by pixel from the
// mark's numbers, 16 samples a pixel, so no rasteriser is needed.
import { MARK_SHAPES } from "./icon.ts";
import { COLOURS, MARK } from "./numbers.ts";
import { drawPicture, type Rgb, rgb } from "./pixels.ts";
import type { Image } from "./png.ts";

/**
 * Every picture of the icon full bleed `bun run brand` writes, as its path from the checkout's root and its side in
 * pixels: the GitHub App's logo at GitHub's recommended size, uploaded by hand on the App's page with its badge
 * colour the ink (brand.md), and lookover.dev's favicon at multiples of 48 px and its apple-touch icon at 180.
 */
export const FULL_BLEED_PICTURES = {
  app: { path: "docs/product/brand/lookover-app-icon.png", side: 200 },
  site: [
    { path: "apps/site/public/favicon-48.png", side: 48 },
    { path: "apps/site/public/favicon-96.png", side: 96 },
    { path: "apps/site/public/favicon-192.png", side: 192 },
    { path: "apps/site/public/apple-touch-icon.png", side: 180 },
  ],
} as const;

const C = MARK.grid / 2;

/** How far from the centre of the 64 grid the mark reaches: an eye's far edge or a line's far corner. */
export const MARK_REACH = Math.max(
  ...MARK_SHAPES.eyes.map(({ centre, solid }) => Math.hypot(centre - C, solid.cy - C) + MARK.eye),
  ...MARK_SHAPES.lines.flatMap(({ x, y, width, height }) =>
    [x, x + width].flatMap((px) => [y, y + height].map((py) => Math.hypot(px - C, py - C))),
  ),
);

const INK = rgb(COLOURS.ink);
const PAPER = rgb(COLOURS.paper);
const ACCENT = rgb(COLOURS.accent);

/** The colour at a point of the 64 grid: the icon's drawing on the ink tile, solid eyes in paper. */
function colourAt(gx: number, gy: number): Rgb {
  const [line1, line2] = MARK_SHAPES.lines;
  const inRect = (r: typeof line1) => gx >= r.x && gx < r.x + r.width && gy >= r.y && gy < r.y + r.height;
  if (inRect(line1)) return ACCENT;
  if (inRect(line2)) return PAPER;
  for (const { centre, solid } of MARK_SHAPES.eyes) {
    const inDisc = (gx - centre) ** 2 + (gy - solid.cy) ** 2 <= MARK.eye ** 2;
    const inHole = ((gx - centre) / solid.hole.rx) ** 2 + ((gy - solid.hole.cy) / solid.hole.ry) ** 2 <= 1;
    if (inDisc && !inHole) return PAPER;
  }
  return INK;
}

/** The icon full bleed, `side` pixels square, every pixel opaque. */
export function iconFullBleedPicture(side: number): Image {
  return drawPicture(side, { from: 0, span: MARK.grid }, colourAt);
}
