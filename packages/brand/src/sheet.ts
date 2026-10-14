// The brand sheet, `docs/product/brand/sheet.html`: its layout and prose are written by hand; its marked regions are
// rendered here from the source: the loader's CSS, the two grounds' wordmarks, the drawings its script shows (as
// SVG text with the colours left to fill in) and the table of the numbers.
import { icon } from "./icon.ts";
import { LOADER, loader, loaderCss } from "./loader.ts";
import { COLOURS, MARK, O, PAIR, r2, SOLID_FLOOR } from "./numbers.ts";
import { WORDMARK, wordmark } from "./wordmark.ts";

/** The sheet, from the checkout's root. */
export const SHEET = "docs/product/brand/sheet.html";

/** A region: its name in its markers, the comment it is marked with, and its text. */
type Region = { name: string; open: string; close: string; render: () => string };

const begin = ({ name, open, close }: Region) =>
  `${open} Written by \`bun run brand\` from @lookover/brand (ADR 0063): ${name}. Never edit by hand. ${close}`;
const end = ({ name, open, close }: Region) =>
  `${open} End of ${name}, written by \`bun run brand\`. ${close}`;

const lines = (...text: string[]) => `${text.join("\n")}\n`;

/** The three sizes of the wordmark on a ground, the last one its smallest. */
function wordmarks(svg: string): string {
  const cell = (width: number, label: string) =>
    `<div class="cell"><span class="wm" style="width:${width}px">${svg}</span><small>${label}</small></div>`;
  return lines(
    `      <div class="row">${cell(320, "320")}${cell(160, "160")}${cell(100, "100, the smallest")}</div>`,
  );
}

/** What the sheet's script draws, as SVG text with `{tile}`, `{ink}`, `{accent}` and `{mask}` to fill in. */
function drawings(): string {
  const mark = (tile: string | null, solid: boolean) => icon(tile, "{ink}", "{accent}", solid);
  const eyes = (solid: boolean, still: boolean) => loader({ solid, still, mask: "{mask}" });
  const value = {
    colours: COLOURS,
    mark: { solid: mark(null, true), ring: mark(null, false) },
    icon: { solid: mark("{tile}", true), ring: mark("{tile}", false) },
    loader: {
      box: LOADER.box.drawing,
      solid: eyes(true, false),
      solidStill: eyes(true, true),
      ring: eyes(false, false),
      ringStill: eyes(false, true),
    },
  };
  return lines(`var EYES = ${JSON.stringify(value, null, 2)};`);
}

const percent = (share: number) => `${r2(share * 100)}`;

/** The numbers of every drawing, as a table and a note on the loader's box and motion. */
function numbers(): string {
  const { eye, centres, gap, ring, ringRadius, dot, hole, dotRest, holeRest, box } = LOADER;
  const [c1, c2] = centres;
  const span = r2(PAIR);
  const span2 = r2(span * MARK.line2);
  const row = (cells: string[]) => `    <tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
  const ofR = (n: number) => r2(n / eye);
  const holeLeft = r2(eye - holeRest - hole.ry);
  const dotSink = r2(dotRest + dot - (eye - ring));
  const chunks = WORDMARK.rows.map((row) => row.map(([share]) => percent(share)).join(" / ")).join(" and ");
  const [s1, s2, s3] = LOADER.dotStops;
  const [h1, , h3] = LOADER.holeStops;
  const [[a1, a2], [b1, b2], [c1h, c2h]] = LOADER.holds;
  const centre = r2(box.text.align + box.text.height / 2);
  return lines(
    "  <table>",
    "    <tr><th>Drawing</th><th>Eye</th><th>Pupil</th><th>Where the pupil rests</th><th>Eyes apart</th><th>Lines</th></tr>",
    row([
      "Mark, solid",
      `disc r ${MARK.eye}`,
      `a hole, rx ${MARK.solidPupilRx} ry ${MARK.solidPupilRy} (the letter's counter to scale)`,
      `${MARK.solidFloor} of disc left under it (${SOLID_FLOOR}/${O.ry} of the letter)`,
      `${MARK.eyeGap} gap`,
      `${MARK.lineH} thick; ${span} and ${span2} wide; ${MARK.lineGap} under the eyes, ${MARK.lineSep} between`,
    ]),
    row([
      "Mark, ring",
      `ring, outer r ${MARK.eye}, ${MARK.ring} thick`,
      `a dot r ${MARK.ringPupil}`,
      `sunk ${MARK.ringSink} into the ring (${r2(MARK.ringSink / MARK.ringPupil)} of its radius)`,
      `${MARK.eyeGap} gap`,
      "same",
    ]),
    row([
      "Loader, solid",
      `disc r ${eye} on a ${box.drawing.width} × ${box.drawing.height} box, centres ${c1} and ${c2}`,
      `a hole, ${hole.rx} × ${hole.ry} (${ofR(hole.rx)} × ${ofR(hole.ry)} R, as the mark)`,
      `${holeLeft} left under it at rest (${ofR(holeLeft)} R); reads on a circle of radius ${holeRest}`,
      `${gap} gap (${ofR(gap)} R)`,
      "none",
    ]),
    row([
      "Loader, ring",
      `ring, outer r ${eye}, ${ring} thick (${ofR(ring)} R), drawn as a stroke on r ${ringRadius}`,
      `a dot r ${dot} (${ofR(dot)} R)`,
      `sunk ${dotSink} into the ring (${r2(dotSink / dot)} of its radius); reads on a circle of radius ${dotRest}`,
      `${gap} gap`,
      "none",
    ]),
    row([
      "Wordmark, ring",
      "the letter o",
      `a dot, ${WORDMARK.pupil} of the counter's half-width, the counter ${percent(WORDMARK.counterGrow - 1)} % larger than the letter's`,
      `sunk ${WORDMARK.pupilSink} of its radius`,
      "the letters' own spacing",
      `chunks ${chunks} %, ${percent(WORDMARK.gap)} % gaps`,
    ]),
    row([
      "Wordmark, solid",
      "the letter o",
      "a hole, the letter's own counter",
      `${SOLID_FLOOR} units left under it (${O.ry - O.counterRy} in the letter)`,
      "the letters' own spacing",
      "same",
    ]),
    "  </table>",
    `  <p class="note">The loader's box: next to words ${box.text.width} × ${box.text.height} em, lowered ${-box.text.align} em so the eyes' centre sits ${centre} em above the baseline; large, ${box.large.width} × ${box.large.height} px. Reading, the dot stops at (${s1[0]}, ${s1[1]}), (${s2[0]}, ${s2[1]}) and (${s3[0]}, ${s3[1]}) from its eye's centre, the hole at (${h1[0]}, ${h1[1]}) to (${h3[0]}, ${h3[1]}); each stop is held ${a1}–${a2} %, ${b1}–${b2} % and ${c1h}–${c2h} % of a ${LOADER.seconds} s loop, back at the first from ${LOADER.back} %.</p>`,
  );
}

const { ink, paper, accent } = COLOURS;

/** The regions, in the order they stand in the sheet. */
const REGIONS: readonly Region[] = [
  { name: "the loader's CSS", open: "/*", close: "*/", render: loaderCss },
  {
    name: "the wordmark on paper",
    open: "<!--",
    close: "-->",
    render: () => wordmarks(wordmark(ink, accent)),
  },
  {
    name: "the wordmark on ink",
    open: "<!--",
    close: "-->",
    render: () => wordmarks(wordmark(paper, accent, true)),
  },
  { name: "the numbers", open: "<!--", close: "-->", render: numbers },
  { name: "the drawings", open: "/*", close: "*/", render: drawings },
];

/** `text` with `region` rendered between its two markers; the end marker's line keeps its indentation. */
function splice(text: string, region: Region): string {
  const opening = begin(region);
  const from = text.indexOf(opening);
  const to = text.indexOf(end(region), from);
  if (from < 0 || to < 0) {
    throw new Error(
      `${SHEET} has lost the region of ${region.name} \`bun run brand\` writes: put back its two marker comments, then run \`bun run brand\`.`,
    );
  }
  const endLine = text.lastIndexOf("\n", to) + 1;
  return `${text.slice(0, from + opening.length)}\n${region.render()}${text.slice(endLine)}`;
}

/**
 * The sheet: `current` with each region rendered from the source and the rest kept as written. An empty `current`
 * (no sheet yet) is the regions alone.
 */
export function sheet(current: string): string {
  const text = current === "" ? lines(...REGIONS.flatMap((r) => [begin(r), end(r)])) : current;
  return REGIONS.reduce(splice, text);
}
