// The wordmark every post on GitHub opens with (ADR 0074): the owner's prototype's markup, byte for byte, a
// `<picture>` of the two files in `WORDMARK_URLS` linked to the site, `absmiddle` setting its letters on the text's
// line. `publish` writes it (26 px in the status block's heading, 18 px elsewhere), after the output filter, which
// would neutralise its tags; `agent-cli` takes it off a post with `withoutWordmark` so the agent reads words.
import { WORDMARK_URLS } from "./frozen.ts";

const SITE = "https://lookover.dev";

/** The markup, `height` written as given: a number when posted, a pattern when looked for. */
const markup = (height: string): string =>
  `<a href="${SITE}"><picture><source media="(prefers-color-scheme: dark)" srcset="${WORDMARK_URLS.dark}"><img src="${WORDMARK_URLS.light}" height="${height}" alt="Lookover" align="absmiddle"></picture></a>`;

/** The wordmark, `px` high. */
export const wordmark = (px: number): string => markup(String(px));

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const HEIGHT = "\u{0}";
/** A post's opening: the wordmark at any height, then " · ". */
const OPENING = new RegExp(`^${escaped(markup(HEIGHT)).replace(HEIGHT, "\\d+")} · `);

/**
 * A post without its wordmark opening ("<wordmark> · Withdrawn\n\nwhy" reads "Withdrawn\n\nwhy"): what the coding
 * agent is shown of Lookover's words. A post that doesn't open with it is given back as it is.
 */
export const withoutWordmark = (body: string): string => body.replace(OPENING, "");
