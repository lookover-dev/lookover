// GitHub's payloads, parsed where they enter (Zod 4). Each schema names only the fields Lookover reads;
// `parse` strips the rest, and a payload of another shape is `HostError("unavailable")` with what was expected.
import { HostError } from "@lookover/contracts";
import { z } from "zod";

const user = z.object({ id: z.int(), login: z.string() });
/** A commit's sha as GitHub writes it, checked here so that `commitSha` never refuses one later. */
const sha = z.string().regex(/^[0-9a-f]{7,40}$/, "not a commit sha");
const ref = z.object({ ref: z.string(), sha });
/** A repository by its id, which a rename keeps: what tells a fork's pull request from one of the base's own. */
const repo = z.object({ id: z.int() });

export const pull = z.object({
  number: z.int(),
  title: z.string(),
  html_url: z.string(),
  user,
  draft: z.boolean(),
  /** The head's repository is null once a fork it came from is deleted. */
  head: ref.extend({ repo: repo.nullable() }),
  base: ref.extend({ repo }),
});

export const pulls = z.array(pull);

export const installation = z.object({ id: z.int() });

export const accessToken = z.object({ token: z.string(), expires_at: z.iso.datetime() });

export const app = z.object({ id: z.int(), slug: z.string() });

export const botUser = user;

/** An account as the App-level answers give it; its `type` is GitHub's (`User`, `Organization`, `Enterprise`…). */
const account = user.extend({ type: z.string() });

/** The App, as `GET /app` and a manifest's conversion describe it: who owns it and what it holds. */
export const hostApp = z.object({
  id: z.int(),
  slug: z.string(),
  owner: account,
  permissions: z.record(z.string(), z.enum(["read", "write", "admin"])),
});

/** A manifest's conversion: the App and its private key. Its client and webhook secrets are not read. */
export const conversion = hostApp.extend({ pem: z.string().min(1) });

/** The App's installations, one page: on whose account each is, and whether it is suspended. */
export const appInstallations = z.array(
  z.object({ id: z.int(), account, suspended_at: z.string().nullable().optional() }),
);

/** The repositories an installation grants, one page. */
export const installationRepositories = z.object({
  repositories: z.array(
    z.object({ name: z.string(), owner: z.object({ login: z.string() }), archived: z.boolean() }),
  ),
});

/** A repository, for its owner: the account whose changes the UI calls "you". */
export const repository = z.object({ owner: user });

/** A repository, for its default branch as it is named now. */
export const defaultBranch = z.object({ default_branch: z.string().min(1) });

/** A check run as its creation answers: the id to complete it with. */
export const checkRun = z.object({ id: z.int() });

/** A commit's check runs with the external id each was created with: null when none was given. */
export const externalRuns = z.object({
  check_runs: z.array(z.object({ id: z.int(), external_id: z.string().nullable() })),
});

/** A commit's check runs as GitHub lists them. An output never written reads back as null. */
export const checkRuns = z.object({
  check_runs: z.array(
    z.object({
      id: z.int(),
      name: z.string(),
      head_sha: sha,
      status: z.string(),
      conclusion: z.string().nullable(),
      output: z.object({
        title: z.string().nullable(),
        summary: z.string().nullable(),
        text: z.string().nullable(),
      }),
    }),
  ),
});

/** A review as its creation answers: the host's id for it. */
export const reviewId = z.object({ id: z.int() });

/** A pull request's reviews as GitHub lists them. */
export const reviews = z.array(z.object({ id: z.int(), body: z.string(), commit_id: sha }));

/** A pull request's reviews with who wrote each: null for an account GitHub has since deleted. */
export const authoredReviews = z.array(z.object({ id: z.int(), body: z.string(), user: user.nullable() }));

/** A pull request's inline comments, each in its review. `line` is null once the line is outdated. */
export const reviewComments = z.array(
  z.object({
    id: z.int(),
    node_id: z.string(),
    pull_request_review_id: z.int(),
    path: z.string(),
    side: z.enum(["LEFT", "RIGHT"]),
    line: z.int().nullable(),
    original_line: z.int(),
    /** A range's first line; null (or absent) on a comment on one line, and once the range is outdated. */
    start_line: z.int().nullish(),
    original_start_line: z.int().nullish(),
    body: z.string(),
  }),
);

/**
 * A pull request's inline comments as its threads read them (ADR 0052): a reply names its thread's root comment
 * (`in_reply_to_id`, absent on a root); `user` is null once the author's account is gone, and says whether it is a
 * bot (`type`). Whether one is outdated is GraphQL's to say: REST's `line` went null minutes after GraphQL's
 * `outdated` (#174's live run).
 */
export const threadComments = z.array(
  z.object({
    id: z.int(),
    node_id: z.string(),
    in_reply_to_id: z.int().optional(),
    user: z.object({ id: z.int(), login: z.string(), type: z.string() }).nullable(),
    body: z.string(),
    html_url: z.string(),
    created_at: z.iso.datetime(),
  }),
);

/** An inline comment as a reply's creation answers: the host's id for it. */
export const replyId = z.object({ id: z.int() });

/** A comment in the pull request's conversation (an "issue comment" to GitHub). */
export const issueComment = z.object({ id: z.int(), user, body: z.string() });

export const issueComments = z.array(issueComment);

/** The conversation as `view` reads it: each comment with GitHub's count of each of its reactions. */
export const viewedComments = z.array(
  issueComment.extend({ node_id: z.string(), reactions: z.object({ eyes: z.int(), rocket: z.int() }) }),
);

/** Whether each comment asked about is hidden, and why (GitHub's word); null for an id that names nothing. */
export const minimizedNodes = z.object({
  nodes: z.array(
    z
      .object({
        id: z.string(),
        isMinimized: z.boolean().optional(),
        minimizedReason: z.string().nullable().optional(),
      })
      .nullable(),
  ),
});

/** Whether each review comment asked about is outdated; null for an id that names nothing. */
export const outdatedNodes = z.object({
  nodes: z.array(z.object({ id: z.string(), outdated: z.boolean() }).nullable()),
});

/** A comment minimized, as `minimizeComment` answers. */
export const minimizedComment = z.object({
  minimizeComment: z.object({ minimizedComment: z.object({ isMinimized: z.boolean() }).nullable() }),
});

/**
 * The repository's conversation comments, as polling reads them: the issue or pull request each is on (by its
 * API address, ending in its number) and its times. `user` is null once the author's account is gone.
 */
export const repositoryComments = z.array(
  z.object({
    id: z.int(),
    node_id: z.string(),
    user: user.nullable(),
    body: z.string(),
    issue_url: z.string().regex(/\/issues\/\d+$/, "not an issue's address"),
    created_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
  }),
);

/** A comparison of two commits: how the second stands to the first, and how many commits each has. */
export const comparison = z.object({
  status: z.enum(["ahead", "behind", "identical", "diverged"]),
  ahead_by: z.int(),
  behind_by: z.int(),
  /** The commits the second has, oldest first, one page of them. */
  commits: z.array(z.object({ commit: z.object({ message: z.string() }) })),
});

/** A refusal's body: GitHub's `message`, and its `errors` when it lists them (strings or objects). */
export const refusal = z.object({
  message: z.string().optional(),
  errors: z.array(z.union([z.string(), z.object({ message: z.string().optional() })])).optional(),
});

/** The payload as `schema` reads it. Throws `HostError("unavailable")` when it has another shape. */
export function parse<T>(schema: z.ZodType<T>, payload: unknown, what: string): T {
  const result = schema.safeParse(payload);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const at = issue ? ` (${issue.path.join(".") || "root"}: ${issue.message})` : "";
  throw new HostError("unavailable", `GitHub answered ${what} with a shape Lookover doesn't know${at}`);
}
