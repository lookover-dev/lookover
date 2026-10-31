// @lookover/github: everything GitHub (ADR 0006, ADR 0022, ADR 0023, ADR 0033, ADR 0039, ADR 0041, ADR 0053). The
// decision it hides: how Lookover talks to GitHub as a GitHub App. Sign-in is a JWT signed with the App's private key,
// exchanged for an installation token that is renewed before it expires; or a person signed in to the shared App
// (ADR 0066: one token for every repository, from the device flow, renewed before it expires); or a `Session` given.
// Lookover's own posts are told by who posts (the session's poster: the App's bot, or the signed-in person) by numeric
// user id, never by login; every payload is parsed with Zod where it enters; the rate-limit headers of every answer are
// read; and, built with a list of repositories (`live.json`'s: the sandbox and Lookover's own), any other is refused
// before a request leaves and cut from what an installation lists. Built with none, nothing is refused: the product
// uses what its App is installed on.
// Interface: `createGitHub({ app | keeper | session, repositories?, api?, web?, clock?, fetch?, secret? })`, signed in
// as the App (`app`: its id and key, its JWT), as the person whose sign-in `keeper` keeps, or by the `session` given,
// gives the two host ports of @lookover/contracts, `intake` and `writer`, plus `rateLimit()` (the last headers read),
// `view(change, commit?)` (contracts' `HostView`, what GitHub shows for a change now: the checks of that commit or of
// the head, the reviews with their inline comments, the conversation's comments with their 👀 and 🚀 counts; the live run
// reads it back) and `identity(repo)` (the repository's owner and who posts, for the live snapshot). `api` is GitHub's
// API address (`https://api.github.com` when not given); `web` its web address, read only for the sign-in's OAuth
// endpoints (`GITHUB_WEB` when not given; the links the app shows are the service's, contracts' `githubLinks`).
// `secret`, on each, is given every secret the adapter comes to hold (the App's key, each JWT it signs, each
// installation token it buys, a manifest's code and the key it converts to, a device code, each person's token and
// refresh token) before any request carries it, so the service's log removes it (ADR 0054); the adapter itself logs
// nothing.
// Signing in (ADR 0066): `createHostSignIn({ api?, web?, clock?, fetch?, secret? })` is contracts' `HostSignIn` for
// the shared App (`SHARED_APP.clientId`, no secret): `startSignIn` (GitHub's device code: the code, its page, its
// expiry and interval), `pollSignIn` (once: `pending`, `slow-down` with 5 s more on the interval, `expired`,
// `denied`, or the tokens issued, the code spent), `person` (whose a token is, `GET /user`, asked apart so the tokens
// survive it failing) and `refreshSignIn` (both tokens renewed, the refresh token rotated, the person kept). On
// `keeper`, the session reads the sign-in from the keeper on first use, gives the same token for every
// repository and scope, posts as the person (`bot: false`) under the shared App's id, and renews it five minutes
// before it expires, one refresh at a time, reading the keeper again first (another process may have renewed it) and
// writing the renewed sign-in back before its token is used.
// The App level (ADR 0053): `createHostInstallations({ repositories?, api?, clock?, fetch?, secret? })` is contracts'
// `HostInstallations`, the credentials given with each call: `convertManifest(code)` (no credentials; the App and its
// key, the client and webhook secrets dropped), `app(credentials)` (`GET /app` with the App's JWT), `installation` (the
// App's installations, every page, keeping the one on the App's own account, a person's or an organisation's, null when
// none; any other ignored) and `repositories(credentials, installationId)` (a token reading the metadata only, then the
// installation's repositories, every page, archived ones and any off the list left out).
// What the person reaches through the shared App (ADR 0066): `createHostAccounts({ keeper, repositories?, api?, web?,
// clock?, fetch?, secret? })` is contracts' `HostAccounts`, on the person's session over the sign-in `keeper` keeps:
// `person()` (`GET /user`) and `accounts()` (`GET /user/installations`, every page, the shared App's only, then each
// one's `GET /user/installations/{id}/repositories`, every page, archived ones and any off the list left out, owner and
// name as GitHub gives them). A suspended installation is its account's cause (`uninstalled`, suspended), its
// repositories not asked for; an organisation asking for SAML SSO is its account's `sso`; one gone between the reads
// is left out; any other refusal is the call's.
// `appManifest({ redirectUrl, setupUrl })` builds the manifest the service posts: `lookover-` and six random
// characters, private, no webhook, no events, exactly ADR 0022's permissions. Every listed repository is served, each
// through its own installation token. A pull request is a fork's when its head repository's id isn't its base's, or
// GitHub gives none (a deleted fork; ADR 0048); `fetchSpec` reads the default branch at each call, with the fetch's
// own read-only token, so a rename is followed. Invariants: a check is created `queued` or `in_progress`, patched
// with its status and output while it is not completed, and completed with its conclusion (`success`, `neutral` or
// `skipped`; a `queued` one reads back as `queued`, a status GitHub sets alone, such as `waiting`, as
// `in_progress`); one review carries all its inline comments, a range as GitHub's `start_line` to `line` on one side
// (read back as Lookover names it: `line` its first line, `endLine` its last); the summary comment is found by
// `SUMMARY_MARKER` among the poster's own comments (a person's only when `performed_via_github_app` names the
// session's App) and edited in place; the poster's review is found by its marker (`findReview`); a check carries the
// external id `publish` gives it (`<job>@<person>`) as GitHub's `external_id`, found among the session's App's runs
// (`findCheck`); a check output and every body are counted in UTF-8 bytes before they are sent; a reaction is
// posted once whatever the repeats (GitHub answers a repeat `200`).
// Threads (ADR 0052): `threads` reads the pull request's review comments, every page, grouped by `in_reply_to_id`,
// and keeps the root comments the poster wrote (by numeric id) holding a finding marker, outdated ones included, each
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
// server error, GitHub's 422 "An internal error occurred, please try again" (seen to save the review all the same) or a
// payload of a shape it doesn't know; `invalid` for any other `422`. Nothing here retries but a token GitHub no longer
// takes: `publish` does. `view` shows an inline comment as GitHub does after a push: `line` (and a range's `endLine`)
// null once outdated, `originalLine` where it was posted.
// Signing in's errors: GitHub's OAuth endpoints answer their refusals with status 200 and an `error` field; the device
// flow's own are polls' outcomes, a refresh's `bad_refresh_token` (or `incorrect_client_credentials`, a refresh token GitHub doesn't know) is `unauthorized` with the cause `signed-out`, any
// other is `invalid`; a network failure or a 5xx is `unavailable`. On the person's session a token refused (401) while
// not yet expired is renewed once and the call made again; a 401 on a token just renewed, a refresh refused, or no
// sign-in kept is `signed-out`, which stays, with no refresh, until the keeper holds another sign-in; a renewed sign-in
// the keeper fails to write is `unavailable`, held and written again before its first use; an act refused asking for
// SAML SSO (a 403 with GitHub's `X-GitHub-SSO: required; url=…`, or its words "SAML enforcement", REST's or
// GraphQL's) is `unauthorized` with the cause `sso` of the repository's owner, GitHub's page in its `url` when it gave
// one: that account's, never the connection's; an act refused (403, or GraphQL's `FORBIDDEN`) with no cause named is
// the person's own permission, `invalid`, the connection untouched.
// GitHub asking to wait (a 429, a limit's headers) is `rate_limited` on the OAuth endpoints as on the API.
// Connection causes (ADR 0053, contracts' `connectionCauseOf`): a JWT GitHub refuses (401) carries `key-refused`, its
// `why` `clock` when GitHub names the `iat` or `exp` claim, `revoked` when it can't decode the token, `app-deleted`
// when it finds no App ("Integration not found", a 404 on any JWT request, or `GET /app` 404s); a key that can't sign
// is `key-refused` too, and a refusal naming the key is always `unauthorized`. An installation token refused as not
// found is `uninstalled` and its installation id is forgotten, so a reinstall is found by the next call with no
// restart; a token purchase or a token's act refused with a 403 is `uninstalled`, `suspended` (the installation's
// settings fix it: suspended, or a permission no longer granted), never the key. A token refused with a 401 is bought
// again once, and the call made again: an uninstalled App then says so. A rate limit never carries a cause. A
// repository GitHub finds no installation on carries no cause: it may only have left the installation, which
// `repositories` tells. `unavailable` is left to `connectionCauseOf` (unreachable). A manifest's code is a credential:
// no message names it. The testkit's fake follows this mapping (`revoked` for another key, `app-deleted` for an unknown
// App id): this file is its source.
// It must never know: Lookover's rules (`core`), what a review says (`review`, `publish`), the store, the UI, or
// where its key or a sign-in comes from (config code reads the key file and passes the PEM text; the sign-in's keeper
// is the caller's). It never logs a key or a token.
export {
  type Account,
  type AppCredentials,
  createGitHub,
  createHostAccounts,
  createHostInstallations,
  createHostSignIn,
  type GitHub,
  type GitHubOptions,
  type HostOptions,
  type Identity,
} from "./github.ts";
export { type AppManifest, appManifest, type ManifestLinks } from "./manifest.ts";
export type { Poster, Session, TokenScope } from "./session.ts";
