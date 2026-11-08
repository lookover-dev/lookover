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

/**
 * The rows' bottoms from the list's top as laid out, from where they are drawn: `top` the list's top on screen, `scale`
 * how much it is drawn at (a dialog opens at 98 %, `dlg-in`, and the first fit runs in that frame; measured on screen,
 * every row came out 2 % short and the list's edge cut its last row), `scrollTop` how far it is scrolled.
 */
export function laidOutBottoms(
  top: number,
  scale: number,
  scrollTop: number,
  drawn: readonly number[],
): number[] {
  return drawn.map((bottom) => (bottom - top) / scale + scrollTop);
}

/**
 * Sets `list`'s max height so it ends under its last whole row: its rows are its children, its room the max height its
 * CSS gives it. Run after every render, before the paint (a layout effect), since what it shows changes the rows, and
 * on every resize of the window, since its room is a share of the window's height.
 */
export function fitWholeRows(list: HTMLElement): void {
  list.style.maxHeight = "";
  const style = getComputedStyle(list);
  const room = Number.parseFloat(style.maxHeight);
  if (!Number.isFinite(room)) return;
  const box = list.getBoundingClientRect();
  const scale = list.offsetHeight > 0 ? box.height / list.offsetHeight : 1;
  const bottoms = laidOutBottoms(
    box.top,
    scale,
    list.scrollTop,
    [...list.children].map((row) => row.getBoundingClientRect().bottom),
  );
  const height = wholeRowsHeight(bottoms, room, Number.parseFloat(style.paddingBottom) || 0);
  if (height !== null) list.style.maxHeight = `${height}px`;
}
