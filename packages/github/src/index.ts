// @lookover/github: everything GitHub (ADR 0006, ADR 0022, ADR 0023, ADR 0033, ADR 0039, ADR 0041, ADR 0053).
// The decision it hides: how Lookover talks to GitHub as a GitHub App. Sign-in is a JWT signed with the App's
// private key, exchanged for an installation token that is renewed before it expires; the bot's own posts are
// told by its numeric user id, never by its login; every payload is parsed with Zod where it enters; the
// rate-limit headers of every answer are read; and, built with a list of repositories (`live.json`'s: the sandbox
// and Lookover's own), any other is refused before a request leaves and cut from what an installation lists. Built
// with none, nothing is refused: the product uses what its App is installed on.
// Interface: `createGitHub({ app, repositories?, api?, clock?, fetch?, secret? })` gives the two host ports of
// @lookover/contracts, `intake` and `writer`, plus `rateLimit()` (the last headers read), `view(change, commit?)`
// (contracts' `HostView`, what GitHub shows for a change now: the checks of that commit or of the head, the
// reviews with their inline comments, the conversation's comments with their 👀 and 🚀 counts; the live run reads
// it back) and `identity(repo)` (the repository's owner and the App's bot, for the live snapshot). `api` is GitHub's
// API address (`https://api.github.com` when not given); GitHub's web address is the service's (contracts'
// `githubLinks`), never read here. `secret`, on both, is given every secret the adapter comes to hold (the App's key,
// each JWT it signs, each installation token it buys, a manifest's code and the key it converts to) before any request
// carries it, so the service's log removes it (ADR 0054); the adapter itself logs nothing.
// The App level (ADR 0053): `createHostInstallations({ repositories?, api?, clock?, fetch?, secret? })` is contracts'
// `HostInstallations`, the credentials given with each call: `convertManifest(code)` (no credentials; the App and its
// key, the client and webhook secrets dropped), `app(credentials)` (`GET /app` with the App's JWT), `installation`
// (the App's installations, every page, keeping the one on the App's own account, a person's or an organisation's,
// null when none; any other ignored) and `repositories(credentials, installationId)` (a token reading the metadata
// only, then the installation's repositories, every page, archived ones and any off the list left out).
// `appManifest({ redirectUrl, setupUrl })` builds the manifest the service posts: `lookover-` and six random
// characters, private, no webhook, no events, exactly ADR 0022's permissions. Every listed repository is served, each
// through its own installation token. A pull request is a fork's when its head repository's id isn't its base's, or
// GitHub gives none (a deleted fork; ADR 0048); `fetchSpec` reads the default branch at each call, with the fetch's
// own read-only token, so a rename is followed. Invariants: a check is created `queued` or `in_progress`, patched
// with its status and output while it is not completed, and completed with its conclusion (`success`, `neutral` or
// `skipped`; a `queued` one reads back as `queued`, a status GitHub sets alone, such as `waiting`, as
// `in_progress`); one review carries all its inline comments, a range as GitHub's `start_line` to `line` on one side
// (read back as Lookover names it: `line` its first line, `endLine` its last); the summary comment is found by
// `SUMMARY_MARKER` among the bot's own comments and edited in place; the bot's review is found by its marker
// (`findReview`); a check carries its job's id as GitHub's `external_id`; a check output and every body are counted
// in UTF-8 bytes before they are sent; a reaction is posted once whatever the repeats (GitHub answers a repeat `200`).
// Threads (ADR 0052): `threads` reads the pull request's review comments, every page, grouped by `in_reply_to_id`,
// and keeps the root comments the bot wrote (by numeric id) holding a finding marker, outdated ones included, each
// reply with its author (`bot` from GitHub's account type); `reply` posts on a thread's root comment through REST;
// `minimize` hides a comment by its node id through the one GraphQL client of the App side (`graphql.ts`, the
// installation token, `errors` typed by GitHub's error type: `NOT_FOUND`, `FORBIDDEN` as unauthorized, any other
// as invalid). `findReview` never takes the empty review GitHub files for each reply: it holds no marker. `view`
// gives each inline comment its id, and each comment whether it is hidden, read with GraphQL's `nodes`.
// Polling (ADR 0043): the two listings polled, the open pull requests and the repository's conversation comments
// (newest edited first; a comment whose author's account is gone is left out), are read at stable addresses
// past 100 items, page by page as GitHub's `Link` header gives them (the comments only until a page reaches back
// before the point asked), each page sent with the ETag of its last answer, kept in memory by address for the
// adapter's life. A `304` is no error: it gives that answer back, and a listing every page of which was `304` is
// `unchanged`. ETags are bound to the token, so a renewed token costs one full answer per page. The commits
// between two heads are GitHub's compare: `ahead_by`, diverged when `from` is no ancestor of `to` (GitHub's
// `diverged` or `behind`), and the messages of the first 100 commits. The summary's and a review's lookups read
// every page too, without counting on `unchanged`; `view` still reads its first 100 items and no page after.
// Ordering: every call checks the allow-list before anything else, then signs in for that repository (its
// installation token, fetched on first use and renewed before it expires), then makes its requests. Calls are
// independent: the check's lifecycle and a round's post order (review → summary → check completed) are the
// caller's, as the `HostWriter` port states them; updating or completing a check needs the id its creation
// gave. A listing's `unchanged` is about this adapter's last read of it, whoever asked: a hint, never a reason to
// skip its items.
// Error modes: everything it throws is a `HostError`. `not_found` for a repository or change GitHub has not, for one
// off the list (before any request), for a listed repository the App isn't installed on (the message says to add it to
// the App's installation), for a commit compare doesn't know and for a comment a reaction can't find; `unauthorized`
// for a key, token or permission GitHub rejects (a revoked token among them; the next call signs in again) and for a
// private key that can't sign (before any request), never for a secondary limit; `rate_limited` when GitHub asks to
// wait (a 429, `retry-after`, `x-ratelimit-remaining: 0`, or a 403 whose words name a secondary limit), its `retryAt`
// when GitHub said (`retry-after` from now, else the `x-ratelimit-reset` time); `unplaceable_comment` for an inline
// comment GitHub can't put on the diff ("could not be resolved", "must be part of the diff", "… of the same hunk";
// nothing of the review is posted); `too_large` for a check output over `CHECK_OUTPUT_MAX_BYTES` or a summary, review
// body or comment over `COMMENT_MAX_BYTES` (nothing is sent), and for GitHub's own 422 "Body is too long";
// `missing_marker` for a summary without `SUMMARY_MARKER` (nothing is sent); `unavailable` for a network failure, a
// server error, GitHub's 422 "An internal error occurred, please try again" (seen to save the review all the same) or
// a payload of a shape it doesn't know; `invalid` for any other `422`. Nothing here retries but a token GitHub no longer takes: `publish` does. `view` shows an inline comment as GitHub
// does after a push: `line` (and a range's `endLine`) null once outdated, `originalLine` where it was posted.
// Connection causes (ADR 0053, contracts' `connectionCauseOf`): a JWT GitHub refuses (401) carries `key-refused`, its
// `why` `clock` when GitHub names the `iat` or `exp` claim, `revoked` when it can't decode the token, `app-deleted`
// when it finds no App ("Integration not found", a 404 on any JWT request, or `GET /app` 404s); a key that can't sign is `key-refused` too, and a refusal naming the key
// is always `unauthorized`. An installation token refused as not found is `uninstalled` and its installation id is
// forgotten, so a reinstall is found by the next call with no restart; a token purchase or a token's act refused with
// a 403 is `uninstalled`, `suspended` (the installation's settings fix it: suspended, or a permission no longer
// granted), never the key. A token refused with a 401 is bought again once, and the call made again: an uninstalled
// App then says so. A rate limit never carries a cause. A repository GitHub finds no installation on carries no
// cause: it may only have left the installation, which `repositories` tells. `unavailable` is left to
// `connectionCauseOf` (unreachable). A manifest's code is a credential: no message names it. The testkit's fake
// follows this mapping (`revoked` for another key, `app-deleted` for an unknown App id): this file is its source.
// It must never know: Lookover's rules (`core`), what a review says (`review`, `publish`), the store, the UI, or
// where its key comes from (config code reads the file and passes the PEM text). It never logs a key or a token.
export {
  type Account,
  type AppCredentials,
  createGitHub,
  createHostInstallations,
  type GitHub,
  type GitHubOptions,
  type HostOptions,
  type Identity,
} from "./github.ts";
export { type AppManifest, appManifest, type ManifestLinks } from "./manifest.ts";
