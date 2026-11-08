// The copies of the eyes `bun run brand` writes, one list the writer and the check both loop over.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appStylesheet, EYES_MODULE, eyesModule, STYLESHEET } from "./app.ts";
import { APP_ICON, appIcon } from "./app-icon.ts";
import { ROOT } from "./checkout.ts";
import { biome, type Formatter } from "./format.ts";
import { icon } from "./icon.ts";
import { COLOURS } from "./numbers.ts";
import { decodePng, encodePng, type Image } from "./png.ts";
import { SHEET, sheet } from "./sheet.ts";
import { SITE_FAVICON, SITE_MODULE, SITE_STYLESHEET, siteIcon, siteModule, siteStylesheet } from "./site.ts";
import { wordmark } from "./wordmark.ts";

/**
 * A copy: its path from the checkout's root, and either its text as the source renders it or its picture. `render`
 * is given the copy's text on disk ("" when it is missing), so a copy that is only partly generated keeps its
 * hand-written rest, and the formatter the copies Biome formats go through. A picture is written as a PNG and
 * compared by its pixels.
 */
export type Copy =
  | { path: string; render: (current: string, format: Formatter) => string | Promise<string> }
  | { path: string; picture: () => Image };

/** Where the copies are written or checked, and how those Biome formats are formatted. */
export type CopiesOptions = {
  /** Biome's unless given: a test gives one that runs in its own process. */
  format?: Formatter;
  copies?: readonly Copy[];
};

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
  // The GitHub App's logo, full bleed: uploaded by hand on the App's page, its badge colour the ink (brand.md).
  { path: APP_ICON, picture: appIcon },
  { path: "apps/web/public/favicon.svg", render: () => icon(ink, paper, accent, true) },
  { path: EYES_MODULE, render: (_, format) => eyesModule(format) },
  { path: STYLESHEET, render: appStylesheet },
  // The wordmark opening Lookover's posts on the app's simulated GitHub page (brand.md), one per theme.
  { path: "apps/web/public/brand/lookover-wordmark.svg", render: () => wordmark(ink, accent) },
  {
    path: "apps/web/public/brand/lookover-wordmark-on-dark.svg",
    render: () => wordmark(paper, accent, true),
  },
  { path: SHEET, render: sheet },
  { path: SITE_FAVICON, render: siteIcon },
  // Served at contracts' `WORDMARK_URLS`, which every post Lookover writes on GitHub draws (ADR 0074): they never
  // move, and the site's tests and `site:check` fail without them.
  { path: "apps/site/public/brand/lookover-wordmark.svg", render: () => wordmark(ink, accent) },
  {
    path: "apps/site/public/brand/lookover-wordmark-on-dark.svg",
    render: () => wordmark(paper, accent, true),
  },
  { path: SITE_MODULE, render: (_, format) => siteModule(format) },
  { path: SITE_STYLESHEET, render: (_, format) => siteStylesheet(format) },
];

const lf = (text: string) => text.replaceAll("\r\n", "\n");

/** The copies that belong in `root`: those under `docs/` only where `docs/` exists (the public tree has none). */
function copiesIn(root: string, copies: readonly Copy[]): readonly Copy[] {
  const docs = existsSync(join(root, "docs"));
  return copies.filter((c) => docs || !c.path.startsWith("docs/"));
}

const onDisk = (root: string, copy: Copy) => {
  const file = join(root, copy.path);
  return existsSync(file) ? readFileSync(file) : undefined;
};

/** What the source renders for `copy`, given its bytes on disk: its text, or its picture as a PNG. */
async function rendered(
  copy: Copy,
  current: Buffer | undefined,
  format: Formatter,
): Promise<string | Uint8Array> {
  return "picture" in copy
    ? encodePng(copy.picture())
    : copy.render(lf(current?.toString("utf8") ?? ""), format);
}

/** Whether the bytes on disk are what the source renders: the same text, or the same pixels. */
async function same(copy: Copy, current: Buffer, format: Formatter): Promise<boolean> {
  if ("picture" in copy) {
    const want = copy.picture();
    const got = decodePng(current);
    return (
      got !== undefined &&
      got.width === want.width &&
      got.height === want.height &&
      Buffer.from(got.rgba).equals(Buffer.from(want.rgba))
    );
  }
  const text = lf(current.toString("utf8"));
  return text === lf(await copy.render(text, format));
}

/**
 * Writes every copy that belongs in `root` (this checkout unless a test names another) as the source renders it,
 * each rendered from what is on disk before any is written, then names them in order.
 */
export async function writeCopies(
  root: string = ROOT,
  { format = biome, copies = COPIES }: CopiesOptions = {},
): Promise<string[]> {
  const written = await Promise.all(
    copiesIn(root, copies).map(async (copy) => ({
      path: copy.path,
      content: await rendered(copy, onDisk(root, copy), format),
    })),
  );
  return written.map(({ path, content }) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    return path;
  });
}

/**
 * One line per copy in `root` that is not what the source renders (line endings aside, for a checkout with CRLF;
 * a picture by its pixels), naming it and saying to run `bun run brand`; none when every copy is.
 */
export async function driftedCopies(
  root: string = ROOT,
  { format = biome, copies = COPIES }: CopiesOptions = {},
): Promise<string[]> {
  const lines = await Promise.all(
    copiesIn(root, copies).map(async (copy) => {
      const current = onDisk(root, copy);
      if (current === undefined) return [`${copy.path} is missing: run \`bun run brand\`.`];
      return (await same(copy, current, format))
        ? []
        : [`${copy.path} is not what the source draws: run \`bun run brand\`.`];
    }),
  );
  return lines.flat();
}
