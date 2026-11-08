// The account head band's `--band` (design-system.md "Repositories' group heads"): what is muted on a head (setup's
// chevron, any small muted line a list grouped by account puts there) is `--muted` on it, so in both themes it reads
// at 4.5:1 at least (WCAG AA for small text). Read from tokens.css itself, so a lighter `--muted` or a darker band fails here.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

/** The `--name: #rrggbb` colours of the first block opened by `selector`. */
function colours(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} in tokens.css`);
  const block = css.slice(start, css.indexOf("}", start));
  return new Map(
    [...block.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m): [string, string] => [
      m[1] ?? "",
      m[2] ?? "",
    ]),
  );
}

/** WCAG 2's relative luminance of `#rrggbb`. */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG 2's contrast ratio of two colours. */
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

test("a contrast ratio is WCAG's: black on white is 21, a colour on itself 1", () => {
  expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
  expect(contrast("#6b6660", "#6b6660")).toBe(1);
});

for (const [theme, selector] of [
  ["dark", ":root"],
  ["light", ':root[data-theme="light"]'],
] as const) {
  test(`${theme}: --muted on --band reads at 4.5:1 at least`, () => {
    const tokens = colours(selector);
    const muted = tokens.get("--muted");
    const band = tokens.get("--band");
    if (!muted || !band) throw new Error(`no --muted or --band in ${selector}`);
    expect(contrast(muted, band)).toBeGreaterThanOrEqual(4.5);
  });
}

// The contrast table under "Colour" in design-system.md says the ratios the tokens give: a token moved without its
// table, or a ratio written by hand, fails here (row 47, round 4). The public tree carries no docs/
// (scripts/public-tree.ts), so there the comparison is skipped and the tokens' own tests still run.
const docUrl = new URL("../../../../docs/product/design-system.md", import.meta.url);
const doc = existsSync(docUrl) ? readFileSync(docUrl, "utf8") : null;

/** The tokens of a theme's block. */
const theme = (name: string) => colours(name === "dark" ? ":root" : ':root[data-theme="light"]');

test.skipIf(doc === null)("design-system.md's contrast table is the tokens' own ratios", () => {
  if (doc === null) return;
  const head = doc.match(/^\| on \|(.*)\|$/m)?.[1];
  if (!head) throw new Error("no contrast table in design-system.md");
  const surfaces = head.split("|").map((c) => c.trim().replaceAll("`", ""));
  const rows = [...doc.matchAll(/^\| (dark|light) `(--[\w-]+)` `(#[0-9A-Fa-f]{6})` \|(.*)\|$/gm)];
  expect(rows.length).toBeGreaterThanOrEqual(3);
  for (const [, name = "", token = "", hex = "", cells = ""] of rows) {
    const tokens = theme(name);
    const fg = tokens.get(token) ?? "";
    expect(`${name} ${token} ${fg.toUpperCase()}`).toBe(`${name} ${token} ${hex.toUpperCase()}`);
    const said = cells.split("|").map((c) => c.trim());
    surfaces.forEach((surface, i) => {
      const bg = tokens.get(surface);
      if (!bg) throw new Error(`no ${surface} in ${name}`);
      expect(`${name} ${token} on ${surface}: ${said[i]}`).toBe(
        `${name} ${token} on ${surface}: ${contrast(fg, bg).toFixed(2)}`,
      );
    });
  }
});

test("dark: metadata reads at 8:1 on a card, still a step under --ink-2", () => {
  const dark = theme("dark");
  const [muted = "", ink2 = "", surface = ""] = ["--muted", "--ink-2", "--surface"].map(
    (t) => dark.get(t) ?? "",
  );
  expect(contrast(muted, surface)).toBeGreaterThanOrEqual(8);
  expect(contrast(ink2, surface)).toBeGreaterThan(contrast(muted, surface) + 1);
});

// Every state chip's word on its own fill (design-system.md "Chip", round 6): the colours each tone names in
// system.css, its word darkened in light as `:root[data-theme="light"] .chip` says, and the table under "Chip" giving
// their ratios. A tone without its row, a row naming other tokens than its rule, or a ratio by hand fails here.
const system = readFileSync(new URL("./system.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** `#rrggbb` mixed with `other` as CSS's `color-mix(in srgb, a p, other)`, `p` from 0 to 1. */
function mix(a: string, other: string, p: number): string {
  const channel = (i: number) =>
    Math.round(
      Number.parseInt(a.slice(i, i + 2), 16) * p + Number.parseInt(other.slice(i, i + 2), 16) * (1 - p),
    );
  return `#${[1, 3, 5].map((i) => channel(i).toString(16).padStart(2, "0")).join("")}`;
}

/** Every chip tone's colours; a rule that names two tones (`.c-warn, .c-wait`) gives each of them its colours. */
const chipTones = [...system.matchAll(/^((?:\.c-[a-z]+,\s*)*\.c-[a-z]+) \{([^}]*)\}/gm)].flatMap((m) => {
  const named = (prop: string) => m[2]?.match(new RegExp(`${prop}:\\s*var\\((--[\\w-]+)\\);`))?.[1] ?? "";
  const colours = { text: named("--tone-text"), fill: named("--tone-soft") };
  return (m[1] ?? "")
    .split(",")
    .map((selector) => ({ tone: selector.trim().slice(".c-".length), ...colours }));
});
const lightDarken = Number(
  system.match(
    /:root\[data-theme="light"\] \.chip \{[^}]*color-mix\(in srgb, var\(--tone-text\) (\d+)%, var\(--ink\)\)/,
  )?.[1],
);

/** A chip's word on its fill in a theme, the light word darkened as system.css says. */
function chipRatio(name: string, text: string, fill: string): number {
  const tokens = theme(name);
  const raw = tokens.get(text) ?? "";
  const word = name === "light" ? mix(raw, tokens.get("--ink") ?? "", lightDarken / 100) : raw;
  return contrast(word, tokens.get(fill) ?? "");
}

test("every chip tone names its word and its fill, and light darkens every chip's word alike", () => {
  expect(chipTones.map((t) => t.tone)).toEqual(["need", "run", "ok", "warn", "wait", "mute"]);
  for (const t of chipTones) expect(`${t.tone} ${t.text !== "" && t.fill !== ""}`).toBe(`${t.tone} true`);
  expect(lightDarken).toBe(70);
});

test("every chip's word reads at 6.5:1 at least on its fill, light as dark", () => {
  for (const name of ["dark", "light"])
    for (const t of chipTones)
      expect(`${name} ${t.tone} ${chipRatio(name, t.text, t.fill) >= 6.5}`).toBe(`${name} ${t.tone} true`);
});

test.skipIf(doc === null)("design-system.md's chip table is the chips' own ratios", () => {
  if (doc === null) return;
  const rows = [
    ...doc.matchAll(/^\| `\.c-([a-z]+)` [^|]*\| `(--[\w-]+)` on `(--[\w-]+)` \| ([\d.]+) \| ([\d.]+) \|$/gm),
  ];
  expect(rows.map((r) => r[1])).toEqual(chipTones.map((t) => t.tone));
  for (const [, tone = "", text = "", fill = "", dark = "", light = ""] of rows) {
    const t = chipTones.find((x) => x.tone === tone);
    expect(`${tone}: ${text} on ${fill}`).toBe(`${tone}: ${t?.text} on ${t?.fill}`);
    expect(`${tone}: ${dark} ${light}`).toBe(
      `${tone}: ${chipRatio("dark", text, fill).toFixed(2)} ${chipRatio("light", text, fill).toFixed(2)}`,
    );
  }
});
