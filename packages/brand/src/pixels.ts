// Pictures drawn pixel by pixel from a drawing's colour at each point of the mark's 64 grid, 16 samples a pixel, so
// no rasteriser is needed: the icon full bleed and the tray's icons.
import type { Image } from "./png.ts";

/** A colour as red, green and blue, 0 to 255. */
export type Rgb = readonly [number, number, number];

/** A drawing: its colour at a point of the 64 grid, or nothing where its ground shows through. */
export type Drawing = (gx: number, gy: number) => Rgb | null;

/** The colour `#RRGGBB` as its three numbers. */
export function rgb(hex: string): Rgb {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  return [r, g, b];
}

const SAMPLES = 4;

/** The square of the grid a picture shows: its top-left corner (the same across and down) and its side. */
export type View = { from: number; span: number };

/**
 * `view` of the drawing, `side` pixels square. Each pixel is the mean colour of the samples the drawing covers on a
 * grid of 4 × 4 inside it, as opaque as the share it covers; none covered is transparent black.
 */
export function drawPicture(side: number, view: View, drawing: Drawing): Image {
  const scale = side / view.span;
  const rgba = new Uint8Array(side * side * 4);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const at = (i: number, j: number) =>
        drawing(view.from + (x + (i + 0.5) / SAMPLES) / scale, view.from + (y + (j + 0.5) / SAMPLES) / scale);
      rgba.set(pixel(at), (y * side + x) * 4);
    }
  }
  return { width: side, height: side, rgba };
}

/** A pixel from its samples' colours, `at(i, j)` the sample i across and j down: RGBA, transparent black if none. */
function pixel(at: (i: number, j: number) => Rgb | null): number[] {
  const covered: Rgb[] = [];
  for (let j = 0; j < SAMPLES; j++) {
    for (let i = 0; i < SAMPLES; i++) {
      const colour = at(i, j);
      if (colour) covered.push(colour);
    }
  }
  if (covered.length === 0) return [0, 0, 0, 0];
  const mean = [0, 1, 2].map((k) =>
    Math.round(covered.reduce((s, c) => s + (c[k] ?? 0), 0) / covered.length),
  );
  return [...mean, Math.round((255 * covered.length) / SAMPLES ** 2)];
}
