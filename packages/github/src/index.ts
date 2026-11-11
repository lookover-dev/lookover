// @lookover/github: everything GitHub (ADR 0006, ADR 0022, ADR 0023, ADR 0033, ADR 0039, ADR 0041, ADR 0053, ADR 0066,
// ADR 0073). The decision it hides: how Lookover talks to GitHub as the person signed in to the shared App (one token
// for every repository, from the device flow, renewed before it expires), or on a `Session` given. There is no App
// session: no key, no JWT, no installation token, no manifest. Lookover's own posts are told by who posts (the
// session's poster, the signed-in person) by numeric user id, never by login; every payload is parsed with Zod where
// it enters; the rate-limit headers of every answer are read; and, built with a list of repositories (`live.json`'s:
// the sandboxes and Lookover's own), any other is refused before a request leaves and cut from what an installation
// lists. Built with none, nothing is refused: the product uses what the shared App is installed on.
// Interface: `createGitHub({ keeper | session, repositories?, api?, web?, clock?, fetch?, sleep?, deadline?,
// secret? })`, signed in as the person whose sign-in `keeper` keeps, or by the `session` given, gives the two host
// ports of contracts, `intake` and `writer`, plus `rateLimit()` (the last headers read), `view(change, commit?)`
// (contracts' `HostView`, what GitHub shows for a change now: the checks of that commit or of the head, the reviews
// with their inline comments, the conversation's comments with their 👀 and 🚀 counts; the live run reads it back) and
// `identity(repo)` (the repository's owner and who posts, for the live snapshot). `api` is GitHub's API address
// (`https://api.github.com` when not given); `web` its web address, read only for the sign-in's OAuth endpoints
// (`GITHUB_WEB` when not given; the links the app shows are the service's, contracts' `githubLinks`).
// `secret`, on each, is given every secret the adapter comes to hold (a device code, each person's token and refresh
// token) before any request carries it, so the service's log removes it (ADR 0054); the adapter itself logs nothing.
// `sleep` and `deadline`, on each, are the waits of a request tried again (ADR 0080), real timers when not given.
// Signing in (ADR 0066): `createHostSignIn({ api?, web?, clock?, fetch?, sleep?, deadline?, secret? })` is contracts'
// `HostSignIn` for the shared App (`SHARED_APP.clientId`, no secret): `startSignIn` (GitHub's device code: the code,
// its page, its expiry and interval), `pollSignIn` (once: `pending`, `slow-down` with the interval GitHub gives,
// `expired`, `denied`, or the tokens issued, the code spent), `person` (whose a token is, `GET /user`, asked apart so
// the tokens survive it failing) and `refreshSignIn` (both tokens renewed, the refresh token rotated, the person
// kept). On `keeper`, the session reads the sign-in from the keeper on first use, gives the same token for every
// repository, posts as the person under the shared App's id, and renews it five minutes before it expires, one refresh
// at a time, reading the keeper again first (another process may have renewed it) and writing the renewed sign-in back
// before its token is used.
// What the person reaches through the shared App (ADR 0066): `createHostAccounts({ keeper, repositories?, api?, web?,
// clock?, fetch?, sleep?, deadline?, secret? })` is contracts' `HostAccounts`, on the person's session over the
// sign-in `keeper` keeps: `person()` (`GET /user`) and `accounts()` (`GET /user/installations`, every page, the shared
// App's only, then each one's `GET /user/installations/{id}/repositories`, every page, archived ones and any off the
// list left out, owner and name as GitHub gives them). A suspended installation is its account's cause (`uninstalled`,
// suspended), its repositories not asked for; an organisation asking for SAML SSO is its account's `sso`; one gone
// between the reads is left out; any other refusal is the call's.
// A pull request is a fork's when its head repository's id isn't its base's, or GitHub gives none (a deleted fork;
// ADR 0048); `fetchSpec` reads the default branch at each call, with the person's token, so a rename is followed.
// Invariants: a check is created `queued` or `in_progress`, patched with its status and output while it is not
// completed, and completed with its conclusion (`success`, `neutral` or `skipped`; a `queued` one reads back as
// `queued`, a status GitHub sets alone, such as `waiting`, as `in_progress`); one review carries all its inline
// comments, a range as GitHub's `start_line` to `line` on one side (read back as Lookover names it: `line` its first
// line, `endLine` its last); the status block (ADR 0074) is
// written into the pull request's description by `contracts`' `spliceStatus`, on a read made right before the write
// with no ETag, read again a second apart for up to 30 s (`sleep`, on `clock`) while it doesn't show the block this
// adapter last sent (`showsStatus`, line endings aside), the author's text kept byte for byte, a block past
// `statusRoom` refused `too_large` before a request, a 403 on the write `invalid` (the person may not edit it), never
// a sign-out; `view` gives the description, "" for GitHub's null; the poster's review is found by its marker
// (`findReview`); a check carries the external id `publish` gives it (`<job>#<number>@<person>`) as GitHub's
// `external_id`, found among the session's App's runs (`findCheck`); a check output and every body are counted in
// UTF-8 bytes before they are sent; a reaction is posted once whatever the repeats (GitHub answers a repeat `200`).
// Threads (ADR 0052): `threads` reads the pull request's review comments, every page, grouped by `in_reply_to_id`,
// and keeps the root comments the poster wrote (by numeric id) holding a finding marker, outdated ones included, each
// reply with its author (`bot` from GitHub's account type); `reply` posts on a thread's root comment through REST;
// `minimize` hides a comment by its node id through the one GraphQL client (`graphql.ts`, the person's token,
// `errors` typed by GitHub's error type: `NOT_FOUND`, `FORBIDDEN` as unauthorized, any other as invalid).
// `findReview` never takes the empty review GitHub files for each reply: it holds no marker. `view` gives each inline
// comment its id, and each comment whether it is hidden, read with GraphQL's `nodes`.
// Polling (ADR 0043): the two listings polled, the open pull requests and the repository's conversation comments
// (newest edited first; a comment whose author's account is gone is left out), are read at stable addresses
// past 100 items, page by page as GitHub's `Link` header gives them (the comments only until a page reaches back
// before the point asked), each page sent with the ETag of its last answer, kept in memory by address for the
// adapter's life. A `304` is no error: it gives that answer back, and a listing every page of which was `304` is
// `unchanged`. ETags are bound to the token, so a renewed token costs one full answer per page. The commits
// between two heads are GitHub's compare: `ahead_by`, diverged when `from` is no ancestor of `to` (GitHub's
// `diverged` or `behind`), the messages of the first 100 commits, and the merge base (`merge_base_commit`). A
// review's and a check's lookups read every page too, without counting on `unchanged`; `view` still reads its first
// 100 items and no page after.
// Ordering: every call checks the allow-list before anything else, then takes the session's token, then makes its
// requests. Calls are independent: the check's lifecycle and a round's post order (review → status block → check
// completed) are the caller's, as the `HostWriter` port states them; updating or completing a check needs the id its
// creation gave. A listing's `unchanged` is about this adapter's last read of it, whoever asked: a hint, never a
// reason to skip its items.
// Error modes: everything it throws is a `HostError`. `not_found` for a repository or change GitHub has not, for one
// off the list (before any request), for a commit compare doesn't know or two with no common history, and for a
// comment a reaction can't find; `unauthorized` for a token or permission GitHub rejects, never for a secondary limit;
// `rate_limited` when GitHub asks to wait (a 429, `retry-after`, `x-ratelimit-remaining: 0`, or a 403 whose words name
// a secondary limit), its `retryAt` when GitHub said (`retry-after` from now, else the `x-ratelimit-reset` time);
// `unplaceable_comment` for an inline comment GitHub can't put on the diff ("could not be resolved", "must be part of
// the diff", "… of the same hunk"; nothing of the review is posted); `too_large` for a check output over
// `CHECK_OUTPUT_MAX_BYTES` or a review body, comment or reply over `COMMENT_MAX_BYTES` (nothing is sent), and for
// GitHub's own 422 "Body is too long"; `unavailable` for a network failure, a server error, GitHub's 422 "An internal
// error occurred, please try again" (seen to save the review all the same) or a payload of a shape it doesn't know;
// `invalid` for any other `422`. A brief network failure is tried again (ADR 0080): every try has a time limit, 30 s
// for a read, 60 s for a write, the body read included ("no answer within 30 s"); a read (a GET, or a GraphQL query
// its caller marks `read`) is tried 3 times in all, 1 s then 3 s apart, after any failure of the connection or a 502,
// 503 or 504; a write is tried again only after a failure that means it never reached GitHub (no address, the
// connection refused, the certificate refused: an exact list of codes). What still fails is `unavailable`, with the
// last failure's words and the tries it took; a limit or any other refusal is never tried again. Signing in's device
// code, poll and refresh are writes under the same rule (ADR 0092): 60 s a try, sent again only after a failure on
// that list, a try past its limit `unavailable`. Nothing else here retries but a token GitHub no longer takes:
// `publish` does. `view` shows an inline comment as GitHub does after a
// push: `line` (and a range's `endLine`) null once outdated, `originalLine` where it was posted.
// Signing in's errors: GitHub's OAuth endpoints answer their refusals with status 200 and an `error` field; the device
// flow's own are polls' outcomes, a refresh's `bad_refresh_token` (or `incorrect_client_credentials`, a refresh token
// GitHub doesn't know) is `unauthorized` with the cause `signed-out`, any other is `invalid`; a network failure, a
// 5xx or a try past its 60 s is `unavailable`, sent again only when it never reached GitHub (ADR 0080, 0092). On the
// person's session a token refused (401) while not yet expired is renewed once and the
// call made again; a 401 on a token just renewed, a refresh refused, or no sign-in kept is `signed-out`, which stays,
// with no refresh, until the keeper holds another sign-in; another person's sign-in kept is `signed-out` on a session
// that held someone else (ADR 0090), for good: no call of it made, renewed or made again with their token; a
// renewed sign-in the keeper fails to write is `unavailable`, held and written again before its first use; an act
// refused asking for SAML SSO (a 403 with GitHub's
// `X-GitHub-SSO: required; url=…`, or its words "SAML enforcement", REST's or GraphQL's) is `unauthorized` with the
// cause `sso` of the repository's owner, GitHub's page in its `url` when it gave one: that account's, never the
// connection's; an act refused (403, or GraphQL's `FORBIDDEN`) with no cause named is the person's own permission,
// `invalid`, the connection untouched. GitHub asking to wait (a 429, a limit's headers) is `rate_limited` on the OAuth
// endpoints as on the API. A rate limit never carries a cause; `unavailable` is left to `connectionCauseOf`
// (unreachable). The testkit's fake follows this mapping: this file is its source.
// It must never know: Lookover's rules (`core`), what a review says (`review`, `publish`), the store, the UI, or
// where a sign-in comes from (the sign-in's keeper is the caller's). It never logs a token.
export {
  type Account,
  createGitHub,
  createHostAccounts,
  createHostSignIn,
  type GitHub,
  type GitHubOptions,
  type HostOptions,
  type Identity,
} from "./github.ts";
export type { Poster, Session } from "./session.ts";
