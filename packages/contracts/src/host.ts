// What the two Git host ports share (ADR 0008, ADR 0022, ADR 0033): how a repository and a change are named
// to the host, and how a host call fails.
import type { ConnectionCause } from "./connection.ts";

/** The Git hosts Lookover speaks to (ADR 0008): GitHub in v1. The result names it (`change.host`). */
export type GitHost = "github";

/** A repository as the host names it: `owner/name` on GitHub. */
export interface RepositoryRef {
  owner: string;
  name: string;
}

/** `owner/name`, as the repository was written. */
export const repositoryName = (repo: RepositoryRef): string => `${repo.owner}/${repo.name}`;

/** The same repository, however it was written: GitHub's owner and repository names ignore case. */
export const sameRepository = (a: RepositoryRef, b: RepositoryRef): boolean =>
  repositoryName(a).toLowerCase() === repositoryName(b).toLowerCase();

/** A change as the host names it: the pull request's number in its repository. */
export interface ChangeRef {
  repo: RepositoryRef;
  number: number;
}

/**
 * Why a host call failed. `not_found`: no such repository or change. `unplaceable_comment`: an inline comment
 * on a line outside the diff; the host refuses the whole review and posts nothing of it. `too_large`: a check
 * output over `CHECK_OUTPUT_MAX_BYTES`, or a summary, a review's body or an inline comment over
 * `COMMENT_MAX_BYTES` (GitHub's "Body is too long"); nothing of that post is sent. `missing_marker`: a summary without `SUMMARY_MARKER`, which the next
 * round could not find; nothing is posted. `unauthorized`: the connection's credentials don't allow it.
 * `rate_limited`: the host asked to wait (until `retryAt`, when it said), its primary limit or a secondary one.
 * `unavailable`: the host could not be reached or answered with an error of its own (GitHub's 5xx, its 422 "An
 * internal error occurred"); a post may have landed all the same, and sent again it may be taken. `invalid`: the
 * host refused the request as it is (GitHub's other 422s); sent again unchanged, it is refused again.
 */
export type HostFailure =
  | "not_found"
  | "unplaceable_comment"
  | "too_large"
  | "missing_marker"
  | "unauthorized"
  | "rate_limited"
  | "unavailable"
  | "invalid";

/** The refusals worth sending the same post again for (ADR 0044): the host failed or asked to wait. */
export type TransientHostFailure = Extract<HostFailure, "rate_limited" | "unavailable">;

/** What a host port throws. Every adapter, fake or real, throws this and nothing else for a host's refusal. */
export class HostError extends Error {
  readonly failure: HostFailure;
  /**
   * When the host said it may be asked again, in milliseconds since the Unix epoch: set on `rate_limited` when the
   * host said (GitHub: `retry-after`, else `x-ratelimit-reset`), undefined otherwise.
   */
  readonly retryAt: number | undefined;
  /**
   * What the connection shows for this refusal (ADR 0053), when the adapter can tell more than `failure` says: an
   * App uninstalled or suspended, a key GitHub refused and why. Undefined otherwise: `connectionCauseOf` reads it.
   */
  readonly connectionCause: ConnectionCause | undefined;

  constructor(
    failure: HostFailure,
    message: string,
    options: { retryAt?: number; connectionCause?: ConnectionCause } = {},
  ) {
    super(message);
    this.name = "HostError";
    this.failure = failure;
    this.retryAt = options.retryAt;
    this.connectionCause = options.connectionCause;
  }
}

/**
 * The connection's cause a host's refusal gives (ADR 0053): the one the adapter named, else `unreachable` for an
 * `unavailable` host and `key-refused` (GitHub naming no reason) for `unauthorized`; null for a refusal that doesn't
 * cut the connection (a rate limit, a change or a request the host refused).
 */
export function connectionCauseOf(error: HostError): ConnectionCause | null {
  if (error.connectionCause !== undefined) return error.connectionCause;
  if (error.failure === "unavailable") return { kind: "unreachable" };
  if (error.failure === "unauthorized") return { kind: "key-refused", why: null };
  return null;
}

const encoder = new TextEncoder();

/**
 * A text's size as GitHub counts its limits (#67): UTF-8 bytes. `publish` cuts to it, the writers and the fake host
 * refuse past it, and tests measure what is posted with it.
 */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

/**
 * GitHub's limit on a check's output `summary` and `text`, in UTF-8 bytes (ADR 0022). Over it, ASCII is refused
 * and multi-byte text is cut silently, so the size is counted in bytes before posting.
 */
export const CHECK_OUTPUT_MAX_BYTES = 65_535;

/**
 * The most a summary comment, a review's body or one inline comment may hold, in UTF-8 bytes (ADR 0044, #67).
 * GitHub's refusal says "maximum is 65536 characters", but what it counts is bytes: measured on 2026-10-08, a
 * conversation comment or a review's body is refused past 262,144 UTF-8 bytes (65,537 ASCII characters are taken,
 * 65,537 four-byte emoji are not), and an inline comment sent in a review was taken whole at 1,000,000. This budget
 * stays under both readings, so a body within it is refused by neither. `publish` cuts at a line to fit it; the
 * writers refuse what is over.
 */
export const COMMENT_MAX_BYTES = 65_535;

/**
 * The most inline comments Lookover puts in one review (ADR 0044, #67): the findings past it go to the summary.
 * GitHub sets no number, but measured on 2026-10-08 it takes about a third of a second per comment to create a
 * review (10 in 4 s, 25 in 9 s), and a review of 50 was answered with a 502 though it was saved; each comment
 * also counts toward its secondary limit on creating content (the App was blocked after 35 in a minute). At 20,
 * a review lands in about 7 s, under the 10 s after which GitHub answers 502.
 */
export const REVIEW_MAX_COMMENTS = 20;
