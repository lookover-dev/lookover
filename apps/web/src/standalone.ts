// The parts of a stand-alone page (design system "Stand-alone page", ADR 0058), for the service, which serves the
// pages GitHub's redirects reach without the app: the design system's own stylesheet as text, the tokens of both
// themes (`tokens.css`) joined in front of `system.css` and its page's classes (`.standalone`); the eyes, the app's
// own `favicon.svg`, as text; and where this browser keeps its theme. Read as text by Bun, the service's runtime and
// its compiled binary's bundler, never by Vite: the app never imports this file. One source, no copy: a token
// renamed in `tokens.css` or a class in `system.css` reaches the pages.
import eyes from "../public/favicon.svg" with { type: "text" };
import system from "./styles/system.css" with { type: "text" };
import tokens from "./styles/tokens.css" with { type: "text" };

export { THEME_KEY } from "./theme-key.ts";

/**
 * How `system.css` reads its tokens in the app: an import Vite inlines. A page's own `<style>` has no file beside it
 * to import, so the tokens are joined in front of it instead and this line dropped.
 */
const TOKENS_IMPORT = '@import "./tokens.css";';

/**
 * A file read as text. Vite's types (`vite/client`) say what Vite would make of it, a URL or a side effect, so the
 * text is checked where it is read: a file not read as text stops the service at its start, and the build with it.
 */
function textOf(file: string, contents: unknown): string {
  if (typeof contents !== "string" || contents === "") throw new Error(`${file} wasn't read as text`);
  return contents;
}

/** `system.css` but for its import of the tokens, which a stand-alone page would ask the service for and not get. */
function withoutTokensImport(css: string): string {
  if (!css.includes(TOKENS_IMPORT))
    throw new Error(`system.css doesn't read its tokens with ${TOKENS_IMPORT}`);
  return css.replace(TOKENS_IMPORT, "");
}

/** `tokens.css`, then `system.css` whole but for its import of them. */
export const STANDALONE_STYLE = `${textOf("tokens.css", tokens)}\n${withoutTokensImport(textOf("system.css", system))}`;

/** The eyes on their tile: the app's icon, `favicon.svg`, labelled "Lookover". */
export const EYES_SVG = textOf("favicon.svg", eyes);
