// The drawings the site animates: the wordmark and the mark with every part a script or a stylesheet moves named
// by a class, from the same shapes as the flat files. Both themes are drawn; the site's stylesheet shows one.
// Each eye is a `.eye` group (`data-eye`) holding `.eye-solid` (the outline, cut by a mask holding its `.hole` and
// its `.lid`) and `.eye-ring` (the ring and its `.pupil`, under a mask holding its own `.lid`). A lid covers its
// eye when scaled to 1 from the drawing's top, and is drawn shut (`scale(1 0)`), so the drawing without a
// stylesheet is the flat file's picture. Mask ids start with the `id` given, so two drawings can share a page.
import { MARK_SHAPES } from "./icon.ts";
import { LOADER_SVG, ringEyes, solidEyes } from "./loader.ts";
import { MARK, r2 } from "./numbers.ts";
import { type Box, lidBox, type MarkState } from "./states.ts";
import { WORDMARK_SHAPES } from "./wordmark.ts";

const at = ({ x, y, width, height }: Box) => `x="${x}" y="${y}" width="${width}" height="${height}"`;

/** A lid over the eye's `box`, shut, closing down from the drawing's top. */
const lid = (view: Box, box: Box, centre: number) =>
  `<rect class="lid" ${at(lidBox(view, box.y + box.height))} fill="#000" transform="scale(1 0)" style="transform-origin:${centre}px ${view.y}px"/>`;

/** A mask over `view`: white, with `inside` cutting it. */
const mask = (id: string, view: Box, inside: string) =>
  `<mask id="${id}" maskUnits="userSpaceOnUse" ${at(view)}><rect ${at(view)} fill="#fff"/>${inside}</mask>`;

type Eye = {
  /** The solid eye's outline and the hole cut out of it, as path data. */
  outline: string;
  hole: string;
  /** The ring eye, drawn evenodd, and its pupil as an element. */
  ring: string;
  pupil: string;
  centre: number;
  box: Box;
};

function eye(id: string, n: number, view: Box, e: Eye): string {
  const solid = `${id}-s${n}`;
  const ring = `${id}-r${n}`;
  return [
    '<g class="eye" data-eye="">',
    `<g class="eye-solid"><defs>${mask(solid, view, `<path class="hole" d="${e.hole}" fill="#000"/>${lid(view, e.box, e.centre)}`)}</defs>`,
    `<path d="${e.outline}" mask="url(#${solid})"/></g>`,
    `<g class="eye-ring"><defs>${mask(ring, view, lid(view, e.box, e.centre))}</defs>`,
    `<g mask="url(#${ring})"><path fill-rule="evenodd" d="${e.ring}"/>${e.pupil}</g></g>`,
    "</g>",
  ].join("");
}

/**
 * The wordmark with its parts addressable, in `currentColor`: `.letter.letter-l` … `.letter-r`, the two `.eye`s,
 * and the five `.chunk`s (`data-i` 0 to 4, the accent one also `.chunk-acc`), each scaling from its left edge.
 */
export function addressableWordmark(id: string): string {
  const { view, letters, eyes, chunks } = WORDMARK_SHAPES;
  const letterPaths = letters.map(({ name, d }) => `<path class="letter letter-${name}" d="${d}"/>`).join("");
  const drawnEyes = eyes.map((e, i) =>
    eye(id, i + 1, view, {
      outline: e.outline,
      hole: e.hole,
      ring: `${e.outline}${e.counter}`,
      pupil: `<circle class="pupil" ${e.pupil}/>`,
      centre: e.centre,
      box: e.box,
    }),
  );
  const code = chunks.map(
    (c, i) =>
      `<rect class="chunk${c.accent ? " chunk-acc" : ""}" data-i="${i}" ${at(c)} style="transform-origin:${c.x}px ${r2(c.y + c.height / 2)}px"/>`,
  );
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" class="wordmark" viewBox="${view.x} ${view.y} ${view.width} ${view.height}" role="img" aria-label="lookover" fill="currentColor">`,
    `<g class="letters">${letterPaths}</g>`,
    ...drawnEyes,
    `<g class="code">${code.join("")}</g>`,
    "</svg>",
  ].join("\n");
}

/**
 * The mark with its parts addressable, in `currentColor`, showing `state` (its `data-state`): the two `.eye`s and
 * the lines `.line.line-1` (the accent one) and `.line.line-2`, each scaling from its left edge.
 */
export function addressableMark(id: string, state: MarkState = "idle"): string {
  return markText(id, state);
}

/** The mark's text with `state` as its `data-state`: a state, or the site module's `{state}` placeholder. */
export function markText(id: string, state: string): string {
  const g = MARK.grid;
  const view = { x: 0, y: 0, width: g, height: g };
  const drawnEyes = MARK_SHAPES.eyes.map((e, i) =>
    eye(id, i + 1, view, {
      outline: e.disc,
      hole: e.hole,
      ring: e.ring,
      pupil: `<path class="pupil" d="${e.pupil}"/>`,
      centre: e.centre,
      box: e.box,
    }),
  );
  const lines = MARK_SHAPES.lines.map(
    (l, i) =>
      `<rect class="line line-${i + 1}" ${at(l)} style="transform-origin:${l.x}px ${r2(l.y + l.height / 2)}px"/>`,
  );
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" class="mark" data-state="${state}" viewBox="0 0 ${g} ${g}" role="img" aria-label="Lookover" fill="currentColor">`,
    ...drawnEyes,
    lines.join(""),
    "</svg>",
  ].join("\n");
}

/**
 * The loader with both its drawings, as the app's `Eyes` draws it: `.e-solid` (the holes `.h`, cut by the mask
 * `id`) and `.e-ring` (the dots `.p`), in a `span.eyes`; the pupils read (`.read`) unless `still`.
 */
export function addressableLoader(id: string, still: boolean): string {
  return `<span class="eyes">${LOADER_SVG}<g class="e-solid">${solidEyes(id, still)}</g><g class="e-ring">${ringEyes(still)}</g></svg></span>`;
}
