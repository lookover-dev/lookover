// CSS text as Biome formats it, for the stylesheets the package writes: a rule, a length, and a reading loop's
// keyframes (three stops held, then back to the first).

export type Point = readonly [number, number];
export type Three<T> = readonly [T, T, T];

/** A length in px, `0` bare. */
export const px = (n: number) => (n === 0 ? "0" : `${n}px`);

/** A CSS rule as Biome formats it: one selector a line, then its declarations, indented by `indent`. */
export function rule(selectors: string[], body: string[], indent = ""): string[] {
  const last = selectors.length - 1;
  return [
    ...selectors.map((s, i) => `${indent}${s}${i === last ? " {" : ","}`),
    ...body.map((line) => `${indent}  ${line}`),
    `${indent}}`,
  ];
}

/** Keyframes holding each stop over its span of the loop, then the first one again from `back` to the end. */
export function readingKeyframes(
  name: string,
  [left, middle, right]: Three<Point>,
  [h1, h2, h3]: Three<Point>,
  back: number,
): string[] {
  const at = ([x, y]: Point) => [`transform: translate(${px(x)}, ${px(y)});`];
  const held: [Point, Point][] = [
    [h1, left],
    [h2, middle],
    [h3, right],
    [[back, 100], left],
  ];
  const frames = held.flatMap(([[from, to], stop]) => rule([`${from}%`, `${to}%`], at(stop), "  "));
  return [`@keyframes ${name} {`, ...frames, "}"];
}
