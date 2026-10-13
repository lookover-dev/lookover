// The parts of a stand-alone page (design system "Stand-alone page", ADR 0058), for the service, which serves the
// pages GitHub's redirects reach without the app: the design system's own stylesheet, its tokens of both themes and
// the page's classes (`.standalone`) in it, as text; the eyes, the app's own `favicon.svg`, as text; and where this
// browser keeps its theme. Read as text by Bun, the service's runtime and its compiled binary's bundler, never by
// Vite: the app never imports this file. One source, no copy: a token renamed in `system.css` reaches the pages.
import eyes from "../public/favicon.svg" with { type: "text" };
import system from "./styles/system.css" with { type: "text" };

export { THEME_KEY } from "./theme-key.ts";

/**
 * A file read as text. Vite's types (`vite/client`) say what Vite would make of it, a URL or a side effect, so the
 * text is checked where it is read: a file not read as text stops the service at its start, and the build with it.
 */
function textOf(file: string, contents: unknown): string {
  if (typeof contents !== "string" || contents === "") throw new Error(`${file} wasn't read as text`);
  return contents;
}

/** `system.css`, whole. */
export const STANDALONE_STYLE = textOf("system.css", system);

/** The eyes on their tile: the app's icon, `favicon.svg`, labelled "Lookover". */
export const EYES_SVG = textOf("favicon.svg", eyes);
