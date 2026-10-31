// `AgentHost` over GitHub's REST API, with the agent's own token (ADR 0021): plain HTTPS, one request at a time,
// every answer parsed where it enters, GitHub's refusals turned into `HostError`s as the `github` package does
// for the App (this package never imports it: it would bring the App's key within reach). Listings follow the
// `Link` header past 100 items. The token is sent as given and never written down. Whose it is, is `GET /user`'s.
// The threads are GraphQL's (ADR 0052): only it knows a thread's id, which resolving takes, whether a person
// resolved it, and whether it is outdated as soon as a push makes it so (REST's `line` lags minutes, #174). GraphQL
// names an App's bot without `[bot]`: the App is told by its type and its slug, and its replies are named
// `<slug>[bot]` as REST names them. GraphQL answers a refusal with `200` and an `errors` list: its type says which.
import {
  type AgentChange,
  type AgentHost,
  type AgentThread,
  CHECK_NAME,
  type ChangeRef,
  type CheckConclusion,
  COMMENT_MAX_BYTES,
  type CommitSha,
  changeName,
  commitSha,
  findingOfMarker,
  type HostCheck,
  type HostComment,
  HostError,
  type HostFailure,
  type HostThreadReply,
  type RepositoryRef,
  utf8Bytes,
} from "@lookover/contracts";
import { z } from "zod";

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface AgentHostOptions {
  /** The agent's token: `GH_TOKEN`, `GITHUB_TOKEN` or `gh auth token`'s. */
  token: string;
  /** How requests reach GitHub; the real `fetch` by default. */
  fetch?: Fetch;
  /** The time, to say when a rate-limited GitHub may be asked again; the real time by default. */
  now?: () => number;
}

const BASE = "https://api.github.com";

/** The token's account, as `GET /user` gives it. */
const account = z.object({ id: z.int(), login: z.string() });
/** A repository by its id, which a rename keeps: what tells a fork's pull request from one of the base's own. */
const repoId = z.object({ id: z.int() });
const pull = z.object({
  number: z.int(),
  /** The head's repository is null once a fork it came from is deleted. */
  head: z.object({ sha: z.string(), repo: repoId.nullable() }),
  base: z.object({ repo: repoId }),
});
const checkRuns = z.object({
  check_runs: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      head_sha: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      output: z.object({
        title: z.string().nullable(),
        summary: z.string().nullable(),
        text: z.string().nullable(),
      }),
      app: z.object({ slug: z.string() }).nullable(),
      // Whose check it is (ADR 0066): `<job>@<person's id>`; null on a check made without one.
      external_id: z.string().nullish(),
    }),
  ),
});
const comment = z.object({
  id: z.number(),
  // A deleted account (a ghost) has no user.
  user: z.object({ id: z.number(), login: z.string() }).nullable(),
  body: z.string().nullable(),
  reactions: z.object({ eyes: z.number(), rocket: z.number() }),
});
const created = z.object({ id: z.number() });

/** What GraphQL answers: its data, and the errors it refused with, each typed (`NOT_FOUND`, `FORBIDDEN`…) or not. */
const graphqlAnswer = z.object({
  data: z.unknown().optional(),
  errors: z.array(z.object({ type: z.string().optional(), message: z.string() })).optional(),
});
const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
/** A review comment's author: a person, a bot (its login without `[bot]`), another kind, or none (a deleted account). */
const actor = z
  .object({ __typename: z.string(), login: z.string(), databaseId: z.int().nullable().optional() })
  .nullable();
const threadComment = z.object({
  id: z.string(),
  databaseId: z.int().nullable(),
  url: z.string(),
  body: z.string(),
  createdAt: z.string(),
  author: actor,
});
const commentPage = z.object({ pageInfo, nodes: z.array(threadComment) });
const reviewThread = z.object({
  id: z.string(),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  comments: commentPage,
});
const threadsAnswer = z.object({
  repository: z
    .object({
      pullRequest: z
        .object({ reviewThreads: z.object({ pageInfo, nodes: z.array(reviewThread) }) })
        .nullable(),
    })
    .nullable(),
});
const moreCommentsAnswer = z.object({ node: z.object({ comments: commentPage }).nullable() });
const resolvedAnswer = z.object({
  resolveReviewThread: z.object({ thread: z.object({ isResolved: z.boolean() }) }).nullable(),
});

const COMMENT_FIELDS = `fragment Note on PullRequestReviewComment {
  id databaseId url body createdAt
  author { __typename login ... on User { databaseId } ... on Bot { databaseId } }
}`;
const THREADS = `query ($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated
          comments(first: 100) { pageInfo { hasNextPage endCursor } nodes { ...Note } }
        }
      }
    }
  }
}
${COMMENT_FIELDS}`;
const MORE_COMMENTS = `query ($id: ID!, $after: String) {
  node(id: $id) {
    ... on PullRequestReviewThread {
      comments(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ...Note } }
    }
  }
}
${COMMENT_FIELDS}`;
const RESOLVE = `mutation ($id: ID!) {
  resolveReviewThread(input: { threadId: $id }) { thread { isResolved } }
}`;

/** The account GitHub shows for a deleted one in some answers. */
const GHOST = "ghost";

type ThreadComment = z.infer<typeof threadComment>;

/** A reply's author as a thread names it, or null for a deleted account, or one with no id (a mannequin). */
function authorOf(author: ThreadComment["author"]): HostThreadReply["author"] | null {
  if (author === null || author.login === GHOST || typeof author.databaseId !== "number") return null;
  const bot = author.__typename === "Bot";
  return { id: author.databaseId, login: bot ? `${author.login}[bot]` : author.login, bot };
}

type ReviewThread = z.infer<typeof reviewThread>;
/** A page of review threads read: Lookover's among them, and the cursor of the next page, or null. */
interface ThreadsPage {
  threads: AgentThread[];
  next: string | null;
}

/** The comments as a thread's replies, a deleted account's left out. */
function repliesOf(comments: ThreadComment[]): HostThreadReply[] {
  return comments.flatMap((c): HostThreadReply[] => {
    const author = authorOf(c.author);
    if (author === null || c.databaseId === null) return [];
    return [{ commentId: c.databaseId, nodeId: c.id, author, body: c.body, at: c.createdAt }];
  });
}

/**
 * The thread as Lookover's, with the replies of its first page; null when its root comment is neither the App
 * `app`'s (a bot of that login: GraphQL's has no `[bot]`) nor, given `person`, that person's (a user of that id, whom
 * the App posts as, ADR 0066), or holds no finding marker.
 */
function lookoverThread(node: ReviewThread, app: string, person: number | undefined): AgentThread | null {
  const [root, ...replies] = node.comments.nodes;
  if (!root || root.databaseId === null) return null;
  const finding = findingOfMarker(root.body);
  const author = root.author;
  const ours =
    (author?.__typename === "Bot" && author.login === app) ||
    (person !== undefined && author?.__typename === "User" && author.databaseId === person);
  if (!ours || finding === null) return null;
  return {
    commentId: root.databaseId,
    nodeId: root.id,
    url: root.url,
    findingId: finding,
    outdated: node.isOutdated,
    threadId: node.id,
    resolved: node.isResolved,
    replies: repliesOf(replies),
  };
}

/** GraphQL's error types as the host's failures; any other is a request refused as it is. */
const GRAPHQL_FAILURES: Record<string, HostFailure> = {
  NOT_FOUND: "not_found",
  FORBIDDEN: "unauthorized",
  RATE_LIMITED: "rate_limited",
};
const refusalBody = z.object({ message: z.string().optional() });

/** The words Lookover concludes a check with: a new `CheckConclusion` fails here until it is listed. */
const POSTED = { success: true, neutral: true, skipped: true } satisfies Record<CheckConclusion, true>;
const isPosted = (word: string): word is CheckConclusion => Object.hasOwn(POSTED, word);

/** GitHub's status as Lookover reads it: one it never sets (`waiting`, `pending`…) reads as running. */
const statusOf = (word: string): HostCheck["status"] =>
  word === "completed" || word === "queued" ? word : "in_progress";

const conclusionOf = (word: string | null): HostCheck["conclusion"] =>
  word === null ? null : isPosted(word) ? word : { other: word };

/** The `rel="next"` address of a `Link` header, or null. */
function nextPage(link: string | null): string | null {
  for (const part of (link ?? "").split(",")) {
    const found = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (found?.[1]) return found[1];
  }
  return null;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** When a refusing GitHub said it may be asked again: `retry-after` seconds from now, else the limit's reset. */
function retryAt(headers: Headers, now: number): number | undefined {
  const after = Number(headers.get("retry-after") ?? Number.NaN);
  if (Number.isFinite(after)) return now + after * 1000;
  const reset = Number(headers.get("x-ratelimit-reset") ?? Number.NaN);
  return Number.isFinite(reset) ? reset * 1000 : undefined;
}

interface Answer {
  status: number;
  body: unknown;
  headers: Headers;
}

/** What a request that GitHub refused throws. `unprocessable` says what its 422 means. */
function refusal(where: string, answer: Answer, now: number, unprocessable?: HostError): HostError {
  const said = refusalBody.safeParse(answer.body);
  const words = said.success && said.data.message ? `: ${said.data.message}` : "";
  const detail = `${answer.status}${words}`;
  const { status, headers } = answer;
  if (status === 401) return new HostError("unauthorized", `GitHub refused the token (${detail})`);
  if (
    (status === 403 || status === 429) &&
    (headers.has("retry-after") || headers.get("x-ratelimit-remaining") === "0")
  ) {
    const at = retryAt(headers, now);
    return new HostError(
      "rate_limited",
      `GitHub asked to wait (${detail})`,
      at === undefined ? {} : { retryAt: at },
    );
  }
  if (status === 403) return new HostError("unauthorized", `GitHub refused ${where} (${detail})`);
  if (status === 404) return new HostError("not_found", `GitHub has no ${where} (${detail})`);
  if (status === 422 && unprocessable) return unprocessable;
  return new HostError("unavailable", `GitHub answered ${where} with ${detail}`);
}

export function createAgentHost(options: AgentHostOptions): AgentHost {
  const send = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => Date.now());

  async function request(
    path: string,
    init: { method?: "GET" | "POST"; body?: unknown; unprocessable?: HostError } = {},
  ): Promise<Answer> {
    const method = init.method ?? "GET";
    const where = `${method} ${path.replace(BASE, "")}`;
    let answer: Answer;
    try {
      const response = await send(path.startsWith("http") ? path : `${BASE}${path}`, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${options.token}`,
          "user-agent": "lookover",
          "x-github-api-version": "2022-11-28",
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: init.body === undefined ? null : JSON.stringify(init.body),
      });
      const text = await response.text();
      answer = { status: response.status, body: text === "" ? null : parse(text), headers: response.headers };
    } catch (error) {
      throw new HostError("unavailable", `GitHub could not be reached: ${message(error)}`);
    }
    if (answer.status >= 200 && answer.status < 300) return answer;
    throw refusal(where, answer, now(), init.unprocessable);
  }

  /** Every item of a listing, page after page. */
  async function all<T>(path: string, read: (body: unknown) => T[], unprocessable?: HostError): Promise<T[]> {
    const items: T[] = [];
    let next: string | null = path;
    while (next !== null) {
      const answer = await request(next, unprocessable ? { unprocessable } : {});
      items.push(...read(answer.body));
      next = nextPage(answer.headers.get("link"));
    }
    return items;
  }

  /**
   * GraphQL's data for `query`, read by `schema`; its first error, when it gives any, thrown as the refusal of what
   * it was asked `to` do ("read the threads of …"), in GitHub's own words.
   */
  async function graphql<T>(
    to: string,
    query: string,
    variables: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const answer = await request(`${BASE}/graphql`, { method: "POST", body: { query, variables } });
    const read = graphqlAnswer.parse(answer.body);
    const error = read.errors?.[0];
    if (error) {
      const failure = GRAPHQL_FAILURES[error.type ?? ""] ?? "invalid";
      const at = failure === "rate_limited" ? retryAt(answer.headers, now()) : undefined;
      throw new HostError(
        failure,
        `GitHub refused to ${to}: ${error.message}`,
        at === undefined ? {} : { retryAt: at },
      );
    }
    return schema.parse(read.data);
  }

  /** Every comment of the thread past its first page. */
  async function restOf(node: ReviewThread): Promise<ThreadComment[]> {
    const comments: ThreadComment[] = [];
    let cursor = node.comments.pageInfo.hasNextPage ? node.comments.pageInfo.endCursor : null;
    while (cursor !== null) {
      const variables = { id: node.id, after: cursor };
      const read: z.infer<typeof moreCommentsAnswer> = await graphql(
        `read thread ${node.id}`,
        MORE_COMMENTS,
        variables,
        moreCommentsAnswer,
      );
      if (read.node === null) throw new HostError("not_found", `GitHub has no thread ${node.id}`);
      comments.push(...read.node.comments.nodes);
      const { hasNextPage, endCursor } = read.node.comments.pageInfo;
      cursor = hasNextPage ? endCursor : null;
    }
    return comments;
  }

  /** Lookover's threads among the change's review threads from the cursor `after`, and the next page's cursor. */
  async function threadsPage(
    change: ChangeRef,
    app: string,
    person: number | undefined,
    after: string | null,
  ): Promise<ThreadsPage> {
    const { repo, number } = change;
    const to = `read the threads of ${changeName({ repo, number })}`;
    const variables = { owner: repo.owner, name: repo.name, number, after };
    const pull = (await graphql(to, THREADS, variables, threadsAnswer)).repository?.pullRequest;
    if (!pull) throw new HostError("not_found", `GitHub has no pull request ${changeName({ repo, number })}`);
    const threads: AgentThread[] = [];
    for (const node of pull.reviewThreads.nodes) {
      const thread = lookoverThread(node, app, person);
      if (thread === null) continue;
      thread.replies.push(...repliesOf(await restOf(node)));
      threads.push(thread);
    }
    const { hasNextPage, endCursor } = pull.reviewThreads.pageInfo;
    return { threads, next: hasNextPage ? endCursor : null };
  }

  const repoPath = (repo: RepositoryRef) => `/repos/${repo.owner}/${repo.name}`;
  const changeOf = (body: unknown): AgentChange => {
    const read = pull.parse(body);
    // By id, never name, as the App's intake reads it; a head repository gone is a deleted fork's (ADR 0048).
    const fork = read.head.repo === null || read.head.repo.id !== read.base.repo.id;
    return { number: read.number, head: commitSha(read.head.sha), fork };
  };

  return {
    async account() {
      const me = account.parse((await request("/user")).body);
      return { id: me.id, login: me.login };
    },

    async changeOf(repo, branch) {
      const head = encodeURIComponent(`${repo.owner}:${branch}`);
      const open = await all(`${repoPath(repo)}/pulls?state=open&head=${head}&per_page=100`, (body) =>
        z.array(z.unknown()).parse(body).map(changeOf),
      );
      return open[0] ?? null;
    },

    async getChange(change: ChangeRef) {
      return changeOf((await request(`${repoPath(change.repo)}/pulls/${change.number}`)).body);
    },

    async checks(repo, sha: CommitSha, app) {
      // Every run of the name, and all of them: GitHub's default, `latest`, hides every run but the newest.
      const query = `check_name=${encodeURIComponent(CHECK_NAME)}&filter=all&per_page=100`;
      // GitHub answers 422 for a commit the repository doesn't have.
      const missing = new HostError("not_found", `${repo.owner}/${repo.name} has no commit ${sha}`);
      const runs = await all(
        `${repoPath(repo)}/commits/${sha}/check-runs?${query}`,
        (body) => checkRuns.parse(body).check_runs,
        missing,
      );
      return runs
        .filter((run) => run.app?.slug === app && run.name === CHECK_NAME)
        .sort((a, b) => a.id - b.id)
        .map((run) => ({
          id: String(run.id),
          name: run.name,
          sha: commitSha(run.head_sha),
          status: statusOf(run.status),
          conclusion: conclusionOf(run.conclusion),
          output: {
            title: run.output.title ?? "",
            summary: run.output.summary ?? "",
            text: run.output.text ?? "",
          },
          externalId: run.external_id ?? "",
        }));
    },

    async comments(change) {
      const listed = await all(
        `${repoPath(change.repo)}/issues/${change.number}/comments?per_page=100`,
        (body) => z.array(comment).parse(body),
      );
      return listed
        .sort((a, b) => a.id - b.id)
        .flatMap((c): HostComment[] =>
          c.user === null
            ? []
            : [
                {
                  id: String(c.id),
                  author: { id: c.user.id, login: c.user.login },
                  body: c.body ?? "",
                  reactions: { eyes: c.reactions.eyes, rocket: c.reactions.rocket },
                },
              ],
        );
    },

    async comment(change, body) {
      // An issue's number would take the comment too: only a pull request's does.
      await request(`${repoPath(change.repo)}/pulls/${change.number}`);
      const answer = await request(`${repoPath(change.repo)}/issues/${change.number}/comments`, {
        method: "POST",
        body: { body },
      });
      return String(created.parse(answer.body).id);
    },

    async threads(change, app, person) {
      const threads: AgentThread[] = [];
      let after: string | null = null;
      do {
        const page: ThreadsPage = await threadsPage(change, app, person, after);
        threads.push(...page.threads);
        after = page.next;
      } while (after !== null);
      return threads;
    },

    async reply(change, commentId, body) {
      const size = utf8Bytes(body);
      if (size > COMMENT_MAX_BYTES)
        throw new HostError(
          "too_large",
          `The reply is ${size} bytes; GitHub takes ${COMMENT_MAX_BYTES} at most`,
        );
      const path = `${repoPath(change.repo)}/pulls/${change.number}/comments/${commentId}/replies`;
      const answer = await request(path, { method: "POST", body: { body } });
      return created.parse(answer.body).id;
    },

    async resolve(threadId) {
      const read = await graphql(`resolve thread ${threadId}`, RESOLVE, { id: threadId }, resolvedAnswer);
      if (!read.resolveReviewThread?.thread.isResolved)
        throw new HostError("invalid", `GitHub did not resolve thread ${threadId}`);
    },
  };
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON: an HTML error page, say. The caller's schema says what it expected.
    return text;
  }
}
