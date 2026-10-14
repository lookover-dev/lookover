// The exploration pages the proof shots set beside the site (round 4, motion lab 3) ask Google for their fonts. They
// get the same faces from the site's own font packages instead, so nothing is fetched from another host.
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BrowserContext } from "playwright";
import { sitePath } from "./browser.ts";

/** The site's own font packages, as the exploration pages ask Google for them: the file, and the family they name. */
const FONTS = [
  { css: "@fontsource-variable/figtree/index.css", from: "Figtree Variable", to: "Figtree" },
  {
    css: "@fontsource-variable/hanken-grotesk/index.css",
    from: "Hanken Grotesk Variable",
    to: "Hanken Grotesk",
  },
  { css: "@fontsource/ibm-plex-mono/400.css", from: "IBM Plex Mono", to: "IBM Plex Mono" },
  { css: "@fontsource/ibm-plex-mono/500.css", from: "IBM Plex Mono", to: "IBM Plex Mono" },
].map((font, i) => ({ ...font, file: Bun.resolveSync(font.css, sitePath()), mount: `/fonts-${i}/` }));

/** The folders the font files are served from, by their mount, for `serve`. */
export const FONT_MOUNTS: Readonly<Record<string, string>> = Object.fromEntries(
  FONTS.map(({ file, mount }) => [mount, dirname(file)]),
);

/** The stylesheet an exploration page gets for Google's: the site's font faces, their files served by `FONT_MOUNTS`. */
const fontFaces = (): string =>
  FONTS.map(({ file, from, to, mount }) =>
    readFileSync(file, "utf8").replaceAll(`'${from}'`, `'${to}'`).replaceAll("url(./", `url(${mount}`),
  ).join("\n");

/** Answers a context's requests for Google's font stylesheet with the site's own faces. */
export async function standInFonts(context: BrowserContext): Promise<void> {
  await context.route("https://fonts.googleapis.com/**", (route) =>
    route.fulfill({ contentType: "text/css", body: fontFaces() }),
  );
}
