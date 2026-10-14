// @lookover/brand: the one source of Lookover's eyes (ADR 0063).
// The decision it hides: the numbers of the eyes and how each of the four things that wear them is drawn. The
// mark's numbers on its 64 grid (`MARK`) are the source; the loader's (`LOADER`) are derived from them, as rounded
// on that grid, by the pair's scale onto the loader's 64 × 44 box, never retyped. The wordmark's Figtree ExtraBold
// outlines are kept here as path data, its shares in `WORDMARK`. `COLOURS` are ink, paper and the accent.
// Interface: `wordmark`, `icon` (the mark alone when its tile is null), `markParts` and `loader` draw as SVG
// text; `loaderCss` renders the loader's box, its rest transforms and its `read` / `read-solid` keyframes as CSS
// text. `eyesModule` and `appStylesheet` render the app's two copies: the module its components draw from, and
// its stylesheet with the loader's region, both as Biome formats them. `sheet` renders the brand sheet's marked
// regions (its wordmarks, the drawings its script shows, the loader's CSS and the numbers) into its hand-written
// rest.
// For the site (ADR 0064, 4): `addressableWordmark`, `addressableMark` (in one of `MARK_STATES`) and
// `addressableLoader` draw the same shapes with every part a script or a stylesheet moves named by a class, both
// themes in one drawing, masks' ids from the `id` given; `GAZE` is where each pupil looks (left, rest, right, up),
// as offsets from its rest. `siteModule` and `siteStylesheet` render the site's two copies: the module that holds
// those drawings for its pages and scripts, and the stylesheet that shows each in its theme and moves the loader
// and the mark's states.
// `COPIES` lists every copy of the eyes elsewhere in the checkout as `{path, render}`; `writeCopies` writes them
// (`bun run brand`, through the `./write` entry) and `driftedCopies` lists those on disk that differ from what
// the source renders, one line each naming the file and saying to run `bun run brand`.
// Invariants: every number a drawing prints is rounded to two decimals; the loader's pupils never rise above the
// centre of their eye; a copy under `docs/` is written and checked only where `docs/` exists (the public tree has
// none); text on disk is compared with CRLF read as LF; an addressable drawing without its stylesheet is the flat
// drawing's picture (its lids are drawn shut).
// It runs Biome (the checkout's `node_modules/.bin/biome`) to format the app's and the site's copies it writes.
// Error modes: `appStylesheet` and `sheet` throw, naming the file (and the sheet's region), when it has lost a
// region's markers;
// `eyesModule`, `appStylesheet`, `siteModule` and `siteStylesheet` throw when Biome is not installed or fails to
// format the text. A missing copy is not an error: `driftedCopies` reports it and `writeCopies` writes it.
// It must never know: the app, the site, their components or their styles beyond the text of the copies it writes
// and the classes its drawings carry.
// It imports no other package; it is not pure (it reads and writes the copies).
export { addressableLoader, addressableMark, addressableWordmark } from "./addressable.ts";
export { appStylesheet, EYES_MODULE, eyesModule, STYLESHEET } from "./app.ts";
export { COPIES, type Copy, driftedCopies, writeCopies } from "./copies.ts";
export { icon, type MarkParts, markParts } from "./icon.ts";
export { LOADER, loader, loaderCss } from "./loader.ts";
export { COLOURS, MARK } from "./numbers.ts";
export { SHEET, sheet } from "./sheet.ts";
export { SITE_FAVICON, SITE_MODULE, SITE_STYLESHEET, siteModule, siteStylesheet } from "./site.ts";
export { GAZE, MARK_STATES, type MarkState } from "./states.ts";
export { WORDMARK, wordmark } from "./wordmark.ts";
