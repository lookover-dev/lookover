// The App side's one GraphQL client (ADR 0052): what REST can't do, minimizing a comment and reading whether one
// is hidden, sent to GitHub's GraphQL endpoint with the installation token the caller holds, through the same
// HTTP client as every REST call (its rate-limit headers read, its refusals typed). GitHub answers a refused
// GraphQL request `200` with `errors`: each is turned into the `HostError` it means, by GitHub's error type.
import { HostError } from "@lookover/contracts";
import { z } from "zod";
import type { GitHubApi } from "./api.ts";
import { parse } from "./schemas.ts";

const PATH = "/graphql";

/** A GraphQL answer: its data, and the errors GitHub lists when it refused part or all of the request. */
const answer = z.object({
  data: z.unknown().optional(),
  errors: z.array(z.object({ type: z.string().optional(), message: z.string() })).optional(),
});

/** GitHub's GraphQL error types, as the host refusal each means; any other is `invalid`. */
const REFUSAL: Record<string, "unauthorized" | "not_found" | "rate_limited"> = {
  FORBIDDEN: "unauthorized",
  NOT_FOUND: "not_found",
  RATE_LIMITED: "rate_limited",
};

/**
 * Sends `query` with `variables`, as `token`'s holder, and returns its data as `data` reads it. Throws the
 * `HostError` GitHub's first error means (`what` names the request in its message), or `unavailable` for an answer
 * of a shape it doesn't know.
 */
export async function graphql<T>(
  api: GitHubApi,
  token: string,
  request: { query: string; variables: Record<string, unknown>; what: string },
  data: z.ZodType<T>,
): Promise<T> {
  const sent = await api.request({
    method: "POST",
    path: PATH,
    bearer: token,
    body: { query: request.query, variables: request.variables },
  });
  const read = parse(answer, sent.body, `POST ${PATH} (${request.what})`);
  const [error] = read.errors ?? [];
  if (error) {
    const failure = REFUSAL[error.type ?? ""] ?? "invalid";
    // GraphQL's limit resets when its `x-ratelimit-reset` says, as REST's primary limit does.
    const reset = Number(sent.headers.get("x-ratelimit-reset") ?? Number.NaN);
    const retry = failure === "rate_limited" && Number.isFinite(reset) ? { retryAt: reset * 1000 } : {};
    throw new HostError(failure, `GitHub refused ${request.what}: ${error.message}`, retry);
  }
  return parse(data, read.data, `POST ${PATH} (${request.what})`);
}
