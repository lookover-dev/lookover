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
 * The waits the host takes, fake: each pause and each time limit asked is recorded, nothing is slept. `expire` runs
 * out every time limit not yet cleared, its signal aborted as Bun aborts on a timeout; `open` counts those left.
 */
function fakeWaits() {
  const sleeps: number[] = [];
  const limits: number[] = [];
  const running = new Set<AbortController>();
  return {
    sleeps,
    limits,
    open: () => running.size,
    expire: () => {
      for (const controller of running)
        controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
    },
    sleep: (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    deadline: (ms: number) => {
      limits.push(ms);
      const controller = new AbortController();
      running.add(controller);
      return { signal: controller.signal, clear: () => void running.delete(controller) };
    },
  };
}

/**
 * What a try meets before GitHub answers it: an error thrown as Bun's `fetch` throws it, with its `code` (or, with
 * `cause`, its cause's), an answer of that status, no answer at all until the try's time limit runs out (`hang`), or
 * an answer whose body never ends until then (`hang-body`).
 */
type Failure = { code: string; cause?: boolean } | { status: number } | "hang" | "hang-body";

/** The try failing as `failure` says, on `signal`, `waits`' time limits run out by a hanging one. */
function failed(
  failure: Failure,
  signal: AbortSignal,
  waits: ReturnType<typeof fakeWaits>,
): Promise<Response> {
  if (failure === "hang")
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason));
      waits.expire();
    });
  if (failure === "hang-body") {
    const body = new ReadableStream(
      {
        start: (controller) => signal.addEventListener("abort", () => controller.error(signal.reason)),
        pull: () => {
          waits.expire();
          return new Promise<void>(() => {});
        },
      },
      { highWaterMark: 0 },
    );
    return Promise.resolve(new Response(body, { status: 200 }));
  }
  if ("status" in failure) return Promise.resolve(json(failure.status, { message: "Server Error" }));
  const coded = Object.assign(new Error(`${failure.code}: the connection failed`), { code: failure.code });
  return Promise.reject(
    failure.cause ? Object.assign(new TypeError("fetch failed"), { cause: coded }) : coded,
  );
}

/**
 * A GitHub that answers each address with what `routes` gives, its GraphQL endpoint with what `graphql` gives for
 * the request, and records what it was asked. The requests `which` picks (every one by default) meet `failures`
 * first, in order, one a request; the host's waits are fake.
 */
function github(
  routes: Record<string, () => Response>,
  graphql: (asked: GraphqlRequest) => Response = () => json(404, { message: "Not Found" }),
  failures: Failure[] = [],
  which: (init: RequestInit) => boolean = () => true,
) {
  const asked: Asked[] = [];
  const waits = fakeWaits();
  const left = [...failures];
  const fetch = (input: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    asked.push({
      url: input,
      method: init.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
      body: typeof init.body === "string" ? JSON.parse(init.body) : null,
    });
    const failure = which(init) ? left.shift() : undefined;
    if (failure !== undefined) return failed(failure, init.signal ?? new AbortController().signal, waits);
    if (input === GRAPHQL && init.method === "POST" && typeof init.body === "string")
      return Promise.resolve(graphql(graphqlRequest.parse(JSON.parse(init.body))));
    const route = routes[`${init.method ?? "GET"} ${input}`];
    return Promise.resolve(route ? route() : json(404, { message: "Not Found" }));
  };
  const host = createAgentHost({
    token: "gho_agent",
    fetch,
    now: () => 1_000_000,
    sleep: waits.sleep,
    deadline: waits.deadline,
  });
  return { asked, waits, host };
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
  external_id: `job-${id}@1234567`,
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

  test("the token's own account is GitHub's `GET /user`, its id and its login (ADR 0066)", async () => {
    // GitHub's answer trimmed to what is read; spike 20 recorded the owner's: `sasensi`, 11247504.
    const { asked, host } = github({
      "GET https://api.github.com/user": () =>
        json(200, { login: "sasensi", id: 11247504, type: "User", name: "Samuel" }),
    });
    expect(await host.account()).toEqual({ id: 11247504, login: "sasensi" });
    expect(asked.map((a) => [a.method, a.url, a.headers.authorization])).toEqual([
      ["GET", "https://api.github.com/user", "Bearer gho_agent"],
    ]);
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
            { ...run(15, "lookover-spike-sasensi", "completed", "skipped"), external_id: null },
          ],
        }),
    });
    const checks = await host.checks(repo, sha, "lookover-spike-sasensi");
    expect(checks.map((c) => [c.id, c.status, c.conclusion, c.externalId])).toEqual([
      ["10", "completed", { other: "cancelled" }, "job-10@1234567"],
      ["15", "completed", "skipped", ""],
      ["30", "in_progress", null, "job-30@1234567"],
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
    const { sleep, deadline } = fakeWaits();
    await expect(
      createAgentHost({
        token: "t",
        fetch: () => Promise.reject(new Error("ECONNREFUSED")),
        sleep,
        deadline,
      }).getChange({ repo, number: 7 }),
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

    const threads = await host.threads({ repo, number: 7 }, "lookover-spike-sasensi", ABSENT);
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

  test("the roots of the person the App posts as, holding a marker, are Lookover's too; another's never (ADR 0066)", async () => {
    const PERSON = { __typename: "User", login: "signed-in", databaseId: 11247504 };
    const { host } = github({}, () =>
      json(200, {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  thread("PRRT_1", [note(101, PERSON, finding("F1")), note(102, OWNER, "Fixed.")]),
                  thread("PRRT_2", [note(201, OWNER, finding("F9"))]),
                  thread("PRRT_3", [note(301, APP_BOT, finding("F2"))]),
                ],
              },
            },
          },
        },
      }),
    );
    const change = { repo, number: 7 };
    const roots = async (person: number) =>
      (await host.threads(change, "lookover-spike-sasensi", person)).map((t) => t.commentId);
    expect(await roots(11247504)).toEqual([101, 301]);
    expect(await roots(ABSENT)).toEqual([301]);
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
    const threads = await host.threads({ repo, number: 7 }, "lookover-spike-sasensi", ABSENT);
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
      ).host.threads({ repo, number: 999_999 }, "lookover-spike-sasensi", ABSENT);
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
    await expect(
      badToken.threads({ repo, number: 7 }, "lookover-spike-sasensi", ABSENT),
    ).rejects.toMatchObject({
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
/** A person the App posts as who wrote nothing on the change: its bot's roots alone are Lookover's. */
const ABSENT = 5_550_001;
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

// A brief network failure (ADR 0080): a read is tried 3 times in all, 1 s then 3 s apart; a write is tried again only
// when it can't have reached GitHub; each try has its time limit, 30 s for a read, 60 s for a write.
describe("a brief network failure", () => {
  const PULL = `GET ${API}/pulls/7`;
  const REPLY = `POST ${API}/pulls/7/comments/101/replies`;
  const pulls = { [PULL]: () => json(200, pull(7)) };
  const replies = { [REPLY]: () => json(201, { id: 106 }) };
  const isPost = (init: RequestInit) => init.method === "POST";
  const NO_THREADS = {
    data: {
      repository: {
        pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
      },
    },
  };

  test("a read that fails twice, a connection reset then GitHub's 502, is tried again 1 s then 3 s later, and answers", async () => {
    const { asked, waits, host } = github(pulls, undefined, [{ code: "ECONNRESET" }, { status: 502 }]);
    expect(await host.getChange({ repo, number: 7 })).toEqual({ number: 7, head: sha, fork: false });
    expect(asked).toHaveLength(3);
    expect(waits.sleeps).toEqual([1000, 3000]);
    expect(waits.limits).toEqual([30_000, 30_000, 30_000]);
    expect(waits.open()).toBe(0);
  });

  test("a read that keeps failing is unavailable after 3 tries, in the last failure's words; a last 502 is GitHub's answer", async () => {
    const broken = github(pulls, undefined, [
      { code: "ECONNRESET" },
      { status: 503 },
      { code: "ECONNRESET" },
    ]);
    await expect(broken.host.getChange({ repo, number: 7 })).rejects.toMatchObject({
      name: "HostError",
      failure: "unavailable",
      message: "GitHub could not be reached after 3 tries: ECONNRESET: the connection failed",
    });
    expect(broken.asked).toHaveLength(3);
    expect(broken.waits.sleeps).toEqual([1000, 3000]);

    const down = github(pulls, undefined, [{ status: 502 }, { status: 504 }, { status: 502 }]);
    await expect(down.host.getChange({ repo, number: 7 })).rejects.toMatchObject({
      failure: "unavailable",
      message: "GitHub answered GET /repos/sasensi/lookover-sandbox/pulls/7 with 502: Server Error",
    });
    expect(down.asked).toHaveLength(3);
  });

  test("a read that never answers ends on its time limit, is tried again, and is unavailable saying so", async () => {
    for (const hang of ["hang", "hang-body"] as const) {
      const { asked, waits, host } = github(pulls, undefined, [hang, hang, hang]);
      await expect(host.getChange({ repo, number: 7 })).rejects.toMatchObject({
        failure: "unavailable",
        message: "GitHub could not be reached after 3 tries: no answer within 30 s",
      });
      expect({ hang, asked: asked.length, limits: waits.limits, open: waits.open() }).toEqual({
        hang,
        asked: 3,
        limits: [30_000, 30_000, 30_000],
        open: 0,
      });
    }
  });

  test("a write that may have reached GitHub (a reset, a closed socket, its time limit, a 502) is sent once and fails", async () => {
    const cases: { failure: Failure; message: string }[] = [
      {
        failure: { code: "ECONNRESET" },
        message: "GitHub could not be reached: ECONNRESET: the connection failed",
      },
      {
        failure: { code: "ConnectionClosed", cause: true },
        message: "GitHub could not be reached: fetch failed",
      },
      { failure: "hang", message: "GitHub could not be reached: no answer within 60 s" },
      {
        failure: { status: 502 },
        message:
          "GitHub answered POST /repos/sasensi/lookover-sandbox/pulls/7/comments/101/replies with 502: Server Error",
      },
    ];
    for (const { failure, message } of cases) {
      const { asked, waits, host } = github(replies, undefined, [failure], isPost);
      const refused = await host.reply({ repo, number: 7 }, 101, "Fixed.").catch((error: unknown) => error);
      expect({
        failure,
        refused,
        asked: asked.length,
        sleeps: waits.sleeps,
        limits: waits.limits,
        open: waits.open(),
      }).toEqual({
        failure,
        refused: expect.objectContaining({ failure: "unavailable", message }),
        asked: 1,
        sleeps: [],
        limits: [60_000],
        open: 0,
      });
    }
  });

  test("a write that can't have reached GitHub (its certificate refused, the connection refused, no address) is sent again", async () => {
    const failures: Failure[] = [
      { code: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR" },
      { code: "ConnectionRefused" },
      { code: "ENOTFOUND", cause: true },
    ];
    for (const failure of failures) {
      const { asked, waits, host } = github(replies, undefined, [failure], isPost);
      expect(await host.reply({ repo, number: 7 }, 101, "Fixed.")).toBe(106);
      expect({ failure, asked: asked.length, sleeps: waits.sleeps }).toEqual({
        failure,
        asked: 2,
        sleeps: [1000],
      });
    }
  });

  test("a GraphQL query is tried again like a read; the resolving mutation after a reset is sent once", async () => {
    const query = github({}, () => json(200, NO_THREADS), [{ code: "ECONNRESET" }]);
    expect(await query.host.threads({ repo, number: 7 }, "lookover-spike-sasensi", ABSENT)).toEqual([]);
    expect(query.asked).toHaveLength(2);
    expect(query.waits.limits).toEqual([30_000, 30_000]);

    const resolved = () => json(200, { data: { resolveReviewThread: { thread: { isResolved: true } } } });
    const mutation = github({}, resolved, [{ code: "ECONNRESET" }]);
    await expect(mutation.host.resolve("PRRT_1")).rejects.toMatchObject({ failure: "unavailable" });
    expect(mutation.asked).toHaveLength(1);
    expect(mutation.waits.limits).toEqual([60_000]);
  });

  test("GitHub's limits and refusals of a read are never tried again", async () => {
    const cases: { status: number; headers?: Record<string, string>; failure: string }[] = [
      { status: 429, headers: { "retry-after": "60" }, failure: "rate_limited" },
      {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000" },
        failure: "rate_limited",
      },
      { status: 401, failure: "unauthorized" },
      { status: 404, failure: "not_found" },
      { status: 422, failure: "unavailable" },
      // A gateway failure that says when to ask again is a limit: the wait is GitHub's, not ours.
      { status: 503, headers: { "retry-after": "60" }, failure: "unavailable" },
      { status: 502, headers: { "x-ratelimit-remaining": "0" }, failure: "unavailable" },
    ];
    for (const { status, headers, failure } of cases) {
      const { asked, waits, host } = github({ [PULL]: () => json(status, { message: "Refused" }, headers) });
      const refused = await host.getChange({ repo, number: 7 }).catch((error: unknown) => error);
      expect({ status, refused, asked: asked.length, sleeps: waits.sleeps }).toEqual({
        status,
        refused: expect.objectContaining({ failure }),
        asked: 1,
        sleeps: [],
      });
    }
  });
});
