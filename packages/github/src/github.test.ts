import { expect, test } from "bun:test";
import {
  COMMENT_MAX_BYTES,
  commitSha,
  FINDING_MARKER,
  findingId,
  type HostChange,
  HostError,
  type HostFailure,
  REVIEW_MARKER,
  SUMMARY_MARKER,
} from "@lookover/contracts";
import { z } from "zod";
import {
  APP,
  AT,
  acceptedJwt,
  type Call,
  HOUR,
  iso,
  type Route,
  stubGitHub,
  verifiedClaims,
  withToken,
} from "./github.test-support.ts";
import { createGitHub } from "./index.ts";

/** What a GraphQL request sent, read as GitHub reads it. */
const graphqlSent = z.object({
  query: z.string(),
  variables: z.object({
    ids: z.array(z.string()).optional(),
    id: z.string().optional(),
    classifier: z.string().optional(),
  }),
});

// A sandbox and Lookover's own, under two accounts, each with its own installation (ADR 0041, ADR 0060).
const SANDBOX_REPO = { owner: "sasensi", name: "lookover-sandbox" };
const OWN_REPO = { owner: "lookover-dev", name: "lookover-private" };
const LISTED = [SANDBOX_REPO, OWN_REPO];

test("a repository the list doesn't hold is refused by every call, before any request", async () => {
  const api = stubGitHub();
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch });
  const refused = {
    failure: "not_found",
    message:
      "sasensi/elsewhere is not on the list of repositories Lookover may use: sasensi/lookover-sandbox, lookover-dev/lookover-private",
  };
  const other = { owner: "sasensi", name: "elsewhere" };
  const change = { repo: other, number: 1 };
  const sha = commitSha("126ba1dae30bd5bb918afe71a1ecd88ff9744fb1");
  const output = { title: "t", summary: "s", text: "x" };
  const calls = [
    github.intake.listOpenChanges(other),
    github.intake.getChange(other, 1),
    github.intake.fetchSpec(other),
    github.writer.createCheck(other, sha, "queued", output, "job-1"),
    github.writer.updateCheck(other, "1", "in_progress", output),
    github.writer.completeCheck(other, "1", "success", output),
    github.writer.publishReview(change, { sha, body: "b", comments: [] }),
    github.writer.upsertSummary(change, `${SUMMARY_MARKER}\nx`),
    github.writer.reply(change, 1, "Kept."),
    github.writer.minimize(other, "PRRC_1", "resolved"),
    github.intake.threads(change),
    github.view(change),
    github.identity(other),
  ];
  for (const call of calls) await expect(call).rejects.toMatchObject(refused);
  // The same name under another owner is another repository.
  await expect(
    github.intake.listOpenChanges({ owner: "someone", name: "lookover-private" }),
  ).rejects.toMatchObject({
    failure: "not_found",
  });
  expect(api.calls).toEqual([]);
});

test("every secret the adapter holds is given to `secret` as it holds it: the App's key, each JWT, each token", async () => {
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    listing("ghs_one"),
  );
  const secrets: string[] = [];
  const github = createGitHub({
    app: APP,
    repositories: LISTED,
    fetch: api.fetch,
    clock: { now: () => AT },
    secret: (value) => secrets.push(value),
  });
  expect(secrets).toEqual([APP.privateKey]);
  await github.intake.listOpenChanges(SANDBOX_REPO);
  // Each JWT sent is given before it leaves; the token as it is bought.
  const jwts = api.calls
    .filter((c) => verifiedClaims(c.authorization) !== null)
    .map((c) => c.authorization.split(" ")[1]);
  expect(jwts.length).toBeGreaterThan(0);
  for (const jwt of jwts) expect(secrets).toContain(jwt ?? "");
  expect(secrets).toContain("ghs_one");
});

test("a listed repository written in another case is the same one: GitHub's names ignore case", async () => {
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    listing("ghs_one"),
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  const upper = { owner: "Sasensi", name: "Lookover-Sandbox" };
  // GitHub answers the same repository; the stub knows only the lower-case path, which the adapter keeps.
  await expect(github.intake.listOpenChanges(upper)).rejects.not.toThrow("is not on the list");
});

test("every listed repository is served, each with its own installation's token", async () => {
  const own = "/repos/lookover-dev/lookover-private";
  const ownPull = {
    ...PULL,
    number: 40,
    html_url: "https://github.com/lookover-dev/lookover-private/pull/40",
  };
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    listing("ghs_one"),
    (call) => {
      if (call.path === `${own}/installation` && acceptedJwt(call.authorization, AT))
        return { status: 200, body: { id: OWN_INSTALLATION } };
      if (call.method === "POST" && call.path === `/app/installations/${OWN_INSTALLATION}/access_tokens`)
        return { status: 201, body: { token: "ghs_own", expires_at: iso(AT + HOUR) } };
      return undefined;
    },
    withToken("ghs_own", (call) =>
      call.path === `${own}/pulls?state=open&per_page=100` ? { status: 200, body: [ownPull] } : undefined,
    ),
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  expect(await github.intake.listOpenChanges(SANDBOX_REPO)).toEqual({
    unchanged: false,
    items: [CHANGE],
    at: AT,
  });
  expect((await github.intake.listOpenChanges(OWN_REPO)).items).toEqual([
    { ...CHANGE, number: 40, url: "https://github.com/lookover-dev/lookover-private/pull/40" },
  ]);
  expect(api.calls.at(-2)?.body).toEqual({ repositories: ["lookover-private"] });
});

test("a listed repository the App isn't installed on says to add it to the installation", async () => {
  // GitHub answers 404 for a repository outside the App's installation.
  const api = stubGitHub(signIn(() => AT, "ghs_one"));
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  await expect(github.identity(OWN_REPO)).rejects.toMatchObject({
    failure: "not_found",
    message:
      "The GitHub App is not installed on lookover-dev/lookover-private: add the repository to the App's installation on GitHub, then try again.",
  });
  await expect(github.intake.listOpenChanges(OWN_REPO)).rejects.toMatchObject({ failure: "not_found" });
  // The fetch spec, which reads the default branch with a fetch's token, asks for the installation the same way.
  await expect(github.intake.fetchSpec(OWN_REPO)).rejects.toThrow(
    "is not installed on lookover-dev/lookover-private",
  );
});

test("a private key that can't sign is refused as unauthorized, before any request", async () => {
  const api = stubGitHub();
  const app = {
    id: 5202093,
    privateKey: "-----BEGIN RSA PRIVATE KEY-----\nnot a key\n-----END RSA PRIVATE KEY-----\n",
  };
  const github = createGitHub({ app, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  const refused = {
    failure: "unauthorized",
    message: expect.stringMatching(/^The GitHub App's private key can't sign/),
  };
  await expect(github.intake.listOpenChanges(SANDBOX_REPO)).rejects.toMatchObject(refused);
  await expect(github.identity(SANDBOX_REPO)).rejects.toMatchObject(refused);
  expect(api.calls).toEqual([]);
});

const OWN_INSTALLATION = 168269099;
const SANDBOX = "/repos/sasensi/lookover-sandbox";
const INSTALLATION = 168269016;
/**
 * Sign-in as GitHub answers it, the time read from `now`: the App's installation on the sandbox, then the
 * tokens for it, one per request, each good for an hour from when it was bought.
 */
function signIn(now: () => number, ...tokens: string[]): Route {
  const queue = [...tokens];
  return (call) => {
    if (call.path === `${SANDBOX}/installation`) {
      return acceptedJwt(call.authorization, now())
        ? { status: 200, body: { id: INSTALLATION } }
        : { status: 401 };
    }
    if (call.method === "POST" && call.path === `/app/installations/${INSTALLATION}/access_tokens`) {
      if (!acceptedJwt(call.authorization, now())) return { status: 401 };
      const token = queue.shift();
      return token ? { status: 201, body: { token, expires_at: iso(now() + HOUR) } } : { status: 500 };
    }
    return undefined;
  };
}

const tokensBought = (calls: Call[]) => calls.filter((c) => c.path.endsWith("/access_tokens")).length;

const PULL = {
  number: 7,
  title: "Add unpaid filter and rewrite total",
  html_url: "https://github.com/sasensi/lookover-sandbox/pull/7",
  user: { login: "sasensi", id: 11247504, type: "User" },
  draft: false,
  state: "open",
  head: {
    ref: "live/2026-10-06",
    sha: "126ba1dae30bd5bb918afe71a1ecd88ff9744fb1",
    repo: { id: 1406309884, full_name: "sasensi/lookover-sandbox", fork: false },
  },
  base: {
    ref: "main",
    sha: "d6b858a68addf47ed12faffe1f4834e9c3faef6f",
    repo: { id: 1406309884, full_name: "sasensi/lookover-sandbox", fork: false },
  },
};

const CHANGE: HostChange = {
  host: "github",
  number: 7,
  title: "Add unpaid filter and rewrite total",
  url: "https://github.com/sasensi/lookover-sandbox/pull/7",
  author: { login: "sasensi", id: 11247504 },
  draft: false,
  fork: false,
  head: { ref: "live/2026-10-06", sha: commitSha("126ba1dae30bd5bb918afe71a1ecd88ff9744fb1") },
  base: { ref: "main", sha: commitSha("d6b858a68addf47ed12faffe1f4834e9c3faef6f") },
};

const listing = (token: string): Route =>
  withToken(token, (call) =>
    call.path === `${SANDBOX}/pulls?state=open&per_page=100` ? { status: 200, body: [PULL] } : undefined,
  );

test("built with no list, no repository is refused: each is served by its installation, at the API address given", async () => {
  const api = stubGitHub((call) => {
    if (call.path === "/api/v3/repos/sasensi/ledger/installation" && acceptedJwt(call.authorization, AT))
      return { status: 200, body: { id: OWN_INSTALLATION } };
    if (call.method === "POST" && call.path === `/api/v3/app/installations/${OWN_INSTALLATION}/access_tokens`)
      return { status: 201, body: { token: "ghs_ledger", expires_at: iso(AT + HOUR) } };
    if (call.path === "/api/v3/repos/sasensi/ledger/pulls?state=open&per_page=100")
      return { status: 200, body: [] };
    return undefined;
  });
  const github = createGitHub({
    app: APP,
    api: "http://github.test/api/v3",
    fetch: api.fetch,
    clock: { now: () => AT },
  });
  expect((await github.intake.listOpenChanges({ owner: "sasensi", name: "ledger" })).items).toEqual([]);
  expect(new Set(api.calls.map((c) => c.origin))).toEqual(new Set(["http://github.test"]));
});

test("an installation GitHub no longer has is uninstalled and forgotten: a reinstall buys a token for the new one", async () => {
  const REINSTALLED = 170000003;
  let installed = INSTALLATION;
  const api = stubGitHub((call) => {
    if (!acceptedJwt(call.authorization, AT)) return undefined;
    if (call.path === `${SANDBOX}/installation`) return { status: 200, body: { id: installed } };
    if (call.method === "POST" && call.path === `/app/installations/${REINSTALLED}/access_tokens`)
      return { status: 201, body: { token: "ghs_again", expires_at: iso(AT + HOUR) } };
    return undefined;
  }, listing("ghs_again"));
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  // The App was uninstalled: its installation's token is refused as not found.
  const refused = await github.intake.listOpenChanges(SANDBOX_REPO).catch((error: unknown) => error);
  expect(refused).toMatchObject({
    failure: "not_found",
    connectionCause: { kind: "uninstalled", suspended: false },
  });
  // Installed again, under a new id: the next call finds it, with no restart.
  installed = REINSTALLED;
  expect((await github.intake.listOpenChanges(SANDBOX_REPO)).items).toEqual([CHANGE]);
});

test("a suspended installation's token is refused as uninstalled and suspended", async () => {
  const api = stubGitHub((call) => {
    if (call.path === `${SANDBOX}/installation`) return { status: 200, body: { id: INSTALLATION } };
    if (call.path.endsWith("/access_tokens"))
      return { status: 403, body: { message: "This installation has been suspended" } };
    return undefined;
  });
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  await expect(github.intake.listOpenChanges(SANDBOX_REPO)).rejects.toMatchObject({
    failure: "unauthorized",
    connectionCause: { kind: "uninstalled", suspended: true },
  });
});

test("a JWT refused for a clock that is off names the clock", async () => {
  const api = stubGitHub(() => ({
    status: 401,
    body: { message: "'Expiration time' claim ('exp') is too far in the future" },
  }));
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  await expect(github.identity(SANDBOX_REPO)).rejects.toMatchObject({
    failure: "unauthorized",
    connectionCause: { kind: "key-refused", why: "clock" },
  });
});

test("a commit that isn't a sha in GitHub's answer is a payload of a shape it doesn't know: unavailable", async () => {
  const odd = { ...PULL, head: { ref: "live/2026-10-06", sha: "not-a-sha" } };
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    withToken("ghs_one", (call) =>
      call.path === `${SANDBOX}/pulls?state=open&per_page=100` ? { status: 200, body: [odd] } : undefined,
    ),
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  await expect(github.intake.listOpenChanges(SANDBOX_REPO)).rejects.toMatchObject({
    failure: "unavailable",
    message: expect.stringContaining("0.head.sha"),
  });
});

test("an answer whose body breaks off while it is read is unavailable, a HostError like every refusal", async () => {
  const api = stubGitHub(signIn(() => AT, "ghs_one"));
  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    if (!new URL(input).pathname.endsWith("/pulls")) return api.fetch(input, init);
    const broken = new ReadableStream({
      start: (controller) => controller.error(new Error("connection reset")),
    });
    return new Response(broken, { status: 200 });
  };
  const github = createGitHub({ app: APP, repositories: LISTED, fetch, clock: { now: () => AT } });
  await expect(github.intake.listOpenChanges(SANDBOX_REPO)).rejects.toMatchObject({
    name: "HostError",
    failure: "unavailable",
    message: expect.stringContaining("connection reset"),
  });
});

test("the open changes are listed with the installation token the JWT bought", async () => {
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    listing("ghs_one"),
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  expect(await github.intake.listOpenChanges(SANDBOX_REPO)).toEqual({
    unchanged: false,
    items: [CHANGE],
    at: AT,
  });
});

// A fork's pull request as GitHub gives it: the head in the fork, the base here. The fork's own `fork` flag
// says only that the fork is one, not that the pull request comes from it. These fork payloads are written by hand
// in GitHub's documented shape, not recorded: the sandbox can't be forked by its owner, so the fork's id is invented.
const FORK_PULL = {
  ...PULL,
  number: 8,
  head: {
    ...PULL.head,
    ref: "fix-total",
    repo: { id: 1106400001, full_name: "mira/lookover-sandbox", fork: true },
  },
};
// Its fork deleted since: GitHub gives no head repository at all.
const GONE_FORK_PULL = { ...PULL, number: 9, head: { ...PULL.head, ref: "fix-total", repo: null } };
// A pull request inside a fork that is itself one: both repositories are the fork, so it comes from no other.
const IN_A_FORK_PULL = {
  ...PULL,
  number: 10,
  head: { ...PULL.head, repo: { id: 1106400001, full_name: "mira/lookover-sandbox", fork: true } },
  base: { ...PULL.base, repo: { id: 1106400001, full_name: "mira/lookover-sandbox", fork: true } },
};

test("a pull request is a fork's when its head repository isn't its base's, or is gone, by id", async () => {
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    withToken("ghs_one", (call) =>
      call.path === `${SANDBOX}/pulls?state=open&per_page=100`
        ? { status: 200, body: [PULL, FORK_PULL, GONE_FORK_PULL, IN_A_FORK_PULL] }
        : undefined,
    ),
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  const { items } = await github.intake.listOpenChanges(SANDBOX_REPO);
  expect(items.map((c) => [c.number, c.fork])).toEqual([
    [7, false],
    [8, true],
    [9, true],
    [10, false],
  ]);
  expect(items[1]).toEqual({ ...CHANGE, number: 8, fork: true, head: { ...CHANGE.head, ref: "fix-total" } });
});

test("one fork's pull request read by its number is a fork's; its fork gone, still", async () => {
  const one: Route = withToken("ghs_one", (call) => {
    if (call.path === `${SANDBOX}/pulls/8`) return { status: 200, body: FORK_PULL };
    if (call.path === `${SANDBOX}/pulls/9`) return { status: 200, body: GONE_FORK_PULL };
    return undefined;
  });
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    one,
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  expect((await github.intake.getChange(SANDBOX_REPO, 8)).fork).toBe(true);
  expect((await github.intake.getChange(SANDBOX_REPO, 9)).fork).toBe(true);
});

test("a pull request whose base names no repository is a shape Lookover doesn't know", async () => {
  const odd = { ...PULL, base: { ...PULL.base, repo: null } };
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    withToken("ghs_one", (call) =>
      call.path === `${SANDBOX}/pulls/7` ? { status: 200, body: odd } : undefined,
    ),
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  await expect(github.intake.getChange(SANDBOX_REPO, 7)).rejects.toMatchObject({
    failure: "unavailable",
    message: expect.stringContaining("base.repo"),
  });
});

test("the token is kept while it lasts and renewed before it expires", async () => {
  let now = AT;
  const api = stubGitHub(
    signIn(() => now, "ghs_one", "ghs_two"),
    listing("ghs_one"),
    listing("ghs_two"),
  );
  const github = createGitHub({
    app: APP,
    repositories: LISTED,
    fetch: api.fetch,
    clock: { now: () => now },
  });
  await github.intake.listOpenChanges(SANDBOX_REPO);
  now = AT + 30 * 60_000;
  await github.intake.listOpenChanges(SANDBOX_REPO);
  expect(tokensBought(api.calls)).toBe(1);
  // Five minutes before the hour is up, the next call buys a new token first.
  now = AT + 56 * 60_000;
  await github.intake.listOpenChanges(SANDBOX_REPO);
  expect(tokensBought(api.calls)).toBe(2);
  expect(api.calls.at(-1)?.authorization).toBe("Bearer ghs_two");
});

test("a token GitHub no longer takes is bought again once, and the call made again with the new one", async () => {
  const revoked: Route = withToken("ghs_one", () => ({ status: 401, body: { message: "Bad credentials" } }));
  const api = stubGitHub(
    signIn(() => AT, "ghs_one", "ghs_two"),
    revoked,
    listing("ghs_two"),
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  expect(await github.intake.listOpenChanges(SANDBOX_REPO)).toEqual({
    unchanged: false,
    items: [CHANGE],
    at: AT,
  });
  expect(tokensBought(api.calls)).toBe(2);
});

test("a token refused because the App was uninstalled says so: buying another is what tells it", async () => {
  let installed = true;
  // Uninstalled: GitHub refuses the token it sold as any token it doesn't know, and sells no other.
  const uninstalled: Route = (call) => {
    if (installed) return undefined;
    if (call.path.endsWith("/access_tokens")) return { status: 404, body: { message: "Not Found" } };
    if (call.authorization === "Bearer ghs_one") return { status: 401, body: { message: "Bad credentials" } };
    return undefined;
  };
  const api = stubGitHub(
    uninstalled,
    signIn(() => AT, "ghs_one"),
    listing("ghs_one"),
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  await github.intake.listOpenChanges(SANDBOX_REPO);
  installed = false;
  await expect(github.intake.listOpenChanges(SANDBOX_REPO)).rejects.toMatchObject({
    failure: "not_found",
    connectionCause: { kind: "uninstalled", suspended: false },
  });
  expect(tokensBought(api.calls)).toBe(2);
});

test("an act a token is refused (403) is never the key: the installation's grant refuses it", async () => {
  const api = stubGitHub(
    signIn(() => AT, "ghs_one", "ghs_two"),
    withToken("ghs_one", () => ({
      status: 403,
      body: { message: "Resource not accessible by integration" },
    })),
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  await expect(github.intake.listOpenChanges(SANDBOX_REPO)).rejects.toMatchObject({
    failure: "unauthorized",
    connectionCause: { kind: "uninstalled", suspended: true },
  });
  // Not bought again for a 403: the next call does, as it does for any token refused.
  expect(tokensBought(api.calls)).toBe(1);
});

const RATE = { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4999", "x-ratelimit-used": "1" };

test("one change is read; a number that is none is not found; the rate-limit headers are read", async () => {
  const one: Route = withToken("ghs_one", (call) =>
    call.path === `${SANDBOX}/pulls/7`
      ? {
          status: 200,
          body: PULL,
          headers: { ...RATE, "x-ratelimit-reset": "1791720000", "x-ratelimit-resource": "core" },
        }
      : undefined,
  );
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    one,
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  expect(github.rateLimit()).toBeNull();
  expect(await github.intake.getChange(SANDBOX_REPO, 7)).toEqual(CHANGE);
  expect(github.rateLimit()).toEqual({
    limit: 5000,
    remaining: 4999,
    used: 1,
    resetAt: 1_791_720_000_000,
    resource: "core",
  });
  await expect(github.intake.getChange(SANDBOX_REPO, 999_999_999)).rejects.toMatchObject({
    failure: "not_found",
  });
});

test("GitHub asking to wait is a typed error", async () => {
  const exhausted: Route = withToken("ghs_one", () => ({
    status: 403,
    body: { message: "API rate limit exceeded" },
    headers: { ...RATE, "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1791720000" },
  }));
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    exhausted,
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  // The primary limit spent: wait until its reset, which GitHub gives in seconds since the Unix epoch.
  await expect(github.intake.getChange(SANDBOX_REPO, 7)).rejects.toMatchObject({
    failure: "rate_limited",
    retryAt: 1_791_720_000_000,
  });
});

test("a secondary limit's retry-after says when to ask again, counted from now, before the primary reset", async () => {
  const slowDown: Route = withToken("ghs_one", () => ({
    status: 403,
    body: { message: "You have exceeded a secondary rate limit." },
    headers: { ...RATE, "retry-after": "60", "x-ratelimit-reset": "1791720000" },
  }));
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    slowDown,
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  await expect(github.intake.listOpenChanges(SANDBOX_REPO)).rejects.toMatchObject({
    failure: "rate_limited",
    retryAt: AT + 60_000,
  });
});

test("a 429 that says nothing of when is rate-limited, with no time to retry at", async () => {
  const tooMany: Route = withToken("ghs_one", () => ({ status: 429, headers: { "retry-after": "soon" } }));
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    tooMany,
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  const refused = await github.intake.getChange(SANDBOX_REPO, 7).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(HostError);
  expect(refused).toMatchObject({ failure: "rate_limited", retryAt: undefined });
});

/** The sandbox as GitHub answers it to `token`, its default branch named `branch()` at the time of asking. */
const defaultBranchOf = (token: string, branch: () => string): Route =>
  withToken(token, (call) =>
    call.path === SANDBOX
      ? {
          status: 200,
          body: { id: 1406309884, full_name: "sasensi/lookover-sandbox", default_branch: branch() },
        }
      : undefined,
  );

test("the fetch spec keeps the token out of the clone URL, gives it in GitHub's form and asks only to read the contents", async () => {
  const api = stubGitHub(
    signIn(() => AT, "ghs_fetch"),
    defaultBranchOf("ghs_fetch", () => "main"),
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  const spec = await github.intake.fetchSpec(SANDBOX_REPO);
  expect(spec.cloneUrl).toBe("https://github.com/sasensi/lookover-sandbox.git");
  expect(spec.cloneUrl).not.toContain("ghs_fetch");
  expect(spec.refspecs).toEqual(["+refs/heads/*:refs/heads/*", "+refs/pull/*/head:refs/pull/*/head"]);
  expect(await spec.credentials()).toEqual({ username: "x-access-token", password: "ghs_fetch" });
  // One token for the fetch, read-only: the default branch is read with it too.
  expect(tokensBought(api.calls)).toBe(1);
  expect(api.calls.find((c) => c.path.endsWith("/access_tokens"))?.body).toEqual({
    repositories: ["lookover-sandbox"],
    permissions: { contents: "read", metadata: "read" },
  });
});

test("the fetch spec names the default branch as GitHub names it at each fetch: a rename is followed", async () => {
  let branch = "main";
  const api = stubGitHub(
    signIn(() => AT, "ghs_fetch"),
    defaultBranchOf("ghs_fetch", () => branch),
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  expect((await github.intake.fetchSpec(SANDBOX_REPO)).defaultBranch).toBe("main");
  branch = "trunk";
  expect((await github.intake.fetchSpec(SANDBOX_REPO)).defaultBranch).toBe("trunk");
  expect(api.calls.filter((c) => c.path === SANDBOX).map((c) => c.authorization)).toEqual([
    "Bearer ghs_fetch",
    "Bearer ghs_fetch",
  ]);
});

test("a repository answer with no default branch is a shape Lookover doesn't know", async () => {
  const api = stubGitHub(
    signIn(() => AT, "ghs_fetch"),
    withToken("ghs_fetch", (call) =>
      call.path === SANDBOX ? { status: 200, body: { id: 1406309884 } } : undefined,
    ),
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  await expect(github.intake.fetchSpec(SANDBOX_REPO)).rejects.toMatchObject({
    failure: "unavailable",
    message: expect.stringContaining("default_branch"),
  });
});

const SHA = commitSha("126ba1dae30bd5bb918afe71a1ecd88ff9744fb1");
const RUNNING = { title: "Reviewing", summary: "Round 1 is running.", text: "Lookover is reading the diff." };
const DONE = { title: "No blocking finding", summary: "Round 1: 0 open.", text: "<!-- result -->" };

/** Check runs as GitHub keeps them: created in progress, completed by a patch. */
const checks: Route = withToken("ghs_one", (call) => {
  if (call.method === "POST" && call.path === `${SANDBOX}/check-runs`)
    return { status: 201, body: { id: 111954805720, ...(typeof call.body === "object" ? call.body : {}) } };
  if (call.method === "PATCH" && call.path === `${SANDBOX}/check-runs/111954805720`)
    return { status: 200, body: { id: 111954805720 } };
  return undefined;
});

test("the check is created in progress on the commit, then completed with its conclusion", async () => {
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    checks,
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  const id = await github.writer.createCheck(SANDBOX_REPO, SHA, "in_progress", RUNNING, "job-1");
  expect(id).toBe("111954805720");
  expect(api.calls.at(-1)?.body).toEqual({
    name: "Lookover",
    head_sha: "126ba1dae30bd5bb918afe71a1ecd88ff9744fb1",
    status: "in_progress",
    output: RUNNING,
    // The job's id: the check is found by it after a restart (ADR 0044).
    external_id: "job-1",
  });
  await github.writer.completeCheck(SANDBOX_REPO, id, "success", DONE);
  expect(api.calls.at(-1)).toMatchObject({
    method: "PATCH",
    path: `${SANDBOX}/check-runs/111954805720`,
    body: { status: "completed", conclusion: "success", output: DONE },
  });
});

test("a check created queued is patched with its status and output, then completed skipped", async () => {
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    checks,
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  const waiting = { title: "Waiting for its turn", summary: "Queued.", text: "It starts by itself." };
  const id = await github.writer.createCheck(SANDBOX_REPO, SHA, "queued", waiting, "job-1");
  expect(api.calls.at(-1)?.body).toEqual({
    name: "Lookover",
    head_sha: "126ba1dae30bd5bb918afe71a1ecd88ff9744fb1",
    status: "queued",
    output: waiting,
    external_id: "job-1",
  });
  await github.writer.updateCheck(SANDBOX_REPO, id, "in_progress", RUNNING);
  expect(api.calls.at(-1)).toEqual(
    expect.objectContaining({
      method: "PATCH",
      path: `${SANDBOX}/check-runs/111954805720`,
      body: { status: "in_progress", output: RUNNING },
    }),
  );
  await github.writer.completeCheck(SANDBOX_REPO, id, "skipped", DONE);
  expect(api.calls.at(-1)).toMatchObject({
    method: "PATCH",
    body: { status: "completed", conclusion: "skipped", output: DONE },
  });
});

test("a check output over the byte limit is refused before anything is sent", async () => {
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    checks,
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  const id = await github.writer.createCheck(SANDBOX_REPO, SHA, "in_progress", RUNNING, "job-1");
  const sent = api.calls.length;
  // 32,768 two-byte characters: under the limit in characters, over it in bytes.
  const text = "é".repeat(32_768);
  const tooBig = { title: "Too big", summary: "Round 1: 1 open.", text };
  await expect(github.writer.completeCheck(SANDBOX_REPO, id, "neutral", tooBig)).rejects.toMatchObject({
    failure: "too_large",
  });
  await expect(github.writer.createCheck(SANDBOX_REPO, SHA, "queued", tooBig, "job-1")).rejects.toMatchObject(
    {
      failure: "too_large",
    },
  );
  await expect(github.writer.updateCheck(SANDBOX_REPO, id, "queued", tooBig)).rejects.toMatchObject({
    failure: "too_large",
  });
  expect(api.calls.length).toBe(sent);
});

const CHANGE_REF = { repo: SANDBOX_REPO, number: 7 };

/** Reviews as GitHub takes them: line 1 is outside the only hunk, and the 422 doesn't say which comment. */
const reviews: Route = withToken("ghs_one", (call) => {
  if (call.method !== "POST" || call.path !== `${SANDBOX}/pulls/7/reviews`) return undefined;
  const body = typeof call.body === "object" && call.body !== null ? call.body : {};
  const comments: unknown[] = "comments" in body && Array.isArray(body.comments) ? body.comments : [];
  const offDiff = comments.some((c) => typeof c === "object" && c !== null && "line" in c && c.line === 1);
  return offDiff
    ? { status: 422, body: { message: "Unprocessable Entity", errors: ["Line could not be resolved"] } }
    : { status: 200, body: { id: 3528111001 } };
});

test("a review posts its top comment and its inline comments together, sides as GitHub names them", async () => {
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    reviews,
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  const review = {
    sha: SHA,
    body: "4 findings.",
    comments: [
      { path: "src/invoices.ts", side: "head" as const, line: 12, endLine: null, body: "Off by one." },
      {
        path: "src/invoices.ts",
        side: "base" as const,
        line: 9,
        endLine: null,
        body: "Was this on purpose?",
      },
      { path: "src/invoices.ts", side: "head" as const, line: 16, endLine: 18, body: "Never ends on a 4xx." },
      { path: "src/invoices.ts", side: "base" as const, line: 7, endLine: 8, body: "Both checks went." },
    ],
  };
  expect(await github.writer.publishReview(CHANGE_REF, review)).toBe("3528111001");
  expect(api.calls.at(-1)?.body).toEqual({
    commit_id: "126ba1dae30bd5bb918afe71a1ecd88ff9744fb1",
    event: "COMMENT",
    body: "4 findings.",
    comments: [
      { path: "src/invoices.ts", side: "RIGHT", line: 12, body: "Off by one." },
      { path: "src/invoices.ts", side: "LEFT", line: 9, body: "Was this on purpose?" },
      // A range: GitHub's `line` is its last line, `start_line` its first, on the same side.
      {
        path: "src/invoices.ts",
        side: "RIGHT",
        start_side: "RIGHT",
        start_line: 16,
        line: 18,
        body: "Never ends on a 4xx.",
      },
      // A range of removed lines: both ends on LEFT.
      {
        path: "src/invoices.ts",
        side: "LEFT",
        start_side: "LEFT",
        start_line: 7,
        line: 8,
        body: "Both checks went.",
      },
    ],
  });
});

test("one comment GitHub can't place fails the whole review as unplaceable", async () => {
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    reviews,
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  const review = {
    sha: SHA,
    body: "2 findings.",
    comments: [
      { path: "src/invoices.ts", side: "head" as const, line: 12, endLine: null, body: "Fine here." },
      { path: "src/invoices.ts", side: "head" as const, line: 1, endLine: null, body: "Not on the diff." },
    ],
  };
  await expect(github.writer.publishReview(CHANGE_REF, review)).rejects.toMatchObject({
    failure: "unplaceable_comment",
  });
});

/** A review GitHub refuses with `status`, and its words: its `message` and its `errors`, as it sends them. */
const refusingReviews = (status: number, message: string, errors: unknown[] = []): Route =>
  withToken("ghs_one", (call) =>
    call.method === "POST" && call.path === `${SANDBOX}/pulls/7/reviews`
      ? { status, body: { message, errors } }
      : undefined,
  );

const A_REVIEW = {
  sha: SHA,
  body: "1 finding.",
  comments: [
    { path: "src/invoices.ts", side: "head" as const, line: 12, endLine: null, body: "Off by one." },
  ],
};

test("each of GitHub's words for a refused review is the refusal it means", async () => {
  const cases: { status: number; message: string; errors: unknown[]; failure: HostFailure }[] = [
    // The other wording of a comment off the diff (spike 03 saw "could not be resolved").
    {
      status: 422,
      message: "Unprocessable Entity",
      errors: ["Pull request review thread line must be part of the diff"],
      failure: "unplaceable_comment",
    },
    {
      status: 422,
      message: "Unprocessable Entity",
      errors: ["Pull request review thread start line must be part of the same hunk as the line."],
      failure: "unplaceable_comment",
    },
    // Seen live on round 1 of #465 (PR #82): GitHub's own failure, which asks to try again.
    {
      status: 422,
      message: "Unprocessable Entity",
      errors: ["An internal error occurred, please try again."],
      failure: "unavailable",
    },
    {
      status: 422,
      message: "Validation Failed",
      errors: [
        {
          resource: "PullRequestReview",
          code: "custom",
          message: "Body is too long (maximum is 65536 characters)",
        },
      ],
      failure: "too_large",
    },
    // Any other 422: the review as it is will be refused again.
    {
      status: 422,
      message: "Validation Failed",
      errors: ["commit_id is not part of the pull request"],
      failure: "invalid",
    },
    // A secondary limit with neither `retry-after` nor `x-ratelimit-remaining: 0`.
    {
      status: 403,
      message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
      errors: [],
      failure: "rate_limited",
    },
    { status: 502, message: "Server Error", errors: [], failure: "unavailable" },
  ];
  for (const { status, message, errors, failure } of cases) {
    const api = stubGitHub(
      signIn(() => AT, "ghs_one"),
      refusingReviews(status, message, errors),
    );
    const github = createGitHub({
      app: APP,
      repositories: LISTED,
      fetch: api.fetch,
      clock: { now: () => AT },
    });
    const refused = await github.writer.publishReview(CHANGE_REF, A_REVIEW).catch((error: unknown) => error);
    const said = refused instanceof HostError ? refused.failure : refused;
    // The words go along, so a failing case says which wording it was.
    expect({ words: [message, ...errors], failure: said }).toEqual({ words: [message, ...errors], failure });
  }
});

test("a summary GitHub finds too long is too large, and its internal error unavailable", async () => {
  const refusing = (words: string): Route =>
    withToken("ghs_one", (call) =>
      call.method === "POST" && call.path === `${SANDBOX}/issues/7/comments`
        ? { status: 422, body: { message: "Validation Failed", errors: [{ message: words }] } }
        : undefined,
    );
  for (const [words, failure] of [
    ["Body is too long (maximum is 65536 characters)", "too_large"],
    ["An internal error occurred, please try again.", "unavailable"],
  ] as const) {
    const api = stubGitHub(
      signIn(() => AT, "ghs_one"),
      identity,
      refusing(words),
      conversation([]),
    );
    const github = createGitHub({
      app: APP,
      repositories: LISTED,
      fetch: api.fetch,
      clock: { now: () => AT },
    });
    await expect(
      github.writer.upsertSummary(CHANGE_REF, `${SUMMARY_MARKER}\nRound 1.`),
    ).rejects.toMatchObject({
      failure,
    });
  }
});

test("a secondary limit keeps the token: the next call uses it, no sign-in again", async () => {
  let refused = false;
  const once: Route = withToken("ghs_one", (call) => {
    if (call.method !== "POST" || call.path !== `${SANDBOX}/pulls/7/reviews`) return undefined;
    if (refused) return { status: 200, body: { id: 3528111001 } };
    refused = true;
    return { status: 403, body: { message: "You have exceeded a secondary rate limit." } };
  });
  const api = stubGitHub(
    signIn(() => AT, "ghs_one", "ghs_two"),
    once,
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  await expect(github.writer.publishReview(CHANGE_REF, A_REVIEW)).rejects.toMatchObject({
    failure: "rate_limited",
  });
  expect(await github.writer.publishReview(CHANGE_REF, A_REVIEW)).toBe("3528111001");
  expect(tokensBought(api.calls)).toBe(1);
});

const BOT = { id: 338297044, login: "lookover-spike-sasensi[bot]" };
type Comment = { id: number; user: { id: number; login: string }; body: string };

/** The App's identity, as GitHub tells it: the App by its JWT, its bot user by the slug. */
const identity: Route = (call) => {
  if (call.path === "/app" && verifiedClaims(call.authorization) !== null)
    return { status: 200, body: { id: 5202093, slug: "lookover-spike-sasensi" } };
  if (call.path === "/users/lookover-spike-sasensi%5Bbot%5D") return { status: 200, body: BOT };
  return undefined;
};

/** The pull request's conversation: comments created by the bot, and edited in place. */
function conversation(comments: Comment[]): Route {
  let nextId = 100;
  const body = (call: Call) => (typeof call.body === "object" && call.body !== null ? call.body : {});
  const text = (call: Call) => {
    const b = body(call);
    return "body" in b && typeof b.body === "string" ? b.body : "";
  };
  return withToken("ghs_one", (call) => {
    if (call.path === `${SANDBOX}/issues/7/comments?per_page=100`) return { status: 200, body: comments };
    if (call.method === "POST" && call.path === `${SANDBOX}/issues/7/comments`) {
      const created = { id: nextId++, user: BOT, body: text(call) };
      comments.push(created);
      return { status: 201, body: created };
    }
    const edit = /^\/repos\/sasensi\/lookover-sandbox\/issues\/comments\/(\d+)$/.exec(call.path);
    const edited = edit && comments.find((c) => c.id === Number(edit[1]));
    if (call.method === "PATCH" && edited) {
      edited.body = text(call);
      return { status: 200, body: edited };
    }
    return undefined;
  });
}

test("the summary is created once, then edited: the bot's by numeric id, found by the marker", async () => {
  // Another user with the bot's login holds a marker comment: it is someone else's.
  const comments: Comment[] = [
    { id: 1, user: { id: 1, login: BOT.login }, body: `${SUMMARY_MARKER}\nNot ours.` },
  ];
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    identity,
    conversation(comments),
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  const first = `${SUMMARY_MARKER}\nRound 1: 1 open.`;
  const second = `${SUMMARY_MARKER}\nRound 2: 0 open, 1 verified fixed.`;
  const id = await github.writer.upsertSummary(CHANGE_REF, first);
  expect(id).toBe("100");
  expect(await github.writer.upsertSummary(CHANGE_REF, second)).toBe("100");
  expect(comments.map((c) => c.body)).toEqual([`${SUMMARY_MARKER}\nNot ours.`, second]);
  expect(api.calls.filter((c) => c.method === "POST" && c.path.endsWith("/comments")).length).toBe(1);
});

test("the summary is found past the first 100 comments, and edited: no second summary on a busy pull request", async () => {
  const others: Comment[] = Array.from({ length: 100 }, (_, i) => ({
    id: i + 1,
    user: { id: 11247504, login: "sasensi" },
    body: `Comment ${i + 1}.`,
  }));
  const ours: Comment = { id: 500, user: BOT, body: `${SUMMARY_MARKER}\nRound 1: 1 open.` };
  const page2 = "/repositories/1105207321/issues/7/comments?per_page=100&page=2";
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    identity,
    conditional(`${SANDBOX}/issues/7/comments?per_page=100`, () => ({
      etag: 'W/"c1"',
      body: others,
      link: `<https://api.github.com${page2}>; rel="next"`,
    })),
    conditional(page2, () => ({ etag: 'W/"c2"', body: [ours] })),
    withToken("ghs_one", (call) =>
      call.method === "PATCH" && call.path === `${SANDBOX}/issues/comments/500`
        ? { status: 200, body: { ...ours, body: "edited" } }
        : undefined,
    ),
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  const second = `${SUMMARY_MARKER}\nRound 2: 0 open.`;
  expect(await github.writer.upsertSummary(CHANGE_REF, second)).toBe("500");
  expect(
    api.calls
      .filter((c) => c.method !== "GET" && c.path.startsWith(SANDBOX))
      .map((c) => [c.method, c.path, c.body]),
  ).toEqual([["PATCH", `${SANDBOX}/issues/comments/500`, { body: second }]]);
});

test("a check is found by its job's id among the App's runs on the commit: the newest, whatever GitHub's order", async () => {
  const sha = "126ba1dae30bd5bb918afe71a1ecd88ff9744fb1";
  const runs = (path: string) =>
    path ===
    `${SANDBOX}/commits/${sha}/check-runs?check_name=Lookover&filter=all&app_id=${APP.id}&per_page=100`;
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    withToken("ghs_one", (call) =>
      runs(call.path)
        ? {
            status: 200,
            body: {
              total_count: 4,
              check_runs: [
                { id: 1, external_id: "job-1" },
                { id: 3, external_id: "job-1" },
                { id: 2, external_id: "job-2" },
                { id: 4, external_id: null },
              ],
            },
          }
        : undefined,
    ),
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  expect(await github.writer.findCheck(SANDBOX_REPO, commitSha(sha), "job-1")).toBe("3");
  expect(await github.writer.findCheck(SANDBOX_REPO, commitSha(sha), "job-9")).toBeNull();
});

test("the bot's review is found by its marker past the first page; one someone else wrote holding it is not the bot's", async () => {
  const marker = `${REVIEW_MARKER}round-1 -->`;
  const page2 = "/repositories/1105207321/pulls/7/reviews?per_page=100&page=2";
  const review = (id: number, user: { id: number; login: string }, body: string) => ({
    id,
    user,
    body,
    commit_id: SHA,
  });
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    identity,
    conditional(`${SANDBOX}/pulls/7/reviews?per_page=100`, () => ({
      etag: 'W/"r1"',
      body: [review(1, { id: 11247504, login: "sasensi" }, `Quoting: ${marker}`)],
      link: `<https://api.github.com${page2}>; rel="next"`,
    })),
    conditional(page2, () => ({
      etag: 'W/"r2"',
      body: [
        review(
          2,
          BOT,
          `1 finding.\n
${marker}`,
        ),
      ],
    })),
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  expect(await github.writer.findReview(CHANGE_REF, marker)).toBe("2");
  expect(await github.writer.findReview(CHANGE_REF, `${REVIEW_MARKER}round-2 -->`)).toBeNull();
});

test("a review or a summary over GitHub's body limit is refused before anything is sent", async () => {
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    identity,
    reviews,
    conversation([]),
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  const tooBig = "é".repeat(COMMENT_MAX_BYTES / 2 + 1);
  await expect(
    github.writer.publishReview(CHANGE_REF, { sha: SHA, body: tooBig, comments: [] }),
  ).rejects.toMatchObject({ failure: "too_large" });
  await expect(github.writer.upsertSummary(CHANGE_REF, `${SUMMARY_MARKER}\n${tooBig}`)).rejects.toMatchObject(
    {
      failure: "too_large",
    },
  );
  expect(api.calls).toEqual([]);
});

test("a summary without the marker is refused: the next round could not find it", async () => {
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    identity,
    conversation([]),
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  await expect(github.writer.upsertSummary(CHANGE_REF, "Round 1: 1 open.")).rejects.toMatchObject({
    failure: "missing_marker",
    message: `The summary must hold the marker ${SUMMARY_MARKER}, or the next round can't find it`,
  });
  expect(api.calls).toEqual([]);
});

/** The change as GitHub shows it after one round: a completed check, one review, the summary. */
const shown: Route = withToken("ghs_one", (call) => {
  const at: Record<string, unknown> = {
    [`${SANDBOX}/pulls/7`]: PULL,
    [`${SANDBOX}/commits/126ba1dae30bd5bb918afe71a1ecd88ff9744fb1/check-runs?check_name=Lookover&filter=all&per_page=100`]:
      {
        total_count: 1,
        check_runs: [
          {
            id: 111954805720,
            name: "Lookover",
            head_sha: "126ba1dae30bd5bb918afe71a1ecd88ff9744fb1",
            status: "completed",
            conclusion: "success",
            output: { title: "No blocking finding", summary: "Round 1: 0 open.", text: "<!-- result -->" },
          },
        ],
      },
    [`${SANDBOX}/pulls/7/reviews?per_page=100`]: [
      {
        id: 3528111001,
        user: BOT,
        body: "1 finding.",
        commit_id: "126ba1dae30bd5bb918afe71a1ecd88ff9744fb1",
      },
    ],
    [`${SANDBOX}/pulls/7/comments?per_page=100`]: [
      {
        id: 4188226805,
        node_id: "PRRC_4188226805",
        pull_request_review_id: 3528111001,
        path: "src/invoices.ts",
        side: "RIGHT",
        line: 12,
        original_line: 12,
        body: "Off by one.",
        user: BOT,
      },
      {
        // Outdated: a push replaced the line it was on.
        id: 4188226806,
        node_id: "PRRC_4188226806",
        pull_request_review_id: 3528111001,
        path: "src/invoices.ts",
        side: "RIGHT",
        line: null,
        original_line: 15,
        body: "Missing await.",
        user: BOT,
      },
      {
        // On a range: GitHub's `line` is its last line, `start_line` its first.
        id: 4188226807,
        node_id: "PRRC_4188226807",
        pull_request_review_id: 3528111001,
        path: "src/invoices.ts",
        side: "RIGHT",
        start_line: 16,
        line: 18,
        original_start_line: 16,
        original_line: 18,
        body: "Never ends on a 4xx.",
        user: BOT,
      },
      {
        // An outdated range.
        id: 4188226808,
        node_id: "PRRC_4188226808",
        pull_request_review_id: 3528111001,
        path: "src/invoices.ts",
        side: "RIGHT",
        start_line: null,
        line: null,
        original_start_line: 3,
        original_line: 5,
        body: "Gone since.",
        user: BOT,
      },
      {
        // A range of removed lines, on LEFT.
        id: 4188226809,
        node_id: "PRRC_4188226809",
        pull_request_review_id: 3528111001,
        path: "src/invoices.ts",
        side: "LEFT",
        start_side: "LEFT",
        start_line: 7,
        line: 8,
        original_start_line: 7,
        original_line: 8,
        body: "Both checks went.",
        user: BOT,
      },
    ],
    [`${SANDBOX}/issues/7/comments?per_page=100`]: [
      {
        id: 100,
        node_id: "IC_100",
        user: BOT,
        body: `${SUMMARY_MARKER}\nRound 1: 1 open.`,
        // GitHub's rollup of the comment's reactions: every kind, Lookover's two among them.
        reactions: {
          url: "https://api.github.com/repos/sasensi/lookover-sandbox/issues/comments/100/reactions",
          total_count: 2,
          "+1": 1,
          "-1": 0,
          laugh: 0,
          hooray: 0,
          confused: 0,
          heart: 0,
          rocket: 0,
          eyes: 1,
        },
      },
    ],
  };
  if (call.method === "POST" && call.path === "/graphql") return { status: 200, body: nodesOf(call) };
  const body = at[call.path];
  return body === undefined ? undefined : { status: 200, body };
});

/**
 * GitHub's GraphQL `nodes` as `shown`'s comments have it: one outdated comment hidden as outdated (GitHub writes
 * the reason in lower case), one hidden as off-topic by a person, the others not hidden.
 */
const HIDDEN: Record<string, string> = { PRRC_4188226806: "outdated", PRRC_4188226808: "off-topic" };

function nodesOf(call: Call) {
  const { variables } = graphqlSent.parse(call.body);
  const nodes = (variables.ids ?? []).map((id) => ({
    id,
    isMinimized: HIDDEN[id] !== undefined,
    minimizedReason: HIDDEN[id] ?? null,
  }));
  return { data: { nodes } };
}

test("the view is what GitHub shows: the head's checks, the reviews with their comments (an outdated one's line null), the conversation", async () => {
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    shown,
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  expect(await github.view(CHANGE_REF)).toEqual({
    checks: [
      {
        id: "111954805720",
        name: "Lookover",
        sha: SHA,
        status: "completed",
        conclusion: "success",
        output: DONE,
      },
    ],
    reviews: [
      {
        id: "3528111001",
        sha: SHA,
        body: "1 finding.",
        comments: [
          {
            id: "4188226805",
            path: "src/invoices.ts",
            side: "head",
            line: 12,
            endLine: null,
            originalLine: 12,
            body: "Off by one.",
            minimized: null,
          },
          {
            id: "4188226806",
            path: "src/invoices.ts",
            side: "head",
            line: null,
            endLine: null,
            originalLine: 15,
            body: "Missing await.",
            minimized: "outdated",
          },
          // A range reads from its first line, as Lookover names one.
          {
            id: "4188226807",
            path: "src/invoices.ts",
            side: "head",
            line: 16,
            endLine: 18,
            originalLine: 16,
            body: "Never ends on a 4xx.",
            minimized: null,
          },
          // Hidden by a person for a reason Lookover never gives: GitHub's word kept.
          {
            id: "4188226808",
            path: "src/invoices.ts",
            side: "head",
            line: null,
            endLine: null,
            originalLine: 3,
            body: "Gone since.",
            minimized: { other: "off-topic" },
          },
          {
            id: "4188226809",
            path: "src/invoices.ts",
            side: "base",
            line: 7,
            endLine: 8,
            originalLine: 7,
            body: "Both checks went.",
            minimized: null,
          },
        ],
      },
    ],
    comments: [
      {
        id: "100",
        author: BOT,
        body: `${SUMMARY_MARKER}\nRound 1: 1 open.`,
        reactions: { eyes: 1, rocket: 0 },
        minimized: null,
      },
    ],
  });
});

const EARLIER = commitSha("d6b858a68addf47ed12faffe1f4834e9c3faef6f");
const earlierChecks: Route = withToken("ghs_one", (call) =>
  call.path === `${SANDBOX}/commits/${EARLIER}/check-runs?check_name=Lookover&filter=all&per_page=100`
    ? {
        status: 200,
        body: {
          total_count: 1,
          check_runs: [
            {
              id: 111954805001,
              name: "Lookover",
              head_sha: EARLIER,
              status: "completed",
              conclusion: "neutral",
              output: { title: "Looked over d6b858a: 2 things to fix", summary: null, text: null },
            },
          ],
        },
      }
    : undefined,
);

test("the view reads every page GitHub gives: a conversation past its first 100 comments", async () => {
  const reactions = { eyes: 0, rocket: 0 };
  const others = Array.from({ length: 100 }, (_, i) => ({
    id: i + 1,
    node_id: `IC_${i + 1}`,
    user: { id: 11247504, login: "sasensi" },
    body: `Comment ${i + 1}.`,
    reactions,
  }));
  const ours = {
    id: 500,
    node_id: "IC_500",
    user: BOT,
    body: `${SUMMARY_MARKER}\nRound 1: 1 open.`,
    reactions,
  };
  const page2 = "/repositories/1105207321/issues/7/comments?per_page=100&page=2";
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    conditional(`${SANDBOX}/issues/7/comments?per_page=100`, () => ({
      etag: 'W/"v1"',
      body: others,
      link: `<https://api.github.com${page2}>; rel="next"`,
    })),
    conditional(page2, () => ({ etag: 'W/"v2"', body: [ours] })),
    shown,
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  const { comments } = await github.view(CHANGE_REF);
  expect(comments).toHaveLength(101);
  expect(comments.at(-1)).toEqual({ id: "500", body: ours.body, author: BOT, reactions, minimized: null });
  // Whether each is hidden: one GraphQL query per hundred comments, the inline ones counted in.
  const asked = api.calls.filter((c) => c.path === "/graphql");
  expect(asked.map((c) => graphqlSent.parse(c.body).variables.ids?.length)).toEqual([100, 6]);
});

test("the view of an earlier commit shows that commit's checks, with the same reviews and conversation", async () => {
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    shown,
    earlierChecks,
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  const view = await github.view(CHANGE_REF, EARLIER);
  expect(view.checks).toEqual([
    {
      id: "111954805001",
      name: "Lookover",
      sha: EARLIER,
      status: "completed",
      conclusion: "neutral",
      output: { title: "Looked over d6b858a: 2 things to fix", summary: "", text: "" },
    },
  ]);
  expect(view.reviews.map((r) => r.id)).toEqual(["3528111001"]);
  expect(view.comments.map((c) => c.id)).toEqual(["100"]);
});

/** A check GitHub concluded itself: someone cancelled it, or it went stale. */
const cancelledCheck: Route = withToken("ghs_one", (call) =>
  call.path === `${SANDBOX}/commits/${EARLIER}/check-runs?check_name=Lookover&filter=all&per_page=100`
    ? {
        status: 200,
        body: {
          total_count: 2,
          check_runs: [
            {
              id: 111954805002,
              name: "Lookover",
              head_sha: EARLIER,
              status: "completed",
              conclusion: "stale",
              output: { title: null, summary: null, text: null },
            },
            {
              id: 111954805001,
              name: "Lookover",
              head_sha: EARLIER,
              status: "completed",
              conclusion: "cancelled",
              output: { title: null, summary: null, text: null },
            },
          ],
        },
      }
    : undefined,
);

test("a check concluded with a word Lookover never posts reads as `other`, GitHub's word kept", async () => {
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    cancelledCheck,
    shown,
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  const view = await github.view(CHANGE_REF, EARLIER);
  expect(view.checks.map((c) => [c.id, c.conclusion])).toEqual([
    ["111954805001", { other: "cancelled" }],
    ["111954805002", { other: "stale" }],
  ]);
});

/** Checks of a job that waits, and of one that ended without a round. */
const waitingChecks: Route = withToken("ghs_one", (call) =>
  call.path === `${SANDBOX}/commits/${EARLIER}/check-runs?check_name=Lookover&filter=all&per_page=100`
    ? {
        status: 200,
        body: {
          total_count: 2,
          check_runs: [
            {
              id: 111954805011,
              name: "Lookover",
              head_sha: EARLIER,
              status: "queued",
              conclusion: null,
              output: { title: "Waiting for its turn", summary: "Queued.", text: "It starts by itself." },
            },
            {
              id: 111954805010,
              name: "Lookover",
              head_sha: EARLIER,
              status: "completed",
              conclusion: "skipped",
              output: { title: "A newer commit was pushed", summary: "Not reviewed.", text: "x" },
            },
          ],
        },
      }
    : undefined,
);

test("a queued check reads as queued, and a skipped one as Lookover's own conclusion", async () => {
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    waitingChecks,
    shown,
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  const view = await github.view(CHANGE_REF, EARLIER);
  expect(view.checks.map((c) => [c.id, c.status, c.conclusion])).toEqual([
    ["111954805010", "completed", "skipped"],
    ["111954805011", "queued", null],
  ]);
});

const repository: Route = withToken("ghs_one", (call) =>
  call.path === SANDBOX
    ? { status: 200, body: { id: 1105207321, owner: { id: 11247504, login: "sasensi", type: "User" } } }
    : undefined,
);

test("the identities a live snapshot shows: the repository's owner, and the App's bot by its slug", async () => {
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    identity,
    repository,
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  expect(await github.identity(SANDBOX_REPO)).toEqual({
    owner: { id: 11247504, login: "sasensi" },
    bot: { id: 338297044, login: "lookover-spike-sasensi[bot]" },
  });
});

// Polling (ADR 0043): listings past 100 items, ETags kept by request so an unchanged answer is free, the
// repository's conversation comments since a point, a push's commits counted, and the bot's reactions.

const OPEN = `${SANDBOX}/pulls?state=open&per_page=100`;
/** GitHub's paging: the next page by the `Link` header, at the address GitHub gives (by repository id). */
const OPEN_PAGE_2 = "/repositories/1105207321/pulls?state=open&per_page=100&page=2";
const pullNumbered = (number: number) => ({
  ...PULL,
  number,
  html_url: `https://github.com/sasensi/lookover-sandbox/pull/${number}`,
});

/**
 * GitHub's answers to one GET, as a conditional request gets them: the body `current` gives, with its ETag (and
 * its `Link` header, when given), or `304` with no body when the request sends that ETag.
 */
function conditional(
  path: string,
  current: () => { etag: string; body: unknown; link?: string; date?: string },
): Route {
  return withToken("ghs_one", (call) => {
    if (call.method !== "GET" || call.path !== path) return undefined;
    const now = current();
    const date = now.date === undefined ? {} : { date: now.date };
    if (call.ifNoneMatch === now.etag) return { status: 304, headers: { etag: now.etag, ...date } };
    const link = now.link === undefined ? {} : { link: now.link };
    return { status: 200, body: now.body, headers: { etag: now.etag, ...link, ...date } };
  });
}

test("a listing says when GitHub answered, by GitHub's own clock (its Date header), unchanged or not", async () => {
  let date = "Tue, 06 Oct 2026 11:55:00 GMT";
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    conditional(COMMENTS, () => ({ etag: 'W/"same"', body: [], date })),
  );
  // This machine's clock is five minutes ahead of GitHub's.
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  expect((await github.intake.listComments(SANDBOX_REPO, AT)).at).toBe(Date.UTC(2026, 9, 6, 11, 55, 0));
  date = "Tue, 06 Oct 2026 11:55:10 GMT";
  expect(await github.intake.listComments(SANDBOX_REPO, AT)).toEqual({
    unchanged: true,
    items: [],
    at: Date.UTC(2026, 9, 6, 11, 55, 10),
  });
});

test("the open changes are read past 100, page by page as GitHub's Link header gives them", async () => {
  const first = Array.from({ length: 100 }, (_, i) => pullNumbered(i + 1));
  const second = [pullNumbered(101), pullNumbered(102)];
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    conditional(OPEN, () => ({
      etag: 'W/"p1"',
      body: first,
      link: `<https://api.github.com${OPEN_PAGE_2}>; rel="next", <https://api.github.com${OPEN_PAGE_2}>; rel="last"`,
    })),
    conditional(OPEN_PAGE_2, () => ({ etag: 'W/"p2"', body: second })),
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });

  const { unchanged, items } = await github.intake.listOpenChanges(SANDBOX_REPO);

  expect(unchanged).toBe(false);
  expect(items).toHaveLength(102);
  expect(items.at(-1)).toEqual({
    ...CHANGE,
    number: 102,
    url: "https://github.com/sasensi/lookover-sandbox/pull/102",
  });
});

test("a listing read again sends the ETag of its last answer; GitHub's 304 is unchanged, with the items it gave", async () => {
  let listed = { etag: 'W/"one"', body: [PULL] };
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    conditional(OPEN, () => listed),
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });

  expect(await github.intake.listOpenChanges(SANDBOX_REPO)).toEqual({
    unchanged: false,
    items: [CHANGE],
    at: AT,
  });
  expect(api.calls.at(-1)?.ifNoneMatch).toBeNull();
  expect(await github.intake.listOpenChanges(SANDBOX_REPO)).toEqual({
    unchanged: true,
    items: [CHANGE],
    at: AT,
  });
  expect(api.calls.at(-1)?.ifNoneMatch).toBe('W/"one"');

  // A push: the listing changes, and its new ETag is the one sent next.
  listed = { etag: 'W/"two"', body: [{ ...PULL, head: { ...PULL.head, sha: EARLIER } }] };
  const pushed = await github.intake.listOpenChanges(SANDBOX_REPO);
  expect(pushed.unchanged).toBe(false);
  expect(pushed.items[0]?.head.sha).toBe(EARLIER);
  await github.intake.listOpenChanges(SANDBOX_REPO);
  expect(api.calls.at(-1)?.ifNoneMatch).toBe('W/"two"');
});

test("a listing is unchanged only when every page it read is: a change on page 2 is a change", async () => {
  const first = Array.from({ length: 100 }, (_, i) => pullNumbered(i + 1));
  let second = { etag: 'W/"p2"', body: [pullNumbered(101)] };
  const next = `<https://api.github.com${OPEN_PAGE_2}>; rel="next"`;
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    conditional(OPEN, () => ({ etag: 'W/"p1"', body: first, link: next })),
    conditional(OPEN_PAGE_2, () => second),
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  await github.intake.listOpenChanges(SANDBOX_REPO);
  expect((await github.intake.listOpenChanges(SANDBOX_REPO)).unchanged).toBe(true);

  second = { etag: 'W/"p2-closed"', body: [] };
  const after = await github.intake.listOpenChanges(SANDBOX_REPO);
  expect(after.unchanged).toBe(false);
  expect(after.items).toHaveLength(100);
});

/** The repository's conversation comments, newest edited first, at one stable address (no moving `since`). */
const COMMENTS = `${SANDBOX}/issues/comments?sort=updated&direction=desc&per_page=100`;
const COMMENTS_PAGE_2 =
  "/repositories/1105207321/issues/comments?sort=updated&direction=desc&per_page=100&page=2";
const OWNER = { login: "sasensi", id: 11247504, type: "User" };

test("an ETag is kept for its request only: another listing is read whole", async () => {
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    conditional(OPEN, () => ({ etag: 'W/"same"', body: [PULL] })),
    conditional(COMMENTS, () => ({ etag: 'W/"same"', body: [] })),
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  await github.intake.listOpenChanges(SANDBOX_REPO);
  expect(await github.intake.listComments(SANDBOX_REPO, AT)).toEqual({ unchanged: false, items: [], at: AT });
  expect(api.calls.at(-1)?.ifNoneMatch).toBeNull();
});

/** An issue comment as GitHub lists it, on pull request 7 unless said, edited at `updated` (ISO). */
const issueComment = (id: number, created: string, updated = created, number = 7) => ({
  id,
  node_id: `IC_kwDO${id}`,
  html_url: `https://github.com/sasensi/lookover-sandbox/pull/${number}#issuecomment-${id}`,
  issue_url: `https://api.github.com/repos/sasensi/lookover-sandbox/issues/${number}`,
  user: OWNER,
  body: `Comment ${id}.`,
  created_at: created,
  updated_at: updated,
  author_association: "OWNER",
});

test("the comments edited since a point are read newest first, with their change, author and times, and no further", async () => {
  // Page 1 ends on a comment edited before the point: page 2 is never asked for.
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    conditional(COMMENTS, () => ({
      etag: 'W/"c1"',
      body: [
        issueComment(3, "2026-10-06T11:00:00Z", "2026-10-06T12:00:05Z"),
        issueComment(2, "2026-10-06T12:00:00Z", "2026-10-06T12:00:00Z", 9),
        issueComment(1, "2026-10-06T11:59:59Z"),
      ],
      link: `<https://api.github.com${COMMENTS_PAGE_2}>; rel="next"`,
    })),
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });

  expect(await github.intake.listComments(SANDBOX_REPO, AT)).toEqual({
    unchanged: false,
    items: [
      {
        id: "3",
        nodeId: "IC_kwDO3",
        change: 7,
        author: { id: 11247504, login: "sasensi" },
        body: "Comment 3.",
        createdAt: Date.UTC(2026, 9, 6, 11, 0, 0),
        updatedAt: Date.UTC(2026, 9, 6, 12, 0, 5),
      },
      {
        id: "2",
        nodeId: "IC_kwDO2",
        change: 9,
        author: { id: 11247504, login: "sasensi" },
        body: "Comment 2.",
        createdAt: AT,
        updatedAt: AT,
      },
    ],
    // No Date header: this machine's time.
    at: AT,
  });
  expect(api.calls.filter((c) => c.path.includes("issues/comments")).map((c) => c.path)).toEqual([COMMENTS]);
});

test("the comments are read past 100 while a page ends at or after the point", async () => {
  const late = Array.from({ length: 100 }, (_, i) => issueComment(1000 - i, "2026-10-06T12:30:00Z"));
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    conditional(COMMENTS, () => ({
      etag: 'W/"c1"',
      body: late,
      link: `<https://api.github.com${COMMENTS_PAGE_2}>; rel="next"`,
    })),
    conditional(COMMENTS_PAGE_2, () => ({
      etag: 'W/"c2"',
      body: [issueComment(10, "2026-10-06T12:00:00Z"), issueComment(9, "2026-10-06T11:00:00Z")],
    })),
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });

  const { items } = await github.intake.listComments(SANDBOX_REPO, AT);

  expect(items).toHaveLength(101);
  expect(items.at(-1)?.id).toBe("10");
});

test("the comments read again unchanged are GitHub's 304, the items of the last answer for the point asked", async () => {
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    conditional(COMMENTS, () => ({ etag: 'W/"c1"', body: [issueComment(1, "2026-10-06T12:00:00Z")] })),
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  const first = await github.intake.listComments(SANDBOX_REPO, AT);
  expect(await github.intake.listComments(SANDBOX_REPO, AT)).toEqual({
    unchanged: true,
    items: first.items,
    at: AT,
  });
  expect(api.calls.at(-1)?.ifNoneMatch).toBe('W/"c1"');
  // A later point on the same answer: still unchanged, and what it held before the point is left out.
  expect(await github.intake.listComments(SANDBOX_REPO, AT + 1_000)).toEqual({
    unchanged: true,
    items: [],
    at: AT,
  });
});

test("a comment whose author's account is gone is left out: it can be no one's request", async () => {
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    conditional(COMMENTS, () => ({
      etag: 'W/"c1"',
      body: [
        { ...issueComment(2, "2026-10-06T12:00:00Z"), user: null },
        issueComment(1, "2026-10-06T12:00:00Z"),
      ],
    })),
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  expect((await github.intake.listComments(SANDBOX_REPO, AT)).items.map((c) => c.id)).toEqual(["1"]);
});

/** GitHub's compare of `EARLIER...SHA`, as it answers it: the commits `SHA` has, oldest first, with their messages. */
const compare = (status: string, ahead: number, behind: number, messages: string[] = []): Route =>
  withToken("ghs_one", (call) =>
    call.path === `${SANDBOX}/compare/${EARLIER}...${SHA}?per_page=100`
      ? {
          status: 200,
          body: {
            status,
            ahead_by: ahead,
            behind_by: behind,
            total_commits: ahead,
            commits: messages.map((message, i) => ({
              sha: `${i}`.padStart(40, "0"),
              commit: { message, author: { name: "sam" } },
            })),
            files: [],
          },
        }
      : undefined,
  );

test("the commits between two heads are GitHub's compare: ahead counted with their messages, a history moved off `from` diverged", async () => {
  const messages = ["Fix the retry", "Stop on 4xx\n\nCo-authored-by: Claude <noreply@anthropic.com>"];
  const cases = [
    { answer: compare("ahead", 2, 0, messages), count: { commits: 2, diverged: false, messages } },
    { answer: compare("identical", 0, 0), count: { commits: 0, diverged: false, messages: [] } },
    {
      answer: compare("diverged", 1, 1, ["Rewrite"]),
      count: { commits: 1, diverged: true, messages: ["Rewrite"] },
    },
    { answer: compare("behind", 0, 3), count: { commits: 0, diverged: true, messages: [] } },
  ];
  for (const { answer, count } of cases) {
    const api = stubGitHub(
      signIn(() => AT, "ghs_one"),
      answer,
    );
    const github = createGitHub({
      app: APP,
      repositories: LISTED,
      fetch: api.fetch,
      clock: { now: () => AT },
    });
    expect(await github.intake.countCommits(SANDBOX_REPO, EARLIER, SHA)).toEqual(count);
  }
});

test("a commit GitHub doesn't have is not found", async () => {
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    withToken("ghs_one", () => ({ status: 404, body: { message: `No commit found for SHA: ${SHA}` } })),
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  await expect(github.intake.countCommits(SANDBOX_REPO, EARLIER, SHA)).rejects.toMatchObject({
    failure: "not_found",
  });
});

test("a reaction is posted on the comment as GitHub names it; a repeat GitHub answers 200 is no error", async () => {
  const reacted = new Set<unknown>();
  const reactions: Route = withToken("ghs_one", (call) => {
    if (call.method !== "POST" || call.path !== `${SANDBOX}/issues/comments/100/reactions`) return undefined;
    const content = typeof call.body === "object" && call.body !== null ? Object.values(call.body)[0] : null;
    const status = reacted.has(content) ? 200 : 201;
    reacted.add(content);
    return { status, body: { id: 1, content, user: BOT } };
  });
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    reactions,
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });

  await github.writer.react(SANDBOX_REPO, "100", "eyes");
  await github.writer.react(SANDBOX_REPO, "100", "eyes");
  await github.writer.react(SANDBOX_REPO, "100", "rocket");

  expect(api.calls.filter((c) => c.path.endsWith("/reactions")).map((c) => c.body)).toEqual([
    { content: "eyes" },
    { content: "eyes" },
    { content: "rocket" },
  ]);
  await expect(github.writer.react(SANDBOX_REPO, "101", "eyes")).rejects.toMatchObject({
    failure: "not_found",
  });
});

/** A thread's comment as GitHub lists a pull request's review comments (ADR 0052). */
const reviewComment = (
  id: number,
  user: { id: number; login: string; type: string } | null,
  body: string,
  more: { in_reply_to_id?: number; line?: number | null; created_at?: string } = {},
) => ({
  id,
  node_id: `PRRC_${id}`,
  pull_request_review_id: id + 1000,
  user,
  body,
  path: "src/invoices.ts",
  line: 12,
  original_line: 12,
  html_url: `https://github.com/sasensi/lookover-sandbox/pull/7#discussion_r${id}`,
  created_at: "2026-10-06T12:00:00Z",
  ...more,
});

const BOT_USER = { ...BOT, type: "Bot" };
const finding = (id: string) => `**Off by one** · Should fix\n\n${FINDING_MARKER}{"v":1,"id":"${id}"} -->`;
const THREADS = `${SANDBOX}/pulls/7/comments?per_page=100`;
const THREADS_PAGE_2 = "/repositories/1105207321/pulls/7/comments?per_page=100&page=2";

/** GitHub's GraphQL `nodes` for review comments: `outdated` for the ids it names, the others not. */
const outdatedNodes = (...outdated: string[]): Route =>
  withToken("ghs_one", (call) => {
    if (call.method !== "POST" || call.path !== "/graphql") return undefined;
    const { query, variables } = graphqlSent.parse(call.body);
    if (!query.includes("outdated")) return undefined;
    const nodes = (variables.ids ?? []).map((id) => ({ id, outdated: outdated.includes(id) }));
    return { status: 200, body: { data: { nodes } } };
  });

test("Lookover's threads are the bot's root comments holding a finding marker, with their replies oldest first, outdated ones too, past the first page", async () => {
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    identity,
    // GitHub's GraphQL shows a comment outdated seconds after the push; REST's `line` lagged minutes (#174 live).
    outdatedNodes("PRRC_11"),
    conditional(THREADS, () => ({
      etag: 'W/"t1"',
      body: [
        reviewComment(20, OWNER, "Won't fix: the caller checks it.", {
          in_reply_to_id: 10,
          created_at: "2026-10-06T12:05:00Z",
        }),
        reviewComment(10, BOT_USER, finding("F1")),
        // Outdated: a push replaced its line, though REST still gives it. Still read, by its marker.
        reviewComment(11, BOT_USER, finding("F2")),
        // Someone else's comment holding a marker, and a bot comment without one: no thread of Lookover's.
        reviewComment(12, OWNER, finding("F9")),
        reviewComment(13, BOT_USER, "Not a finding."),
      ],
      link: `<https://api.github.com${THREADS_PAGE_2}>; rel="next"`,
    })),
    conditional(THREADS_PAGE_2, () => ({
      etag: 'W/"t2"',
      body: [
        reviewComment(21, BOT_USER, "Kept: the guard is still missing.", { in_reply_to_id: 10 }),
        // A reply by an account deleted since: left out.
        reviewComment(22, null, "Gone.", { in_reply_to_id: 10 }),
      ],
    })),
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  const threads = await github.intake.threads(CHANGE_REF);
  // One GraphQL query, for the roots only.
  const asked = api.calls
    .filter((c) => c.path === "/graphql")
    .map((c) => graphqlSent.parse(c.body).variables);
  expect(asked).toEqual([{ ids: ["PRRC_10", "PRRC_11"] }]);
  expect(threads).toEqual([
    {
      commentId: 10,
      nodeId: "PRRC_10",
      url: "https://github.com/sasensi/lookover-sandbox/pull/7#discussion_r10",
      findingId: findingId("F1"),
      outdated: false,
      replies: [
        {
          commentId: 20,
          nodeId: "PRRC_20",
          author: { id: 11247504, login: "sasensi", bot: false },
          body: "Won't fix: the caller checks it.",
          at: "2026-10-06T12:05:00Z",
        },
        {
          commentId: 21,
          nodeId: "PRRC_21",
          author: { ...BOT, bot: true },
          body: "Kept: the guard is still missing.",
          at: "2026-10-06T12:00:00Z",
        },
      ],
    },
    {
      commentId: 11,
      nodeId: "PRRC_11",
      url: "https://github.com/sasensi/lookover-sandbox/pull/7#discussion_r11",
      findingId: findingId("F2"),
      outdated: true,
      replies: [],
    },
  ]);
});

test("a reply is posted on its thread's root comment as the bot; one over the byte limit is refused before anything is sent", async () => {
  const replies: Route = withToken("ghs_one", (call) =>
    call.method === "POST" && call.path === `${SANDBOX}/pulls/7/comments/10/replies`
      ? { status: 201, body: reviewComment(30, BOT_USER, "Kept.", { in_reply_to_id: 10 }) }
      : undefined,
  );
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    replies,
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  expect(await github.writer.reply(CHANGE_REF, 10, "Kept.")).toBe("30");
  expect(api.calls.at(-1)?.body).toEqual({ body: "Kept." });
  // GitHub has no comment 11 on the pull request.
  await expect(github.writer.reply(CHANGE_REF, 11, "Kept.")).rejects.toMatchObject({ failure: "not_found" });

  const sent = api.calls.length;
  const tooBig = "é".repeat(COMMENT_MAX_BYTES / 2 + 1);
  await expect(github.writer.reply(CHANGE_REF, 10, tooBig)).rejects.toMatchObject({ failure: "too_large" });
  expect(api.calls).toHaveLength(sent);
});

/** GitHub's GraphQL endpoint as `minimizeComment` meets it: `answer` gives the body for the variables sent. */
const graphqlAnswering = (answer: (variables: { id?: string | undefined }) => unknown): Route =>
  withToken("ghs_one", (call) => {
    if (call.method !== "POST" || call.path !== "/graphql") return undefined;
    const sent = graphqlSent.parse(call.body);
    return sent.query.includes("minimizeComment") ? { status: 200, body: answer(sent.variables) } : undefined;
  });

test("a comment is minimized through GitHub's GraphQL, its reason as GitHub names it, with the installation token", async () => {
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    graphqlAnswering(() => ({ data: { minimizeComment: { minimizedComment: { isMinimized: true } } } })),
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  await github.writer.minimize(SANDBOX_REPO, "PRRC_10", "resolved");
  await github.writer.minimize(SANDBOX_REPO, "IC_100", "outdated");
  const sent = api.calls.filter((c) => c.path === "/graphql");
  expect(sent.map((c) => graphqlSent.parse(c.body).variables)).toEqual([
    { id: "PRRC_10", classifier: "RESOLVED" },
    { id: "IC_100", classifier: "OUTDATED" },
  ]);
  expect(sent.every((c) => c.authorization === "Bearer ghs_one")).toBe(true);
});

test("GitHub's GraphQL errors are the refusals they mean: a node it can't find, a permission it refuses, any other", async () => {
  const errors: Record<string, unknown> = {
    PRRC_missing: {
      type: "NOT_FOUND",
      message: "Could not resolve to a node with the global id of 'PRRC_missing'",
    },
    PRRC_theirs: { type: "FORBIDDEN", message: "Resource not accessible by integration" },
    PRRC_odd: { message: "Something else went wrong" },
  };
  const api = stubGitHub(
    signIn(() => AT, "ghs_one", "ghs_one"),
    graphqlAnswering((variables) => ({
      data: { minimizeComment: null },
      errors: [errors[variables.id ?? ""]],
    })),
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  await expect(github.writer.minimize(SANDBOX_REPO, "PRRC_missing", "resolved")).rejects.toMatchObject({
    failure: "not_found",
    message:
      "GitHub refused minimizeComment on PRRC_missing: Could not resolve to a node with the global id of 'PRRC_missing'",
  });
  await expect(github.writer.minimize(SANDBOX_REPO, "PRRC_theirs", "resolved")).rejects.toMatchObject({
    failure: "unauthorized",
  });
  await expect(github.writer.minimize(SANDBOX_REPO, "PRRC_odd", "resolved")).rejects.toMatchObject({
    failure: "invalid",
  });
});

test("GraphQL's own limit is rate-limited until its reset; a minimize that hid nothing, with no error, is invalid", async () => {
  const reset = Math.floor(AT / 1000) + 600;
  const limited: Route = withToken("ghs_one", (call) => {
    if (call.method !== "POST" || call.path !== "/graphql") return undefined;
    const { variables } = graphqlSent.parse(call.body);
    if (variables.id === "PRRC_quiet")
      return { status: 200, body: { data: { minimizeComment: { minimizedComment: null } } } };
    return {
      status: 200,
      body: { errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] },
      headers: { "x-ratelimit-reset": String(reset), "x-ratelimit-resource": "graphql" },
    };
  });
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    limited,
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  await expect(github.writer.minimize(SANDBOX_REPO, "PRRC_10", "resolved")).rejects.toMatchObject({
    failure: "rate_limited",
    retryAt: reset * 1000,
  });
  await expect(github.writer.minimize(SANDBOX_REPO, "PRRC_quiet", "resolved")).rejects.toMatchObject({
    failure: "invalid",
  });
});

test("the threads are read whole each time: no ETag kept, as only the poll's listings keep one", async () => {
  const api = stubGitHub(
    signIn(() => AT, "ghs_one"),
    identity,
    outdatedNodes(),
    conditional(THREADS, () => ({ etag: 'W/"t1"', body: [reviewComment(10, BOT_USER, finding("F1"))] })),
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  const first = await github.intake.threads(CHANGE_REF);
  expect(await github.intake.threads(CHANGE_REF)).toEqual(first);
  expect(api.calls.filter((c) => c.path === THREADS).map((c) => c.ifNoneMatch)).toEqual([null, null]);
});

test("the threads of a number that is no pull request are not found, though GitHub refuses its comments with a 403", async () => {
  // GitHub's answer for the comments of a pull request it hasn't (#174's live run): a 403, not a 404.
  const refused = (n: number): Route =>
    withToken("ghs_one", (call) =>
      call.path === `${SANDBOX}/pulls/${n}/comments?per_page=100`
        ? { status: 403, body: { message: "Resource not accessible by integration" } }
        : undefined,
    );
  const pull8: Route = withToken("ghs_one", (call) =>
    call.path === `${SANDBOX}/pulls/8` ? { status: 200, body: {} } : undefined,
  );
  const api = stubGitHub(
    signIn(() => AT, "ghs_one", "ghs_one"),
    identity,
    refused(9),
    refused(8),
    pull8,
  );
  const github = createGitHub({ app: APP, repositories: LISTED, fetch: api.fetch, clock: { now: () => AT } });
  await expect(github.intake.threads({ repo: SANDBOX_REPO, number: 9 })).rejects.toMatchObject({
    failure: "not_found",
  });
  // A pull request that is there, whose comments are refused all the same: the refusal it is.
  await expect(github.intake.threads({ repo: SANDBOX_REPO, number: 8 })).rejects.toMatchObject({
    failure: "unauthorized",
  });
});
