// The copies of the eyes `bun run brand` writes, one list the writer and the check both loop over.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appStylesheet, EYES_MODULE, eyesModule, STYLESHEET } from "./app.ts";
import { ROOT } from "./checkout.ts";
import { icon } from "./icon.ts";
import { COLOURS } from "./numbers.ts";
import { SHEET, sheet } from "./sheet.ts";
import { SITE_FAVICON, SITE_MODULE, SITE_STYLESHEET, siteIcon, siteModule, siteStylesheet } from "./site.ts";
import { wordmark } from "./wordmark.ts";

/**
 * A copy: its path from the checkout's root, and its text as the source renders it. `render` is given the copy's
 * text on disk ("" when it is missing), so a copy that is only partly generated keeps its hand-written rest.
 */
export type Copy = { path: string; render: (current: string) => string };

const { ink, paper, accent } = COLOURS;
const BRAND = "docs/product/brand";

/** Every copy, in the order they are written. A new copy is one more line here. */
export const COPIES: readonly Copy[] = [
  { path: `${BRAND}/lookover-wordmark.svg`, render: () => wordmark(ink, accent) },
  { path: `${BRAND}/lookover-wordmark-on-dark.svg`, render: () => wordmark(paper, accent, true) },
  { path: `${BRAND}/lookover-wordmark-mono.svg`, render: () => wordmark("#000000", "#000000") },
  { path: `${BRAND}/lookover-wordmark-mono-white.svg`, render: () => wordmark("#FFFFFF", "#FFFFFF", true) },
  { path: `${BRAND}/lookover-icon.svg`, render: () => icon(ink, paper, accent, true) },
  { path: `${BRAND}/lookover-icon-paper.svg`, render: () => icon(paper, ink, accent, false) },
  { path: `${BRAND}/lookover-icon-accent.svg`, render: () => icon(accent, paper, ink, true) },
  { path: `${BRAND}/lookover-icon-mono.svg`, render: () => icon(null, "#000000", "#000000", false) },
  { path: `${BRAND}/lookover-mark.svg`, render: () => icon(null, ink, accent, false) },
  { path: `${BRAND}/lookover-mark-on-dark.svg`, render: () => icon(null, paper, accent, true) },
  { path: `${BRAND}/lookover-favicon.svg`, render: () => icon(ink, paper, accent, true) },
  { path: "apps/web/public/favicon.svg", render: () => icon(ink, paper, accent, true) },
  { path: EYES_MODULE, render: eyesModule },
  { path: STYLESHEET, render: appStylesheet },
  { path: SHEET, render: sheet },
  { path: SITE_FAVICON, render: siteIcon },
  { path: SITE_MODULE, render: siteModule },
  { path: SITE_STYLESHEET, render: siteStylesheet },
];

const lf = (text: string) => text.replaceAll("\r\n", "\n");

/** The copies that belong in `root`: those under `docs/` only where `docs/` exists (the public tree has none). */
function copiesIn(root: string, copies: readonly Copy[]): readonly Copy[] {
  const docs = existsSync(join(root, "docs"));
  return copies.filter((c) => docs || !c.path.startsWith("docs/"));
}

const onDisk = (root: string, copy: Copy) => {
  const file = join(root, copy.path);
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
};

/** Writes every copy that belongs in `root` (this checkout unless a test names another) as the source renders it. */
export function writeCopies(root: string = ROOT, copies: readonly Copy[] = COPIES): string[] {
  return copiesIn(root, copies).map((copy) => {
    const file = join(root, copy.path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, copy.render(lf(onDisk(root, copy) ?? "")));
    return copy.path;
  });
}

/**
 * One line per copy in `root` that is not what the source renders (line endings aside, for a checkout with CRLF),
 * naming it and saying to run `bun run brand`; none when every copy is.
 */
export function driftedCopies(root: string = ROOT, copies: readonly Copy[] = COPIES): string[] {
  return copiesIn(root, copies).flatMap((copy) => {
    const text = onDisk(root, copy);
    if (text === undefined) return [`${copy.path} is missing: run \`bun run brand\`.`];
    const current = lf(text);
    return current === lf(copy.render(current))
      ? []
      : [`${copy.path} is not what the source draws: run \`bun run brand\`.`];
  });
}
