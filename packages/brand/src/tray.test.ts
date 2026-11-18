// The tray's icons (ADR 0105, brand.md "The tray"): the mark in a still frame of each of the tray's five states,
// drawn on a transparent ground in four variants, each at the sizes its platform asks for, and named so the helper
// embeds each by state, variant and size.
import { expect, test } from "bun:test";
import {
  COLOURS,
  TRAY_ICONS,
  TRAY_SHEET,
  TRAY_STATES,
  type TrayState,
  trayIcon,
  traySheet,
} from "./index.ts";

test("the tray's states are the five of ADR 0105, worst first", () => {
  expect(TRAY_STATES).toEqual(["problem", "paused", "needs-you", "reviewing", "idle"]);
});

test("each state has its file per variant and size: Windows' two at 16 to 48 px, macOS' template at 36, Linux's at 24 and 48", () => {
  const files = (state: string) => [
    ...[16, 20, 24, 32, 48].map((side) => `apps/tray/icons/${state}-light-${side}.png`),
    ...[16, 20, 24, 32, 48].map((side) => `apps/tray/icons/${state}-dark-${side}.png`),
    `apps/tray/icons/${state}-template-36.png`,
    `apps/tray/icons/${state}-panel-24.png`,
    `apps/tray/icons/${state}-panel-48.png`,
  ];
  expect(TRAY_ICONS.map((i) => i.path)).toEqual(
    ["problem", "paused", "needs-you", "reviewing", "idle"].flatMap(files),
  );
  expect(TRAY_ICONS.find((i) => i.path === "apps/tray/icons/needs-you-dark-20.png")).toMatchObject({
    state: "needs-you",
    variant: "dark",
    side: 20,
  });
});

const hex = (h: string) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
const PAPER = [...hex(COLOURS.paper), 255];
const INK = [...hex(COLOURS.ink), 255];
const ACCENT = [...hex(COLOURS.accent), 255];
const CLEAR = [0, 0, 0, 0];

/** The pixel at (x, y) of an icon `side` pixels square. */
const pixelOf = (image: Image, x: number, y: number) => [
  ...image.rgba.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4),
];
type Image = ReturnType<typeof trayIcon>;

// On a dark taskbar at 48 px, one pixel is one unit of the 64 grid, from 8: pixel (x, y) covers the grid's square
// (x + 8, y + 8) to (x + 9, y + 9). Each point below lies whole inside or outside a shape.
/** The dark 48 px icon of `state`, drawn once, read a pixel at a time. */
const dark = (state: TrayState) => {
  const icon = trayIcon(state, "dark", 48);
  return (x: number, y: number) => pixelOf(icon, x, y);
};

test("idle is the mark at rest: solid eyes in paper, the first line in the accent, the second in paper", () => {
  const at = dark("idle");
  expect(at(4, 13)).toEqual(PAPER); // the left eye's disc, beside its hole
  expect(at(12, 32)).toEqual(ACCENT); // the first line
  expect(at(12, 41)).toEqual(PAPER); // the second
  expect(at(41, 25)).toEqual(CLEAR); // between the right eye and the lines
  expect(at(4, 23)).toEqual(CLEAR); // under the left eye
  expect(at(0, 0)).toEqual(CLEAR);
});

test("reviewing is the loader, still: the eyes alone, centred, as wide as the icon, with no lines", () => {
  const at = dark("reviewing");
  expect(at(12, 34)).toEqual(CLEAR); // where the first line was
  expect(at(12, 41)).toEqual(CLEAR); // where the second was
  expect(at(1, 23)).toEqual(PAPER); // the left eye, past where the mark's starts
  expect(at(46, 23)).toEqual(PAPER); // the right eye, past where the mark's ends
  // At 16 px the eyes reach both edges of the icon.
  const small = trayIcon("reviewing", "dark", 16);
  expect([pixelOf(small, 0, 8)[3], pixelOf(small, 15, 8)[3]]).toEqual([255, 255]);
});

test("paused closes the lids down to a sliver over the lines", () => {
  const at = dark("paused");
  expect(at(4, 13)).toEqual(CLEAR); // under the lid
  expect(at(11, 20)).toEqual(PAPER); // the sliver below it
  expect(at(12, 32)).toEqual(ACCENT);
  expect(at(12, 41)).toEqual(PAPER);
});

test("needs-you ends the first line on a dot, room left before it", () => {
  const at = dark("needs-you");
  expect(at(40, 33)).toEqual(ACCENT); // the dot
  expect(at(31, 32)).toEqual(CLEAR); // the room before it, where idle's line runs
  expect(dark("idle")(31, 32)).toEqual(ACCENT);
  expect(at(12, 32)).toEqual(ACCENT);
});

test("problem stands an exclamation mark at the lines' end, room left before it", () => {
  const at = dark("problem");
  expect(at(41, 25)).toEqual(ACCENT); // its bar, above the first line
  expect(at(41, 43)).toEqual(ACCENT); // its point, beside the second line
  expect(at(37, 32)).toEqual(CLEAR); // the room beside it, where idle's line runs
  expect(dark("idle")(37, 32)).toEqual(ACCENT);
});

test("at 16 px the exclamation mark's bar is two whole pixels wide, so it never reads as needs-you's dot", () => {
  const icon = trayIcon("problem", "dark", 16);
  for (const y of [9, 10, 11]) {
    expect([pixelOf(icon, 13, y), pixelOf(icon, 14, y)]).toEqual([ACCENT, ACCENT]);
  }
});

test.each(["problem", "paused", "needs-you", "idle"] as const)(
  "%s keeps the mark's margin: nothing in the 2 units on either side of it",
  (state) => {
    const at = dark(state);
    for (let y = 0; y < 48; y++) {
      for (const x of [0, 1, 46, 47]) expect({ x, y, alpha: at(x, y)[3] }).toEqual({ x, y, alpha: 0 });
    }
  },
);

test("the light taskbar's are ring eyes in ink; the template is that drawing all black, its alpha the drawing", () => {
  const ring = trayIcon("idle", "light", 48);
  expect(pixelOf(ring, 2, 13)).toEqual(INK); // the left ring, at its edge
  expect(pixelOf(ring, 11, 11)).toEqual(CLEAR); // inside the ring, above the pupil
  expect(pixelOf(ring, 12, 32)).toEqual(ACCENT);
  for (const state of TRAY_STATES) {
    const template = trayIcon(state, "template", 36);
    const light = trayIcon(state, "light", 36);
    for (let i = 0; i < template.rgba.length; i += 4) {
      expect([...template.rgba.subarray(i, i + 3)]).toEqual([0, 0, 0]);
      expect(template.rgba[i + 3]).toBe(light.rgba[i + 3] ?? -1);
    }
  }
});

test("the panel's is the icon on its rounded ink tile: transparent at the corners, ink at the edges' middle", () => {
  const icon = trayIcon("idle", "panel", 48);
  expect(pixelOf(icon, 0, 0)).toEqual(CLEAR);
  expect(pixelOf(icon, 47, 47)).toEqual(CLEAR);
  expect(pixelOf(icon, 0, 24)).toEqual(INK);
  expect(pixelOf(icon, 24, 47)).toEqual(INK);
  // A sign's room shows the tile, never the panel.
  const needsYou = trayIcon("needs-you", "panel", 64);
  expect(pixelOf(needsYou, 39, 40)).toEqual(INK);
});

test.each(["light", "dark", "template"] as const)(
  "at 16 px on the %s variant, any two states differ in at least 9 pixels that change by more than 96",
  (variant) => {
    for (const a of TRAY_STATES) {
      for (const b of TRAY_STATES.filter((s) => s > a)) {
        const [one, two] = [trayIcon(a, variant, 16).rgba, trayIcon(b, variant, 16).rgba];
        let differ = 0;
        for (let i = 0; i < one.length; i += 4) {
          const change = [0, 1, 2, 3].map((k) => Math.abs((one[i + k] ?? 0) - (two[i + k] ?? 0)));
          if (Math.max(...change) > 96) differ++;
        }
        expect({ a, b, differ: differ >= 9 }).toEqual({ a, b, differ: true });
      }
    }
  },
);

test("the sheet is every state at 16, 24 and 32 px in six rows, each pixel 4 × 4, on a taskbar's grey", () => {
  const sheet = traySheet();
  // A cell per state: 4 + (16 + 4) + (24 + 4) + (32 + 4) wide; a row 32 + 2 × 4 tall; all times four.
  expect([sheet.width, sheet.height]).toEqual([5 * 88 * 4, 6 * 40 * 4]);
  expect(pixelOf(sheet, 0, 0)).toEqual([0x20, 0x20, 0x20, 255]); // the dark taskbar
  expect(pixelOf(sheet, 0, 40 * 4)).toEqual([0xf3, 0xf3, 0xf3, 255]); // the light one
  // The dark row's idle at 32 px, drawn 4 × 4: its first-line pixel is the icon's, over the ground.
  const idle = trayIcon("idle", "dark", 32);
  const [x, y] = [4 * 88 + 4 + 20 + 28 + 8, 4 + 21];
  expect(pixelOf(idle, 8, 21)).toEqual(ACCENT);
  for (const [dx, dy] of [
    [0, 0],
    [3, 3],
  ] as const) {
    expect(pixelOf(sheet, x * 4 + dx, y * 4 + dy)).toEqual(ACCENT);
  }
  expect(TRAY_SHEET).toBe("docs/product/brand/lookover-tray-sheet.png");
});
