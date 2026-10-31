// The HTTP client under both ports: one request at a time, GitHub's headers, the rate-limit headers of every
// answer read, and GitHub's refusals turned into `HostError`s. A listing's pages are read with the ETag of the
// last answer to the same address, so GitHub's `304` (free) gives that answer back instead of an error.
// Payloads leave here as `unknown`: the caller parses them with the schema of what it asked for.
import { type Clock, type ConnectionCause, HostError } from "@lookover/contracts";
import { refusal as refusalBody } from "./schemas.ts";

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** The last rate-limit headers read, as GitHub sends them (ADR 0022). */
export interface RateLimit {
  limit: number;
  remaining: number;
  used: number;
  /** When the window resets, in milliseconds since the Unix epoch. */
  resetAt: number;
  /** GitHub's name for the limited resource: `core`, `graphql`, `search`… */
  resource: string;
}

/**
 * What the connection shows for a refusal of this request, from its status and GitHub's words (ADR 0053): a refused
 * JWT names why, a refused token purchase says the installation is gone. Undefined leaves `connectionCauseOf` to
 * read the failure.
 */
export type CauseOf = (status: number, words: string) => ConnectionCause | undefined;

export interface HostRequest {
  method?: "GET" | "POST" | "PATCH";
  path: string;
  /** The bearer: the App's JWT or an installation token; null for a request that needs none (a manifest's code). */
  bearer: string | null;
  body?: unknown;
  cause?: CauseOf;
  /**
   * A credential the path carries (a manifest's code, ADR 0053): no message names it, `…` stands in its place.
   */
  secret?: string;
  /**
   * What a 422 GitHub's common words don't explain means for this request ("Body is too long" is `too_large`, "An
   * internal error occurred" `unavailable`); null, or not given, is `invalid`.
   */
  unprocessable?: (message: string) => HostError | null;
}

export interface Answer {
  status: number;
  body: unknown;
  headers: Headers;
}

/** One page of a listing, read with the ETag of its last answer. */
export interface Page {
  /** GitHub answered `304`: the page is as at its last read, and `body` and `next` are that read's. */
  unchanged: boolean;
  body: unknown;
  /** The next page's address, from the `Link` header; null on the last page. */
  next: string | null;
  /** When GitHub answered, by its own clock (the `Date` header, to the second); this machine's time without one. */
  at: number;
}

/** GitHub's API address when none is given. */
const GITHUB_API = "https://api.github.com";

export class GitHubApi {
  private last: RateLimit | null = null;
  private readonly fetch: Fetch;
  /**
   * The last answer to each page read, by its address: its ETag, its body and its next page. Kept for the
   * adapter's life; GitHub ties an ETag to the token, so a renewed token costs one full answer per page.
   */
  private readonly pages = new Map<string, { etag: string; body: unknown; next: string | null }>();

  private readonly clock: Clock;
  /** Where GitHub's API answers: GitHub's own, or a stub's address. A path is read under it. */
  private readonly base: string;

  constructor(fetch: Fetch, clock: Clock, base: string = GITHUB_API) {
    this.fetch = fetch;
    this.clock = clock;
    this.base = base;
  }

  rateLimit(): RateLimit | null {
    return this.last;
  }

  /** One request. Throws `HostError` for any answer that isn't a success. */
  async request(request: HostRequest): Promise<Answer> {
    const answer = await this.send(request);
    this.readRateLimit(answer.headers);
    if (answer.status >= 200 && answer.status < 300) return answer;
    throw refusal(request, answer, this.clock.now());
  }

  /**
   * One page of a listing, a GET sent with the ETag of the last answer to the same address: GitHub's `304`
   * (free of the rate limit) gives that answer back, `unchanged`. With `cached` false, the page is read whole and
   * nothing of it is kept (a read made once a round, whose answer would only fill the cache). Throws `HostError`
   * for any other answer that isn't a success.
   */
  async page(path: string, bearer: string, cached = true, cause?: CauseOf): Promise<Page> {
    const kept = cached ? this.pages.get(path) : undefined;
    const answer = await this.send({ path, bearer }, kept?.etag);
    this.readRateLimit(answer.headers);
    const date = Date.parse(answer.headers.get("date") ?? "");
    const at = Number.isNaN(date) ? this.clock.now() : date;
    if (answer.status === 304 && kept) return { unchanged: true, body: kept.body, next: kept.next, at };
    if (answer.status < 200 || answer.status >= 300)
      throw refusal({ path, bearer, ...(cause ? { cause } : {}) }, answer, this.clock.now());
    const next = nextPage(answer.headers.get("link"));
    const etag = answer.headers.get("etag");
    if (!cached) return { unchanged: false, body: answer.body, next, at };
    if (etag === null) this.pages.delete(path);
    else this.pages.set(path, { etag, body: answer.body, next });
    return { unchanged: false, body: answer.body, next, at };
  }

  private async send(request: HostRequest, etag?: string): Promise<Answer> {
    const { method, path, bearer, body } = request;
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "user-agent": "lookover",
      "x-github-api-version": "2022-11-28",
    };
    if (bearer !== null) headers.authorization = `Bearer ${bearer}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    if (etag !== undefined) headers["if-none-match"] = etag;
    // The answer is read whole inside the guard: a connection that breaks off mid-body is GitHub unreachable too.
    try {
      const response = await this.fetch(path.startsWith("http") ? path : `${this.base}${path}`, {
        method: method ?? "GET",
        headers,
        body: body === undefined ? null : JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, body: parseJson(text), headers: response.headers };
    } catch (error) {
      throw new HostError("unavailable", `GitHub could not be reached: ${redact(request, message(error))}`);
    }
  }

  private readRateLimit(headers: Headers): void {
    const limit = headers.get("x-ratelimit-limit");
    const remaining = headers.get("x-ratelimit-remaining");
    const reset = headers.get("x-ratelimit-reset");
    if (limit === null || remaining === null || reset === null) return;
    this.last = {
      limit: Number(limit),
      remaining: Number(remaining),
      used: Number(headers.get("x-ratelimit-used") ?? 0),
      resetAt: Number(reset) * 1000,
      resource: headers.get("x-ratelimit-resource") ?? "core",
    };
  }
}

function parseJson(text: string): unknown {
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON: an HTML error page, say. The caller's schema will say what it expected.
    return text;
  }
}

/** The `rel="next"` address of a `Link` header (`<url>; rel="next", <url>; rel="last"`), or null. */
function nextPage(link: string | null): string | null {
  for (const part of (link ?? "").split(",")) {
    const found = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (found?.[1]) return found[1];
  }
  return null;
}

/** What an error says, whatever was thrown. */
export const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** GitHub's own words for a refusal: its `message`, and its `errors` when it lists them. */
function said(body: unknown): string {
  const read = refusalBody.safeParse(body);
  if (!read.success) return "";
  const errors = (read.data.errors ?? []).map((e) => (typeof e === "string" ? e : (e.message ?? "")));
  return [read.data.message ?? "", ...errors].filter((p) => p !== "").join("; ");
}

/**
 * GitHub asks to wait: a 429, the headers of a limit (`retry-after`, or `x-ratelimit-remaining: 0`), or, for a
 * secondary limit sent as a 403 with neither header, its words. Never a refusal of the credentials: the token stays.
 */
const askedToWait = (status: number, headers: Headers, words: string) =>
  status === 429 ||
  headers.get("retry-after") !== null ||
  headers.get("x-ratelimit-remaining") === "0" ||
  /secondary rate limit|abuse detection/i.test(words);

/**
 * When GitHub said it may be asked again: `retry-after` seconds from `now` (its secondary limits), else the
 * primary limit's reset time (`x-ratelimit-reset`, in seconds since the Unix epoch); undefined when it said neither.
 */
function retryAt(headers: Headers, now: number): number | undefined {
  const after = Number(headers.get("retry-after") ?? Number.NaN);
  if (Number.isFinite(after)) return now + after * 1000;
  const reset = Number(headers.get("x-ratelimit-reset") ?? Number.NaN);
  return Number.isFinite(reset) ? reset * 1000 : undefined;
}

/**
 * GitHub asking to wait, read in an answer's status, headers and words (`said`), as `rate_limited` until when it said
 * it may be asked again; null when it asks no wait. The API's answers and the OAuth endpoints' read it alike.
 */
export function waitAsked(status: number, headers: Headers, words: string, now: number): HostError | null {
  if ((status !== 403 && status !== 429) || !askedToWait(status, headers, words)) return null;
  const detail = words === "" ? `${status}` : `${status}: ${words}`;
  const at = retryAt(headers, now);
  return new HostError(
    "rate_limited",
    `GitHub asked to wait (${detail})`,
    at === undefined ? {} : { retryAt: at },
  );
}

/** An organisation asking for SAML single sign-on, as GitHub refused: the page it gave to sign in there, if any. */
export interface SsoAsked {
  url: string | null;
}

/** GitHub's words for a resource an organisation protects with SAML SSO, in REST's message and in GraphQL's. */
const SAML_WORDS = /SAML enforcement/i;

/**
 * A 403 asking for SAML SSO (GitHub's docs, "Authenticating to the REST API"): its `X-GitHub-SSO` header
 * `required; url=<the page to sign in>`, or, without the header, GitHub's words for it. Null for any other answer.
 */
function ssoAskedIn(status: number, headers: Headers, words: string): SsoAsked | null {
  if (status !== 403) return null;
  const header = headers.get("x-github-sso") ?? "";
  if (!/^required\b/i.test(header) && !SAML_WORDS.test(words)) return null;
  const url = /\burl=(\S+)/.exec(header)?.[1];
  return { url: url ?? null };
}

/**
 * Whether a refusal asked for SAML SSO: a REST refusal as its answer said (`ssoAskedIn`), a GraphQL one (answered
 * `200` with `FORBIDDEN`, no header) by GitHub's words in its message. Null for any other error.
 */
export function ssoAsked(error: unknown): SsoAsked | null {
  if (error instanceof GitHubRefusal) return error.sso;
  if (error instanceof HostError && error.failure === "unauthorized" && SAML_WORDS.test(error.message))
    return { url: null };
  return null;
}

/** A refusal GitHub answered, with its status: what tells a token it no longer takes (401) from an act refused. */
export class GitHubRefusal extends HostError {
  readonly status: number;
  /** The organisation's SAML SSO asked for, as the answer said; null when it asked none. */
  readonly sso: SsoAsked | null;

  constructor(
    error: HostError,
    status: number,
    connectionCause: ConnectionCause | undefined,
    sso: SsoAsked | null = null,
  ) {
    super(error.failure, error.message, {
      ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
      ...(connectionCause === undefined ? {} : { connectionCause }),
    });
    this.status = status;
    this.sso = sso;
  }
}

/** `text` with the request's credential, as given or as the path encodes it, put out of sight. */
function redact(request: HostRequest, text: string): string {
  const { secret } = request;
  if (secret === undefined || secret === "") return text;
  return text.replaceAll(secret, "…").replaceAll(encodeURIComponent(secret), "…");
}

/**
 * A refusal as a `HostError`, carrying the connection's cause the request reads in it, if any: never for a rate
 * limit, which cuts nothing, and a refusal whose cause is the key is `unauthorized`, whatever its status.
 */
function refusal(request: HostRequest, answer: Answer, now: number): GitHubRefusal {
  const read = refusalOf(request, answer, now);
  const cause =
    read.failure === "rate_limited" ? undefined : request.cause?.(answer.status, said(answer.body));
  const failure = cause?.kind === "key-refused" ? "unauthorized" : read.failure;
  const error = new HostError(failure, redact(request, read.message), {
    ...(read.retryAt === undefined ? {} : { retryAt: read.retryAt }),
  });
  const sso =
    read.failure === "rate_limited" ? null : ssoAskedIn(answer.status, answer.headers, said(answer.body));
  return new GitHubRefusal(error, answer.status, cause, sso);
}

function refusalOf(request: HostRequest, { status, body, headers }: Answer, now: number): HostError {
  const words = said(body);
  const where = `${request.method ?? "GET"} ${request.path}`;
  const detail = words === "" ? `${status}` : `${status}: ${words}`;
  if (status === 401) return new HostError("unauthorized", `GitHub refused the credentials (${detail})`);
  const wait = waitAsked(status, headers, words, now);
  if (wait !== null) return wait;
  if (status === 403) return new HostError("unauthorized", `GitHub refused ${where} (${detail})`);
  if (status === 404) return new HostError("not_found", `GitHub has no ${where} (${detail})`);
  if (status === 422) return unprocessable(request, words, `${where} (${detail})`);
  return new HostError("unavailable", `GitHub answered ${where} with ${detail}`);
}

/**
 * GitHub's 422, by its words: a body too long; its own failure, which asks to be tried again (seen to have saved a
 * review all the same); what the request says its words mean; else the request as it is is refused.
 */
function unprocessable(request: HostRequest, words: string, what: string): HostError {
  if (/body is too long/i.test(words))
    return new HostError("too_large", `GitHub found a body too long: ${what}`);
  if (/internal error/i.test(words)) return new HostError("unavailable", `GitHub failed on ${what}`);
  return request.unprocessable?.(words) ?? new HostError("invalid", `GitHub refused ${what}`);
}
