// The identifiers frozen forever by ADR 0032: once Lookover has posted with them, old comments, the agents'
// helper and the owner's GitHub settings depend on them.

/** The name of the check on every reviewed commit. */
export const CHECK_NAME = "Lookover";

/** The marker that finds the one summary comment per change, created once and edited every round (ADR 0023). */
export const SUMMARY_MARKER = "<!-- lookover:summary -->";

/** The public result format, in the check's output. Inside `v1`, changes are additive only. */
export const REVIEW_RESULT_SCHEMA = "lookover.review-result/v1";

/**
 * The marker that opens the result's line, the last line of the check's text: `<!-- lookover:result {json} -->`.
 * `publish` writes it, `readResult` finds it, the agents' helper reads it through `readResult`.
 */
export const RESULT_MARKER = "<!-- lookover:result ";

/** The marker that ends each inline comment, `<!-- lookover:finding {json} -->`: the finding's id and fingerprints. */
export const FINDING_MARKER = "<!-- lookover:finding ";

/**
 * The marker that opens a line of each round's review body, `<!-- lookover:review <round> -->`: what names the
 * round is `publish`'s to write. `HostWriter.findReview` looks for it before the review is sent again, so a
 * round's review is posted once (ADR 0044).
 */
export const REVIEW_MARKER = "<!-- lookover:review ";

/**
 * The marker on each reply Lookover writes on its own threads, `<!-- lookover:reply {json} -->` (ADR 0052): what
 * follows it is `publish`'s to write. A bot's reply holding it is Lookover's last word on the thread, which `core`'s
 * `readThreads` reads claims after, and what finds a reply already sent before it is sent again.
 */
export const REPLY_MARKER = "<!-- lookover:reply ";

/** How every hidden marker in the frozen namespace opens: a comment holding one is Lookover's, or quotes it. */
export const MARKER_PREFIX = "<!-- lookover:";

/**
 * The marker `lookover wait` puts under its review request, `<!-- lookover:request {json} -->`: the commit it asks
 * about (ADR 0043) and the reply it asks to have answered (ADR 0052), in the namespace ADR 0032 froze. The one
 * `lookover:` marker a request may carry.
 */
export const REQUEST_MARKER = "<!-- lookover:request ";
