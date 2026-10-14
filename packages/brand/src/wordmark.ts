// The wordmark: "lookover" with the two o's of "look" as eyes, and two lines of code under them (chunks, one in the
// accent colour). Dark on light, an eye is the o outline with a larger counter and a pupil resting at the bottom.
// Light on dark, an eye is solid: the letter o with its counter moved down, so the hole of the letter is the pupil.
// The letter outlines are Figtree ExtraBold (1 unit = 1 font unit, upm 1000), laid out once with opentype.js
// (tracking -18, kerning on, the two o's 10 units tighter) and kept here as path data. Tuned on 2026-10-05, see
// docs/exploration/assets/10/lookover-tuning-1.html.
import { O, r2, SOLID_FLOOR } from "./numbers.ts";

/** The letters, already placed: l, k, o, v, e, r (the two o's of "look" are drawn as eyes). */
const LETTERS = [
  "M207 0L51 0L51-700L207-700L207 0Z",
  "M1565 0L1409 0L1409-700L1565-700L1565-332L1716-500L1899-500L1710-284L1912 0L1731 0L1611-171L1565-120L1565 0Z",
  "M2162 12L2162 12Q2083 12 2022.50-21.50Q1962-55 1928-114Q1894-173 1894-250L1894-250Q1894-327 1928-386Q1962-445 2022-478.50Q2082-512 2160-512L2160-512Q2238-512 2298-478.50Q2358-445 2392-386Q2426-327 2426-250L2426-250Q2426-173 2392-114Q2358-55 2298.50-21.50Q2239 12 2162 12ZM2162-132L2162-132Q2208-132 2237-165Q2266-198 2266-250L2266-250Q2266-302 2236-335Q2206-368 2160-368L2160-368Q2113-368 2083.50-335Q2054-302 2054-250L2054-250Q2054-198 2084-165Q2114-132 2162-132Z",
  "M2771 0L2616 0L2413-500L2574-500L2694-178L2813-500L2974-500L2771 0Z",
  "M3235 12L3235 12Q3157 12 3097-21Q3037-54 3003-113.50Q2969-173 2969-250L2969-250Q2969-328 3003-387Q3037-446 3097.50-479Q3158-512 3237-512L3237-512Q3308-512 3365-478Q3422-444 3455.50-376.50Q3489-309 3489-210L3489-210L3131-210Q3136-167 3166-141.50Q3196-116 3239-116L3239-116Q3276-116 3301-132.50Q3326-149 3337-174L3337-174L3475-127Q3445-55 3379.50-21.50Q3314 12 3235 12ZM3135-314L3135-314L3326-314Q3320-358 3290.50-376Q3261-394 3232-394L3232-394Q3202-394 3171.50-376.50Q3141-359 3135-314Z",
  "M3693 0L3537 0L3537-500L3693-500L3693-407Q3724-454 3771.50-478Q3819-502 3870-502L3870-502L3870-350Q3823-350 3783-340Q3743-330 3718-309Q3693-288 3693-257L3693-257L3693 0Z",
];
/** Each letter's name, in the order of `LETTERS`: the site animates them one by one. */
const LETTER_NAMES = ["l", "k", "o", "v", "e", "r"] as const;
const TOTAL_W = 3884;

/** The o of "over": its outer and inner contours. */
const O_OUTER =
  "M2162 12L2162 12Q2083 12 2022.50-21.50Q1962-55 1928-114Q1894-173 1894-250L1894-250Q1894-327 1928-386Q1962-445 2022-478.50Q2082-512 2160-512L2160-512Q2238-512 2298-478.50Q2358-445 2392-386Q2426-327 2426-250L2426-250Q2426-173 2392-114Q2358-55 2298.50-21.50Q2239 12 2162 12Z";
const O_INNER =
  "M2162-132L2162-132Q2208-132 2237-165Q2266-198 2266-250L2266-250Q2266-302 2236-335Q2206-368 2160-368L2160-368Q2113-368 2083.50-335Q2054-302 2054-250L2054-250Q2054-198 2084-165Q2114-132 2162-132Z";
/** The centres of the two o's of "look". */
const EYE_1 = 531;
const EYE_2 = 1085;

/** White inside a ring eye; 1 is the letter o. */
const COUNTER_GROW = 1.25;
/** A ring eye's pupil radius, as a share of the counter's half-width. */
const PUPIL = 0.6;
/** The share of the pupil's radius that sinks into the ring; 0 touches it. */
const PUPIL_SINK = 0.1;

/** How far below the o's centre each pupil rests: the solid eye's lowered counter, the ring eye's dot. */
const SOLID_REST = O.ry - O.counterRy - SOLID_FLOOR;
const RING_PUPIL = PUPIL * O.counterRx * COUNTER_GROW;
const RING_REST = O.counterRy * COUNTER_GROW - RING_PUPIL * (1 - PUPIL_SINK);

/** Moves and scales a path made of absolute x y pairs, about the o's centre. */
function place(d: string, scale: number, dx: number, dy = 0): string {
  let i = 0;
  return d.replace(/-?\d+(?:\.\d+)?/g, (n) => {
    const v = Number(n);
    const at = i++ % 2 === 0 ? O.cx + (v - O.cx) * scale + dx : O.cy + (v - O.cy) * scale + dy;
    return ` ${r2(at)}`;
  });
}

/**
 * One eye's shapes: the o's outline, the solid eye's hole (the letter's counter, lowered), the ring eye's larger
 * counter, its pupil as a circle's attributes, and the o's box.
 */
function eyeShapes(centre: number) {
  const dx = centre - O.cx;
  return {
    centre,
    outline: place(O_OUTER, 1, dx),
    hole: place(O_INNER, 1, dx, SOLID_REST),
    counter: place(O_INNER, COUNTER_GROW, dx),
    pupil: `cx="${centre}" cy="${r2(O.cy + RING_REST)}" r="${r2(RING_PUPIL)}"`,
    box: { x: centre - O.rx, y: O.cy - O.ry, width: 2 * O.rx, height: 2 * O.ry },
  };
}

function eye(centre: number, solid: boolean): string {
  const { outline, hole, counter, pupil } = eyeShapes(centre);
  return solid
    ? `<path fill-rule="evenodd" d="${outline}${hole}"/>`
    : `<path fill-rule="evenodd" d="${outline}${counter}"/><circle ${pupil}/>`;
}

/** The two lines of code under the two o's: where they start, how wide they are, each chunk's share and colour. */
const linesLeft = EYE_1 - O.rx;
const linesWidth = EYE_2 + O.rx - linesLeft;
const LINE_H = 88;
const LINE_GAP = 62;
const LINE_TOP = 130;
const ROWS: [number, "ink" | "acc"][][] = [
  [
    [0.4, "ink"],
    [0.3, "acc"],
    [0.16, "ink"],
  ], // gaps 7%: ends at 100%
  [
    [0.24, "ink"],
    [0.42, "ink"],
  ], // ends at 73%
];
const GAP = 0.07;

/** The chunks, row by row: each one's box, and whether it is the accent one. */
const CHUNKS = ROWS.flatMap((row, i) => {
  let x = linesLeft;
  const y = LINE_TOP + i * (LINE_H + LINE_GAP);
  return row.map(([w, k]) => {
    const chunk = { x: r2(x), y: r2(y), width: r2(w * linesWidth), height: LINE_H, accent: k === "acc" };
    x += (w + GAP) * linesWidth;
    return chunk;
  });
});

function lines(ink: string, accent: string): string {
  return CHUNKS.map(
    (c) =>
      `<rect x="${c.x}" y="${c.y}" width="${c.width}" height="${c.height}" fill="${c.accent ? accent : ink}"/>`,
  ).join("");
}

const PAD = 60;
const TOP = -722;
const BOTTOM = LINE_TOP + 2 * LINE_H + LINE_GAP;
const VIEW = { x: -PAD, y: TOP - PAD, width: TOTAL_W + 2 * PAD, height: BOTTOM - TOP + 2 * PAD } as const;
const VIEW_BOX = `${VIEW.x} ${VIEW.y} ${VIEW.width} ${VIEW.height}`;

/** The wordmark's eyes and lines as shares, for the sheet's numbers. */
export const WORDMARK = {
  counterGrow: COUNTER_GROW,
  pupil: PUPIL,
  pupilSink: PUPIL_SINK,
  rows: ROWS,
  gap: GAP,
};

/**
 * The wordmark's shapes one by one, for the drawing whose parts the site animates: its box, its letters by name,
 * its two eyes, its chunks, and how far below its centre each eye's pupil rests (font units).
 */
export const WORDMARK_SHAPES = {
  view: VIEW,
  letters: LETTER_NAMES.map((name, i) => ({ name, d: LETTERS[i] ?? "" })),
  eyes: [eyeShapes(EYE_1), eyeShapes(EYE_2)],
  chunks: CHUNKS,
  rest: { solid: SOLID_REST, ring: RING_REST },
};

/** The wordmark as an SVG file's text: ring eyes on light, solid eyes on dark. */
export function wordmark(ink: string, accent: string, solid = false): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEW_BOX}" role="img" aria-label="lookover">
<g fill="${ink}">${LETTERS.map((d) => `<path d="${d}"/>`).join("")}${eye(EYE_1, solid)}${eye(EYE_2, solid)}</g>
${lines(ink, accent)}
</svg>`;
}
