// The GitHub App's logo: the icon full bleed, the ink to every edge and no tile's corners, as a PNG. GitHub draws
// an App's logo on its badge colour and crops it to a circle, so a rounded tile would sit in a disc of another
// colour; on ink to the edges, the circle crops only ink. The mark is the icon's, at its place on the 64 grid: its
// farthest point, the second line's outer corners, is `MARK_REACH` from the centre, inside the crop's radius of 32.
// Drawn pixel by pixel from the mark's numbers, 16 samples a pixel, so no rasteriser is needed.
import { MARK_SHAPES } from "./icon.ts";
import { COLOURS, MARK } from "./numbers.ts";
import type { Image } from "./png.ts";

/** Where `bun run brand` writes it, from the checkout's root. */
export const APP_ICON = "docs/product/brand/lookover-app-icon.png";

/** Its side in pixels: GitHub's recommended size for an App's logo. */
export const APP_ICON_SIZE = 200;

const SAMPLES = 4;
const C = MARK.grid / 2;

/** How far from the centre of the 64 grid the mark reaches: an eye's far edge or a line's far corner. */
export const MARK_REACH = Math.max(
  ...MARK_SHAPES.eyes.map(({ centre, solid }) => Math.hypot(centre - C, solid.cy - C) + MARK.eye),
  ...MARK_SHAPES.lines.flatMap(({ x, y, width, height }) =>
    [x, x + width].flatMap((px) => [y, y + height].map((py) => Math.hypot(px - C, py - C))),
  ),
);

const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
const INK = rgb(COLOURS.ink);
const PAPER = rgb(COLOURS.paper);
const ACCENT = rgb(COLOURS.accent);

/** The colour at a point of the 64 grid: the icon's drawing on the ink tile, solid eyes in paper. */
function colourAt(gx: number, gy: number): number[] {
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

/** The App's logo, `APP_ICON_SIZE` square, every pixel opaque. */
export function appIcon(): Image {
  const size = APP_ICON_SIZE;
  const scale = size / MARK.grid;
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) rgba.set([...pixelAt(x, y, scale), 255], (y * size + x) * 4);
  }
  return { width: size, height: size, rgba };
}

/** The pixel at (x, y): the mean of its samples' colours, on a grid of `SAMPLES` × `SAMPLES` inside it. */
function pixelAt(x: number, y: number, scale: number): number[] {
  const sum = [0, 0, 0];
  for (let j = 0; j < SAMPLES; j++) {
    for (let i = 0; i < SAMPLES; i++) {
      const colour = colourAt((x + (i + 0.5) / SAMPLES) / scale, (y + (j + 0.5) / SAMPLES) / scale);
      colour.forEach((c, k) => {
        sum[k] = (sum[k] ?? 0) + c;
      });
    }
  }
  return sum.map((s) => Math.round(s / SAMPLES ** 2));
}
