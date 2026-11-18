// The tray's icons (ADR 0105, brand.md "The tray"): the mark in a still frame of each of the tray's states, on a
// transparent ground, in the variant each platform takes, drawn pixel by pixel from the mark's numbers on its 64
// grid. A state changes the mark's silhouette, never only its pupils, which move less than a pixel at 16 px, and
// never by colour alone, which a macOS template loses: lids, no lines, a dot or an `!` at the lines' end.
import { MARK_SHAPES } from "./icon.ts";
import { COLOURS, MARK, PAIR, PUPIL_REST } from "./numbers.ts";
import { type Drawing, drawPicture, type Rgb, rgb, type View } from "./pixels.ts";
import type { Image } from "./png.ts";
import { GAZE, PAUSED_SHARE } from "./states.ts";

/** What a state does to the mark: where its pupils look, its lids, its lines and the sign at their end. */
type Look = { looks: "rest" | "up" | "right"; lids?: true; lines: boolean; sign?: "dot" | "bang" };

/** The tray's states, worst first (ADR 0105): the worst one the service holds is the one shown. */
const LOOKS = {
  problem: { looks: "rest", lines: true, sign: "bang" },
  paused: { looks: "up", lids: true, lines: true },
  "needs-you": { looks: "up", lines: true, sign: "dot" },
  // Reading's right stop, still: the loader, the eyes alone, as wide as the icon.
  reviewing: { looks: "right", lines: false },
  idle: { looks: "rest", lines: true },
} satisfies Record<string, Look>;

/**
 * The states drawn. The tray's own `TrayState` is `@lookover/web/tray`'s (ADR 0105 §9), which this package can't
 * import: the service's `tray-states.test.ts` holds the two equal, so either growing alone fails to compile there.
 */
export type TrayState = keyof typeof LOOKS;

/** The tray's states, worst first. */
export const TRAY_STATES = Object.keys(LOOKS).filter((k): k is TrayState => k in LOOKS);

/** A variant: the sizes its platform asks for, its eyes' drawing and colours, and the tile it sits on, if any. */
type Variant = { sides: readonly number[]; solid: boolean; ink: Rgb; accent: Rgb; tile?: Rgb };

const INK = rgb(COLOURS.ink);
const PAPER = rgb(COLOURS.paper);
const ACCENT = rgb(COLOURS.accent);
const BLACK: Rgb = [0, 0, 0];
const WINDOWS = [16, 20, 24, 32, 48] as const;

/**
 * The variants: Windows' for a light and a dark taskbar (by `SystemUsesLightTheme`), the ring eyes in ink and the
 * solid eyes in paper; macOS' template image, all black, its alpha the drawing, which the menu bar tints; Linux's
 * the icon on its ink tile, which reads on a panel of any colour.
 */
const VARIANTS: Record<TrayVariant, Variant> = {
  light: { sides: WINDOWS, solid: false, ink: INK, accent: ACCENT },
  dark: { sides: WINDOWS, solid: true, ink: PAPER, accent: ACCENT },
  template: { sides: [36], solid: false, ink: BLACK, accent: BLACK },
  panel: { sides: [24, 48], solid: true, ink: PAPER, accent: ACCENT, tile: INK },
};

export type TrayVariant = "light" | "dark" | "template" | "panel";

const variants = Object.keys(VARIANTS).filter((k): k is TrayVariant => k in VARIANTS);

/** A tray icon's file: its path from the checkout's root, `apps/tray/icons/<state>-<variant>-<side>.png`. */
export type TrayIcon = { path: string; state: TrayState; variant: TrayVariant; side: number };

/** Every tray icon `bun run brand` writes, by state (worst first), then variant, then size. */
export const TRAY_ICONS: readonly TrayIcon[] = TRAY_STATES.flatMap((state) =>
  variants.flatMap((variant) =>
    VARIANTS[variant].sides.map((side) => ({
      path: `apps/tray/icons/${state}-${variant}-${side}.png`,
      state,
      variant,
      side,
    })),
  ),
);

const [LINE1, LINE2] = MARK_SHAPES.lines;
const { band } = MARK_SHAPES;
/** Where the first line's height is centred: the dot's centre, and the column the `!` stands in. */
const lineMiddle = LINE1.y + LINE1.height / 2;
/** The mark's right edge: no sign reaches past it, so the 2 units round the mark stay clear. */
const RIGHT = LINE1.x + LINE1.width;
/**
 * The sign at the lines' right end, inside the mark: the dot's centre and radius; the `!`'s column, its bar's
 * half-width (6 units, two whole pixels at 16 px, where a pixel is 3 units from 8, so it never reads as the dot)
 * and its bar's and point's heights; and the room left before either.
 */
const SIGN = {
  dot: { x: RIGHT - 6.5, r: 6.5 },
  bang: { x: RIGHT - 4, half: 3, top: 32.4, bottom: 45.4, point: 50.6, pointR: 3.2 },
  room: 2.4,
} as const;
/** Where the paused lids stop: the site's paused share of the eyes, from their top. */
const LID = band.y + PAUSED_SHARE * band.height;
/** The middle 48 units of the grid a tileless icon shows: the mark's 44 and 2 on each side. */
const MIDDLE = { from: 8, span: MARK.grid - 16 } as const;
/**
 * The loader on the icon (`reviewing`): its 64 box as wide as the grid's middle 48 units, centred, so the pair
 * fills the icon's width. A point of the grid there is the mark's eyes' point `LOADER_AT` gives, scaled about the
 * eyes' centre: the whole drawing scaled, its ring, pupils and gaze with it.
 */
const LOADER_SCALE = MIDDLE.span / PAIR;
const eyesMiddle = band.y + band.height / 2;
const LOADER_AT = (gx: number, gy: number): [number, number] => [
  MARK.grid / 2 + (gx - MARK.grid / 2) / LOADER_SCALE,
  eyesMiddle + (gy - MARK.grid / 2) / LOADER_SCALE,
];

const inBox = (box: typeof LINE1, gx: number, gy: number, right = box.x + box.width) =>
  gx >= box.x && gx < right && gy >= box.y && gy < box.y + box.height;

/** The sign's colour at a point, if the point is in it, and where the first line stops to leave room for it. */
function sign(kind: Look["sign"], gx: number, gy: number): { inSign: boolean; stop: number } {
  if (kind === "dot") {
    const { x, r } = SIGN.dot;
    return { inSign: Math.hypot(gx - x, gy - lineMiddle) <= r, stop: x - r - SIGN.room };
  }
  if (kind === "bang") {
    const { x, half, top, bottom, point, pointR } = SIGN.bang;
    const inBar = Math.abs(gx - x) <= half && gy >= top && gy <= bottom;
    return { inSign: inBar || Math.hypot(gx - x, gy - point) <= pointR, stop: x - half - SIGN.room };
  }
  return { inSign: false, stop: RIGHT };
}

/** Whether a point is in one of the eyes, as `solid` draws them, their pupils where `looks` puts them. */
function inEyes(look: Look, solid: boolean, at: readonly [number, number]): boolean {
  const [gx, gy] = look.lines ? at : LOADER_AT(...at);
  if (look.lids && gy < LID) return false;
  const [dx, dy] = (solid ? GAZE.mark.solid : GAZE.mark.ring)[look.looks];
  return MARK_SHAPES.eyes.some(({ centre, solid: { cy, hole } }) => {
    const fromCentre = Math.hypot(gx - centre, gy - cy);
    if (fromCentre > MARK.eye) return false;
    if (solid) {
      return ((gx - centre - dx) / hole.rx) ** 2 + ((gy - hole.cy - dy) / hole.ry) ** 2 > 1;
    }
    const inPupil = Math.hypot(gx - centre - dx, gy - cy - PUPIL_REST.ring - dy) <= MARK.ringPupil;
    return fromCentre >= MARK.eye - MARK.ring || inPupil;
  });
}

/** Whether a point is on the rounded tile, the icon's, as wide as the grid. */
function onTile(gx: number, gy: number): boolean {
  const r = MARK.tileRx;
  const qx = Math.max(r - gx, gx - (MARK.grid - r), 0);
  const qy = Math.max(r - gy, gy - (MARK.grid - r), 0);
  return gx >= 0 && gy >= 0 && gx <= MARK.grid && gy <= MARK.grid && Math.hypot(qx, qy) <= r;
}

/** A state's drawing in a variant: the colour at each point of the 64 grid, nothing where the ground shows. */
function drawing(state: TrayState, variant: TrayVariant): Drawing {
  const look: Look = LOOKS[state];
  const { solid, ink, accent, tile } = VARIANTS[variant];
  return (gx, gy) => {
    const { inSign, stop } = sign(look.sign, gx, gy);
    if (inSign) return accent;
    if (look.lines && inBox(LINE1, gx, gy, Math.min(stop, LINE1.x + LINE1.width))) return accent;
    if (look.lines && inBox(LINE2, gx, gy)) return ink;
    if (inEyes(look, solid, [gx, gy])) return ink;
    return tile && onTile(gx, gy) ? tile : null;
  };
}

/** The square of the grid a variant shows: the whole tile, or the mark without it, 2 units round it. */
const view = (variant: TrayVariant): View => (VARIANTS[variant].tile ? { from: 0, span: MARK.grid } : MIDDLE);

/** A state's icon in a variant, `side` pixels square, on a transparent ground. */
export function trayIcon(state: TrayState, variant: TrayVariant, side: number): Image {
  return drawPicture(side, view(variant), drawing(state, variant));
}

/** The tray sheet, from the checkout's root: the proof that each state reads at 16 px (brand.md "The tray"). */
export const TRAY_SHEET = "docs/product/brand/lookover-tray-sheet.png";

/** A light and a dark taskbar's grey, the grounds the sheet draws the icons on. */
const GROUNDS = { light: [0xf3, 0xf3, 0xf3], dark: [0x20, 0x20, 0x20] } as const satisfies Record<
  string,
  Rgb
>;
/** The sheet's sizes, its gap between icons and cells, and how many screen pixels each icon's pixel takes. */
const SHEET_SIDES = [16, 24, 32] as const;
const GAP = 4;
const ZOOM = 4;
const WHITE: Rgb = [255, 255, 255];

/**
 * The sheet's rows: each Windows variant on its taskbar, the template tinted white on the dark one and black on
 * the light one (as the menu bar tints it), the panel's icon on both.
 */
const ROWS: readonly { variant: TrayVariant; ground: Rgb; tint?: Rgb }[] = [
  { variant: "dark", ground: GROUNDS.dark },
  { variant: "light", ground: GROUNDS.light },
  { variant: "template", ground: GROUNDS.dark, tint: WHITE },
  { variant: "template", ground: GROUNDS.light, tint: BLACK },
  { variant: "panel", ground: GROUNDS.dark },
  { variant: "panel", ground: GROUNDS.light },
];

const TALLEST = Math.max(...SHEET_SIDES);
const ROW_HEIGHT = TALLEST + 2 * GAP;
const CELL_WIDTH = SHEET_SIDES.reduce((w, side) => w + side + GAP, GAP);

/**
 * Every state (a column each, worst first) at 16, 24 and 32 px, bottom-aligned, in each of the sheet's rows; each
 * icon's pixel drawn `ZOOM` × `ZOOM`, without smoothing, over its row's ground.
 */
export function traySheet(): Image {
  const width = CELL_WIDTH * TRAY_STATES.length * ZOOM;
  const height = ROW_HEIGHT * ROWS.length * ZOOM;
  const rgba = new Uint8Array(width * height * 4);
  const fill = (x: number, y: number, colour: readonly number[]) => {
    for (let j = 0; j < ZOOM; j++) {
      for (let i = 0; i < ZOOM; i++) rgba.set([...colour, 255], ((y * ZOOM + j) * width + x * ZOOM + i) * 4);
    }
  };
  ROWS.forEach(({ variant, ground, tint }, row) => {
    const top = row * ROW_HEIGHT;
    for (let y = top; y < top + ROW_HEIGHT; y++) {
      for (let x = 0; x < width / ZOOM; x++) fill(x, y, ground);
    }
    TRAY_STATES.forEach((state, column) => {
      let left = column * CELL_WIDTH + GAP;
      for (const side of SHEET_SIDES) {
        const icon = trayIcon(state, variant, side);
        const base = top + GAP + TALLEST - side;
        for (let y = 0; y < side; y++) {
          for (let x = 0; x < side; x++) {
            const at = (y * side + x) * 4;
            const alpha = (icon.rgba[at + 3] ?? 0) / 255;
            const colour = tint ?? [...icon.rgba.subarray(at, at + 3)];
            const over = ground.map((g, k) => Math.round((colour[k] ?? 0) * alpha + g * (1 - alpha)));
            fill(left + x, base + y, over);
          }
        }
        left += side + GAP;
      }
    });
  });
  return { width, height, rgba };
}
