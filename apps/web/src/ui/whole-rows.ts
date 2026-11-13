// A scrolling list shows whole rows only (design-system.md "Command palette", round 6): its height ends under the last
// row that fits in its room, never through one.

/**
 * The height a list takes to end under its last whole row: `bottoms` are its rows' bottom edges from the list's top
 * (its top padding included), `room` the most it may be, `pad` its bottom padding. Null when every row fits, so the
 * list keeps its own height; the room itself when not even the first row fits.
 */
export function wholeRowsHeight(bottoms: readonly number[], room: number, pad: number): number | null {
  const last = bottoms.at(-1);
  if (last === undefined || last + pad <= room) return null;
  const fits = bottoms.filter((b) => b + pad <= room).at(-1);
  return fits === undefined ? room : fits + pad;
}

/** The steps a CSS pixel is laid out in. */
const STEPS = 64;

/**
 * The rows' bottoms from the list's top as laid out, from where they are drawn: `top` the list's top on screen, `scale`
 * how much it is drawn at (a dialog opens at 98 %, `dlg-in`, and the first fit runs in that frame; measured on screen,
 * every row came out 2 % short and the list's edge cut its last row), `scrollTop` how far it is scrolled. Each comes
 * back in the layout's own steps of 1/64 px: drawn in single precision, it comes back a hair off, a different hair at
 * each scale, and the height set from it moved the dialog by that hair between two openings (ADR 0093).
 */
export function laidOutBottoms(
  top: number,
  scale: number,
  scrollTop: number,
  drawn: readonly number[],
): number[] {
  return drawn.map((bottom) => Math.round(((bottom - top) / scale + scrollTop) * STEPS) / STEPS);
}

/**
 * Sets `list`'s max height so it ends under its last whole row: its rows are its children, its room the max height its
 * CSS gives it. Run after every render, before the paint (a layout effect), since what it shows changes the rows, and
 * whenever `refitWhenRowsMove` says the rows or the room may have moved.
 */
export function fitWholeRows(list: HTMLElement): void {
  list.style.maxHeight = "";
  const style = getComputedStyle(list);
  const room = Number.parseFloat(style.maxHeight);
  if (!Number.isFinite(room)) return;
  const box = list.getBoundingClientRect();
  // the laid-out height as computed, not `offsetHeight`: that one is rounded to a whole pixel, and a list 469.16 px
  // high came out drawn at 1.0003, every bottom a sixth of a pixel short
  const laidOut = Number.parseFloat(style.height);
  const scale = laidOut > 0 ? box.height / laidOut : 1;
  const bottoms = laidOutBottoms(
    box.top,
    scale,
    list.scrollTop,
    [...list.children].map((row) => row.getBoundingClientRect().bottom),
  );
  const height = wholeRowsHeight(bottoms, room, Number.parseFloat(style.paddingBottom) || 0);
  if (height !== null) list.style.maxHeight = `${height}px`;
}

/**
 * Runs `refit` whenever a list's rows or room may have moved without a render: the window resized (its room is a share
 * of the window's height), or a font came in (a font the page hadn't used yet loads as the list first shows, and rows
 * measured in the fallback font are another height; a document with no font set, as the tests' DOM, watches the window
 * alone). Gives the function that stops watching.
 */
export function refitWhenRowsMove(
  refit: () => void,
  on: { window: EventTarget; fonts: EventTarget | undefined } = {
    window,
    fonts: document.fonts,
  },
): () => void {
  on.window.addEventListener("resize", refit);
  on.fonts?.addEventListener("loadingdone", refit);
  return () => {
    on.window.removeEventListener("resize", refit);
    on.fonts?.removeEventListener("loadingdone", refit);
  };
}
