// `createAgentHost` against a scripted `fetch` answering as GitHub does (the shapes spike 03 and the live suite
// read): what it asks, how it reads the answers, and how GitHub's refusals become `HostError`s. The live run
// proves the same port on GitHub itself (`describeAgentHost` in `scripts/live-agent-host.ts`).
import { describe, expect, test } from "bun:test";
import {
  COMMENT_MAX_BYTES,
  commitSha,
  FINDING_MARKER,
  findingId,
  type RepositoryRef,
} from "@lookover/contracts";
import { z } from "zod";
import { createAgentHost } from "./index.ts";

const repo: RepositoryRef = { owner: "sasensi", name: "lookover-sandbox" };
const sha = commitSha("5d9114c0a1b2c3d4e5f60718293a4b5c6d7e8f9a");
const API = "https://api.github.com/repos/sasensi/lookover-sandbox";
const GRAPHQL = "https://api.github.com/graphql";

interface Asked {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A GraphQL request as the adapter sends it. */
const graphqlRequest = z.object({ query: z.string(), variables: z.record(z.string(), z.unknown()) });
type GraphqlRequest = z.infer<typeof graphqlRequest>;

/**
 * A GitHub that answers each address with what `routes` gives, its GraphQL endpoint with what `graphql` gives for
 * the request, and records what it was asked.
 */
function github(
  routes: Record<string, () => Response>,
  graphql: (asked: GraphqlRequest) => Response = () => json(404, { message: "Not Found" }),
) {
  const asked: Asked[] = [];
  const fetch = (input: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    asked.push({
      url: input,
      method: init.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
      body: typeof init.body === "string" ? JSON.parse(init.body) : null,
    });
    if (input === GRAPHQL && init.method === "POST" && typeof init.body === "string")
      return Promise.resolve(graphql(graphqlRequest.parse(JSON.parse(init.body))));
    const route = routes[`${init.method ?? "GET"} ${input}`];
    return Promise.resolve(route ? route() : json(404, { message: "Not Found" }));
  };
  return { asked, host: createAgentHost({ token: "gho_agent", fetch, now: () => 1_000_000 }) };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** The sandbox's id on GitHub, as its pull requests' base gives it. */
const SANDBOX_ID = 1_046_000_001;

/**
 * A pull request as GitHub gives it, trimmed to what the agent reads; its head in the sandbox itself unless
 * `headRepo` says another repository (a fork's) or none (a deleted fork's).
 */
const pull = (number: number, headRepo: { id: number } | null = { id: SANDBOX_ID }) => ({
  number,
  head: { sha, repo: headRepo },
  base: { repo: { id: SANDBOX_ID } },
});

const run = (id: number, slug: string, status = "queued", conclusion: string | null = null) => ({
  id,
  name: "Lookover",
  head_sha: sha,
  status,
  conclusion,
  output: { title: "Waiting for its turn", summary: "Queued.", text: null },
  app: { slug },
});

describe("createAgentHost", () => {
  test("asks with the agent's token, and finds a branch's open pull request in the repository itself", async () => {
    const { asked, host } = github({
      [`GET ${API}/pulls?state=open&head=sasensi%3Afeature%2Funpaid&per_page=100`]: () =>
        json(200, [pull(7)]),
    });
    expect(await host.changeOf(repo, "feature/unpaid")).toEqual({ number: 7, head: sha, fork: false });
    expect(asked[0]?.headers).toMatchObject({
      authorization: "Bearer gho_agent",
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    });
  });

  test("a pull request from a fork reads as one: its head in another repository, or in one deleted (ADR 0048)", async () => {
    const read = (body: unknown) => github({ [`GET ${API}/pulls/7`]: () => json(200, body) }).host;
    expect(await read(pull(7)).getChange({ repo, number: 7 })).toEqual({ number: 7, head: sha, fork: false });
    expect(await read(pull(7, { id: 2_000_000_002 })).getChange({ repo, number: 7 })).toMatchObject({
      fork: true,
    });
    expect(await read(pull(7, null)).getChange({ repo, number: 7 })).toMatchObject({ fork: true });
  });

  test("a branch with no open pull request reads null", async () => {
    const { host } = github({
      [`GET ${API}/pulls?state=open&head=sasensi%3Agone&per_page=100`]: () => json(200, []),
    });
    expect(await host.changeOf(repo, "gone")).toBeNull();
  });

  test("the checks of a commit: Lookover's App's only, every run, oldest first, as Lookover reads them", async () => {
    const { host } = github({
      [`GET ${API}/commits/${sha}/check-runs?check_name=Lookover&filter=all&per_page=100`]: () =>
        json(200, {
          check_runs: [
            run(30, "lookover-spike-sasensi", "waiting"),
            run(10, "lookover-spike-sasensi", "completed", "cancelled"),
            run(20, "someone-elses-app", "completed", "success"),
            { ...run(25, "lookover-spike-sasensi", "completed", "skipped"), app: null },
            run(15, "lookover-spike-sasensi", "completed", "skipped"),
          ],
        }),
    });
    const checks = await host.checks(repo, sha, "lookover-spike-sasensi");
    expect(checks.map((c) => [c.id, c.status, c.conclusion])).toEqual([
      ["10", "completed", { other: "cancelled" }],
      ["15", "completed", "skipped"],
      ["30", "in_progress", null],
    ]);
    expect(checks[0]?.output).toEqual({ title: "Waiting for its turn", summary: "Queued.", text: "" });
  });

  test("a listing goes on past 100 items, by the Link header", async () => {
    const page2 = "https://api.github.com/repositories/1/issues/7/comments?per_page=100&page=2";
    const comment = (id: number, user: { id: number; login: string } | null) => ({
      id,
      user,
      body: `Comment ${id}`,
      reactions: { eyes: id === 2 ? 1 : 0, rocket: 0, "+1": 3 },
    });
    const { host } = github({
      [`GET ${API}/issues/7/comments?per_page=100`]: () =>
        json(200, [comment(1, { id: 5, login: "sasensi" })], { link: `<${page2}>; rel="next"` }),
      [`GET ${page2}`]: () => json(200, [comment(2, { id: 5, login: "sasensi" }), comment(3, null)]),
    });
    expect(await host.comments({ repo, number: 7 })).toEqual([
      { id: "1", author: { id: 5, login: "sasensi" }, body: "Comment 1", reactions: { eyes: 0, rocket: 0 } },
      { id: "2", author: { id: 5, login: "sasensi" }, body: "Comment 2", reactions: { eyes: 1, rocket: 0 } },
    ]);
  });

  test("a comment goes on a pull request's conversation, never on an issue of that number", async () => {
    const { asked, host } = github({
      [`GET ${API}/pulls/7`]: () => json(200, pull(7)),
      [`POST ${API}/issues/7/comments`]: () => json(201, { id: 42 }),
    });
    expect(await host.comment({ repo, number: 7 }, "/lookover review")).toBe("42");
    expect(asked.at(-1)).toMatchObject({ method: "POST", body: { body: "/lookover review" } });

    await expect(host.comment({ repo, number: 8 }, "On an issue.")).rejects.toMatchObject({
      failure: "not_found",
    });
    expect(asked.filter((a) => a.method === "POST")).toHaveLength(1);
  });

  test("GitHub's refusals, as HostErrors", async () => {
    const refused = (response: () => Response) =>
      github({ [`GET ${API}/pulls/7`]: response }).host.getChange({ repo, number: 7 });
    await expect(refused(() => json(401, { message: "Bad credentials" }))).rejects.toMatchObject({
      failure: "unauthorized",
    });
    await expect(
      refused(() =>
        json(
          403,
          { message: "API rate limit exceeded" },
          { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000" },
        ),
      ),
    ).rejects.toMatchObject({ failure: "rate_limited", retryAt: 2_000_000 });
    await expect(refused(() => json(429, {}, { "retry-after": "60" }))).rejects.toMatchObject({
      failure: "rate_limited",
      retryAt: 1_060_000,
    });
    await expect(refused(() => json(403, { message: "Resource not accessible" }))).rejects.toMatchObject({
      failure: "unauthorized",
    });
    await expect(refused(() => json(502, "Bad gateway"))).rejects.toMatchObject({ failure: "unavailable" });
    await expect(
      createAgentHost({ token: "t", fetch: () => Promise.reject(new Error("ECONNREFUSED")) }).getChange({
        repo,
        number: 7,
      }),
    ).rejects.toMatchObject({ failure: "unavailable" });
  });

  test("a commit GitHub doesn't have (its 422) is not found", async () => {
    const { host } = github({
      [`GET ${API}/commits/${sha}/check-runs?check_name=Lookover&filter=all&per_page=100`]: () =>
        json(422, { message: `No commit found for SHA: ${sha}` }),
    });
    await expect(host.checks(repo, sha, "lookover-spike-sasensi")).rejects.toMatchObject({
      failure: "not_found",
    });
  });

  test("Lookover's threads, read with GraphQL: the App's bot's roots holding a marker, every reply but a ghost's, oldest first", async () => {
    const asked: GraphqlRequest[] = [];
    const { host } = github({}, (request) => {
      asked.push(request);
      return json(200, {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  thread("PRRT_1", [
                    note(101, APP_BOT, finding("F1")),
                    note(102, OWNER, "Won't fix: the caller checks."),
                    note(103, null, "From an account deleted since."),
                    note(104, { ...APP_BOT, databaseId: 338297044 }, "Kept."),
                    note(105, { __typename: "Mannequin", login: "imported" }, "Imported."),
                  ]),
                  // An owner's comment holding a marker, another bot's, a marker-less one of the App's: no thread of Lookover's.
                  thread("PRRT_2", [note(201, OWNER, finding("F9"))]),
                  thread("PRRT_3", [
                    note(
                      301,
                      { __typename: "Bot", login: "github-actions", databaseId: 41898282 },
                      finding("F8"),
                    ),
                  ]),
                  thread("PRRT_4", [note(401, APP_BOT, "A comment of the App's with no marker.")]),
                  thread("PRRT_5", [note(501, APP_BOT, finding("F2"))], {
                    isResolved: true,
                    isOutdated: true,
                  }),
                ],
              },
            },
          },
        },
      });
    });

    const threads = await host.threads({ repo, number: 7 }, "lookover-spike-sasensi");
    expect(asked[0]?.variables).toEqual({
      owner: "sasensi",
      name: "lookover-sandbox",
      number: 7,
      after: null,
    });
    expect(asked[0]?.query).toContain("reviewThreads(first: 100, after: $after)");
    const owner = { id: 1234567, login: "sasensi", bot: false };
    const bot = { id: 338297044, login: "lookover-spike-sasensi[bot]", bot: true };
    expect(threads).toEqual([
      {
        commentId: 101,
        nodeId: "PRRC_101",
        url: "https://github.com/sasensi/lookover-sandbox/pull/7#discussion_r101",
        findingId: findingId("F1"),
        outdated: false,
        threadId: "PRRT_1",
        resolved: false,
        replies: [
          {
            commentId: 102,
            nodeId: "PRRC_102",
            author: owner,
            body: "Won't fix: the caller checks.",
            at: AT,
          },
          { commentId: 104, nodeId: "PRRC_104", author: bot, body: "Kept.", at: AT },
        ],
      },
      {
        commentId: 501,
        nodeId: "PRRC_501",
        url: "https://github.com/sasensi/lookover-sandbox/pull/7#discussion_r501",
        findingId: findingId("F2"),
        outdated: true,
        threadId: "PRRT_5",
        resolved: true,
        replies: [],
      },
    ]);
  });

  test("threads go on past 100, and so do a thread's comments", async () => {
    const asked: GraphqlRequest[] = [];
    const { host } = github({}, (request) => {
      asked.push(request);
      if (request.variables.id === "PRRT_2")
        return json(200, {
          data: {
            node: {
              comments: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [note(203, OWNER, "Third.")],
              },
            },
          },
        });
      const second = request.variables.after === "threads-1";
      return json(200, {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: !second, endCursor: second ? null : "threads-1" },
                nodes: second
                  ? [
                      thread("PRRT_2", [note(201, APP_BOT, finding("F2")), note(202, OWNER, "Second.")], {
                        more: "comments-1",
                      }),
                    ]
                  : [thread("PRRT_1", [note(101, APP_BOT, finding("F1"))])],
              },
            },
          },
        },
      });
    });
    const threads = await host.threads({ repo, number: 7 }, "lookover-spike-sasensi");
    expect(threads.map((t) => [t.threadId, t.replies.map((r) => r.body)])).toEqual([
      ["PRRT_1", []],
      ["PRRT_2", ["Second.", "Third."]],
    ]);
    expect(asked.map((a) => a.variables)).toEqual([
      { owner: "sasensi", name: "lookover-sandbox", number: 7, after: null },
      { owner: "sasensi", name: "lookover-sandbox", number: 7, after: "threads-1" },
      { id: "PRRT_2", after: "comments-1" },
    ]);
  });

  test("GraphQL's refusals, as HostErrors", async () => {
    const refused = (errors: unknown[], headers: Record<string, string> = {}) =>
      github({}, () =>
        json(200, { data: { repository: { pullRequest: null } }, errors }, headers),
      ).host.threads({ repo, number: 999_999 }, "lookover-spike-sasensi");
    await expect(
      refused([
        { type: "NOT_FOUND", message: "Could not resolve to a PullRequest with the number of 999999." },
      ]),
    ).rejects.toMatchObject({ failure: "not_found" });
    await expect(
      refused([{ type: "RATE_LIMITED", message: "API rate limit exceeded" }], {
        "x-ratelimit-reset": "2000",
      }),
    ).rejects.toMatchObject({ failure: "rate_limited", retryAt: 2_000_000 });
    await expect(refused([{ type: "FORBIDDEN", message: "Resource not accessible" }])).rejects.toMatchObject({
      failure: "unauthorized",
    });
    await expect(refused([{ message: "Something went wrong" }])).rejects.toMatchObject({
      failure: "invalid",
    });
    const badToken = github({}, () => json(401, { message: "Bad credentials" })).host;
    await expect(badToken.threads({ repo, number: 7 }, "lookover-spike-sasensi")).rejects.toMatchObject({
      failure: "unauthorized",
    });
  });

  test("a reply goes to the thread's replies endpoint, and one too large is never sent", async () => {
    const { asked, host } = github({
      [`POST ${API}/pulls/7/comments/101/replies`]: () => json(201, { id: 106 }),
    });
    expect(await host.reply({ repo, number: 7 }, 101, "Fixed in 5d9114c.")).toBe(106);
    expect(asked.at(-1)).toMatchObject({ method: "POST", body: { body: "Fixed in 5d9114c." } });
    await expect(host.reply({ repo, number: 7 }, 999, "Fixed.")).rejects.toMatchObject({
      failure: "not_found",
    });
    await expect(
      host.reply({ repo, number: 7 }, 101, "x".repeat(COMMENT_MAX_BYTES + 1)),
    ).rejects.toMatchObject({
      failure: "too_large",
    });
    expect(asked).toHaveLength(2);
  });

  test("resolving a thread: GraphQL's mutation; a token without the right is refused plainly, a thread that isn't one not found", async () => {
    const asked: GraphqlRequest[] = [];
    const answer = (request: GraphqlRequest) => {
      asked.push(request);
      if (request.variables.id === "PRRT_1")
        return json(200, { data: { resolveReviewThread: { thread: { id: "PRRT_1", isResolved: true } } } });
      if (request.variables.id === "PRRT_2")
        return json(200, {
          data: { resolveReviewThread: null },
          errors: [
            {
              type: "FORBIDDEN",
              message: "sasensi does not have the correct permissions to execute `ResolveReviewThread`",
            },
          ],
        });
      return json(200, {
        data: { resolveReviewThread: null },
        errors: [
          { type: "NOT_FOUND", message: "Could not resolve to a node with the global id of 'PRRT_9'" },
        ],
      });
    };
    const { host } = github({}, answer);
    await host.resolve("PRRT_1");
    expect(asked[0]?.query).toContain("resolveReviewThread(input: { threadId: $id })");
    expect(asked[0]?.variables).toEqual({ id: "PRRT_1" });
    const forbidden = host.resolve("PRRT_2");
    await expect(forbidden).rejects.toMatchObject({ failure: "unauthorized" });
    await expect(forbidden).rejects.toThrow(
      "GitHub refused to resolve thread PRRT_2: sasensi does not have the correct permissions to execute `ResolveReviewThread`",
    );
    await expect(host.resolve("PRRT_9")).rejects.toMatchObject({ failure: "not_found" });
  });
});

/** When every note of the GraphQL answers was written. */
const AT = "2026-10-10T08:00:00Z";
const OWNER = { __typename: "User", login: "sasensi", databaseId: 1234567 };
/** The App's bot as GraphQL names it: no `[bot]`. */
const APP_BOT = { __typename: "Bot", login: "lookover-spike-sasensi", databaseId: 338297044 };
const finding = (id: string) =>
  `**Off by one** · Should fix\n\n${FINDING_MARKER}${JSON.stringify({ v: 1, id })} -->`;

/** A review comment as GraphQL gives it. */
const note = (
  id: number,
  author: { __typename: string; login: string; databaseId?: number } | null,
  body: string,
) => ({
  id: `PRRC_${id}`,
  databaseId: id,
  url: `https://github.com/sasensi/lookover-sandbox/pull/7#discussion_r${id}`,
  body,
  createdAt: AT,
  author,
});

/** A review thread as GraphQL gives it; `more` is the cursor of comments past the first page. */
const thread = (
  id: string,
  comments: ReturnType<typeof note>[],
  {
    isResolved = false,
    isOutdated = false,
    more,
  }: { isResolved?: boolean; isOutdated?: boolean; more?: string } = {},
) => ({
  id,
  isResolved,
  isOutdated,
  comments: { pageInfo: { hasNextPage: more !== undefined, endCursor: more ?? null }, nodes: comments },
});
