// Scenarios S1 to S7 through the drawer's door (ADR 0046): one demo service for the whole file, each test loading
// its scenario (`demo.load`) and moving the clock (`demo.advance`) to each milestone, then reading the snapshot as
// the app reads it. Every scenario with a review asserts its round 1 posted: a prompt whose pass marker no longer
// matches the scripted engines would crash the round instead.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { changeId, DEMO_API, type RunActivity, repositoryId, type State } from "@lookover/contracts";
import { memoryGh } from "@lookover/testkit/demo";
import { HANDED_APP, REFUSED_PAGES, type RefusedPage, scenarioOf } from "../index.ts";
import { TEST_LIMIT_MS } from "../service.test-support.ts";
import {
  advance,
  inject,
  installApp,
  load,
  makeApp,
  onGitHub,
  send,
  snapshotOf,
  startScenario,
  stopAll,
  T0,
} from "./demo.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);

const MIN = 60_000;
const id = (n: number) => changeId(`ledger-api#${n}`);

let door: Awaited<ReturnType<typeof startScenario>>;
beforeAll(async () => {
  door = await startScenario(scenarioOf("S10"));
});
afterAll(stopAll);

/** Loads `scenario` on the file's service: the clock stands at `T0`, the seed played. */
async function loaded(scenario: string): Promise<State> {
  const { status, body } = await load(door, scenario);
  expect({ status, body }).toEqual({ status: 200, body: { ok: true } });
  const state = await snapshotOf(door);
  expect(state.now).toBe(T0);
  return state;
}

/** The clock moved `ms` on from where it stands; the snapshot after. */
async function after(ms: number): Promise<State> {
  await advance(door, ms);
  return snapshotOf(door);
}

/** The rounds of a review that finished and posted, by number, as its history says. */
const posted = (state: State, n: number) =>
  (state.reviews[id(n)]?.timeline ?? []).flatMap((t) => (t.kind === "posted" ? [t.round] : []));

/** A review's findings: id, severity, status, whether posted. */
const findingsOf = (state: State, n: number) =>
  state.reviews[id(n)]?.findings.map((f) => [String(f.id), f.severity, f.status, f.posted]);

/** What S1's App is granted: every repository of the owner's. */
const S1_REPOS = ["sasensi/ledger-api", "sasensi/ledger-web", "sasensi/invoice-pdf"].map(repositoryId);

/** A command posted as the app posts it; the status it answered. */
async function sent(body: Parameters<typeof send>[1]): Promise<number> {
  return (await send(door, body)).status;
}

test("S1, first run: Codex signed in, the App made and installed on three repositories, ledger-api kept on, #148 previewed with nothing posted", async () => {
  const start = await loaded("S1");
  expect(start.setup).toMatchObject({ done: false, step: "ai", github: "start" });
  expect(start.connection).toMatchObject({ state: "not-connected", cause: null, web: DEMO_API.github });
  expect(start.changes).toEqual({});
  expect(start.engines.codex).toMatchObject({ state: "signed-out" });

  // Sign in to Codex: the scripted engine is signed in five seconds on, and the watch sees it.
  expect(await sent({ type: "engine.signIn", id: "codex" })).toBe(200);
  expect((await snapshotOf(door)).engines.codex).toMatchObject({ signingIn: true });
  const signedIn = await after(5_000);
  expect(signedIn.engines.codex).toMatchObject({ state: "ready", signingIn: false });

  // GitHub, on its fake pages: the App made from the manifest page and kept, then installed on all the owner's
  // repositories; the three listed, #148 shown and not reviewed.
  expect(await sent({ type: "setup.goto", step: "github" })).toBe(200);
  expect(await sent({ type: "connection.createApp", organisation: null })).toBe(200);
  expect((await snapshotOf(door)).setup).toMatchObject({ github: "waiting-for-app" });
  const installPage = await makeApp(door);
  const made = await snapshotOf(door);
  expect(made.setup).toMatchObject({ github: "waiting-for-install", githubRefused: null });
  const slug = made.connection.app?.slug ?? "";
  expect(slug).toBe("lookover-k3x9q2");
  expect(installPage).toBe(`${DEMO_API.github}/apps/${slug}/installations/new`);
  expect(await installApp(door, installPage)).toContain("Lookover is installed");
  const installed = await after(4_000);
  expect(installed.connection.bot).toBe(`${slug}[bot]`);
  expect(installed.connection.state).toBe("connected");
  expect(installed.setup).toMatchObject({ step: "github", reached: "repos", github: "done" });
  expect(installed.repos.map((r) => r.id)).toEqual(S1_REPOS);
  expect(installed.changes[id(148)]).toMatchObject({ author: "you", writtenBy: "claude" });
  expect(installed.reviews[id(148)]?.job ?? null).toBeNull();
  // Setup waits for the owner (ADR 0058): Continue goes to the repositories.
  expect(await sent({ type: "setup.goto", step: "repos" })).toBe(200);
  expect((await after(0)).setup).toMatchObject({ step: "repos", reached: "repos" });

  // The repository kept on, #148 previewed: Codex finds, Claude double-checks, nothing reaches GitHub.
  expect(await sent({ type: "setup.chooseRepos", enabled: [repositoryId("sasensi/ledger-api")] })).toBe(200);
  expect(await sent({ type: "setup.firstReview", changeId: id(148), preview: true })).toBe(200);
  const running = await after(30_000);
  expect(running.reviews[id(148)]?.run).toMatchObject({
    reviewer: "codex",
    confirmer: "claude",
    preview: true,
  });
  const previewed = await after(4 * MIN);
  expect(previewed.setup).toMatchObject({ step: "first-review", firstReviewChange: id(148) });
  expect(previewed.reviews[id(148)]).toMatchObject({
    preview: true,
    job: { trigger: "first-review", state: "done" },
  });
  // Round 1 posted in the app's history, as a preview: its findings are held here, none on the pull request.
  expect(posted(previewed, 148)).toEqual([1]);
  expect(findingsOf(previewed, 148)?.map(([f, , , onGitHub]) => [f, onGitHub])).toEqual([
    ["F1", false],
    ["F2", false],
    ["F3", false],
  ]);

  // Continue to Your coding agent (ADR 0058): the binary off the PATH, both agents found with no skill; the owner
  // installs Claude Code's and goes to their reviews from there.
  expect(await sent({ type: "setup.goto", step: "agent" })).toBe(200);
  const agent = await snapshotOf(door);
  expect(agent.setup).toMatchObject({ step: "agent", reached: "agent", done: false });
  expect(agent.service.agent).toMatchObject({
    offer: "binary",
    path: { reach: "no" },
    skills: [
      { agent: "claude", state: "none" },
      { agent: "codex", state: "none" },
    ],
  });
  expect(await sent({ type: "agent.skill", agent: "claude", on: true })).toBe(200);
  expect((await snapshotOf(door)).service.agent.skills[0]).toMatchObject({ agent: "claude", state: "ours" });
  expect(await sent({ type: "setup.finish" })).toBe(200);
  expect((await snapshotOf(door)).setup).toMatchObject({ done: true, step: "agent" });
});

test("S1, an existing App: the one made on another computer, given its id and a new key from its page; the refusals first", async () => {
  await loaded("S1");
  expect(await sent({ type: "setup.goto", step: "github" })).toBe(200);
  // GitHub's Apps page lists it; its page gives its id, and a new key as a file.
  const apps = await onGitHub(door, "/settings/apps");
  const href = new URL(/href="([^"]+)"/.exec(apps)?.[1] ?? "").pathname;
  expect(href).toBe(`${DEMO_API.github}/settings/apps/lookover-spike-sasensi`);
  const page = href.slice(DEMO_API.github.length);
  expect(await onGitHub(door, page)).toContain("App ID: 1");
  const key = await onGitHub(door, page, [["action", "generate-key"]]);

  // A file that isn't a key, then the wrong id: refused with why, nothing kept.
  const notAKey = await send(door, { type: "connection.useApp", appId: 1, key: "my notes" });
  expect([notAKey.status, await notAKey.json()]).toEqual([
    409,
    { error: "the App was refused: not-a-key", useApp: { kind: "not-a-key" } },
  ]);
  const wrongId = await send(door, { type: "connection.useApp", appId: 99, key });
  expect([wrongId.status, (await wrongId.json()).useApp]).toEqual([409, { kind: "key-refused" }]);
  expect((await snapshotOf(door)).connection.app).toBeNull();

  // The right pair: kept, and its installation found at once, on every repository.
  expect(await sent({ type: "connection.useApp", appId: 1, key })).toBe(200);
  const installed = await snapshotOf(door);
  expect(installed.connection).toMatchObject({
    state: "connected",
    app: {
      id: 1,
      slug: "lookover-spike-sasensi",
      account: { login: "sasensi", type: "User" },
      person: { login: "sasensi" },
    },
    bot: "lookover-spike-sasensi[bot]",
  });
  expect(installed.setup).toMatchObject({ step: "github", reached: "repos", github: "done" });
  expect(installed.repos.map((r) => r.id)).toEqual(S1_REPOS);
});

test("S1, an organisation's App an admin handed over: refused while gh is signed out, then as gh's account is no member (ADR 0059)", async () => {
  const gh = memoryGh();
  const own = await startScenario(scenarioOf("S1"), { gh });
  const useApp = (appId: number, key: string) =>
    send(own, { type: "connection.useApp", appId, key }).then(async (r) => [
      r.status,
      (await r.json()).useApp,
    ]);
  expect(await send(own, { type: "setup.goto", step: "github" }).then((r) => r.status)).toBe(200);

  expect(await useApp(HANDED_APP.id, HANDED_APP.key)).toEqual([409, { kind: "gh-signed-out" }]);

  // The drawer's "You sign in to gh": as the scenario's owner, who isn't a member of the organisation.
  expect(await inject(own, "gh-signed-in")).toBe(200);
  expect(await useApp(HANDED_APP.id, HANDED_APP.key)).toEqual([
    409,
    { kind: "not-a-member", organisation: "ledger-co", person: "sasensi", invited: false },
  ]);
  expect((await snapshotOf(own)).connection.app).toBeNull();

  // The next load starts with gh signed out again.
  expect((await load(own, "S1")).status).toBe(200);
  expect(await useApp(HANDED_APP.id, HANDED_APP.key)).toEqual([409, { kind: "gh-signed-out" }]);
});

test("S2, the happy loop: #148 by the agent, round 1 posted, the fix and its request, a Consider kept in the app, settled in round 3", async () => {
  const start = await loaded("S2");
  expect(start.changes).toEqual({});

  // Twenty seconds on, the agent's #148 opens and Codex starts finding.
  const opened = await after(30_000);
  expect(opened.changes[id(148)]).toMatchObject({ author: "you", writtenBy: "claude" });
  expect(opened.reviews[id(148)]?.run).toMatchObject({
    reviewer: "codex",
    confirmer: "claude",
    step: "finding",
  });

  // Round 1: three found, all confirmed, all posted; F1 on rateLimit.ts line 42.
  const one = await after(4 * MIN);
  expect(posted(one, 148)).toEqual([1]);
  expect(findingsOf(one, 148)).toEqual([
    ["F1", "blocking", "open", true],
    ["F2", "should_fix", "open", true],
    ["F3", "should_fix", "open", true],
  ]);
  expect(one.reviews[id(148)]?.findings[0]).toMatchObject({
    file: "src/middleware/rateLimit.ts",
    line: 42,
    anchoring: "reported",
  });
  expect(one.reviews[id(148)]?.loop).toBe("open");

  // The agent pushes its fix and comments `/lookover review`; round 2 verifies two fixed and raises a Consider,
  // not posted from round 2: it stays in the app.
  const two = await after(4 * MIN);
  expect(posted(two, 148)).toEqual([1, 2]);
  expect(two.reviews[id(148)]?.job).toMatchObject({ trigger: "comment", state: "done" });
  expect(findingsOf(two, 148)).toEqual([
    ["F1", "blocking", "verified_fixed", true],
    ["F2", "should_fix", "verified_fixed", true],
    ["F3", "should_fix", "open", true],
    ["F4", "consider", "open", false],
  ]);
  expect(two.reviews[id(148)]?.loop).toBe("open");

  // The test pushed and asked for: round 3 settles the loop, the Consider still open in the app.
  const three = await after(4 * MIN);
  expect(posted(three, 148)).toEqual([1, 2, 3]);
  expect(findingsOf(three, 148)).toEqual([
    ["F1", "blocking", "verified_fixed", true],
    ["F2", "should_fix", "verified_fixed", true],
    ["F3", "should_fix", "verified_fixed", true],
    ["F4", "consider", "open", false],
  ]);
  expect(three.reviews[id(148)]?.loop).toBe("settled");
  expect(three.reviews[id(148)]?.rounds.map((r) => [r.n, r.reviewer, r.confirmer])).toEqual([
    [1, "codex", "claude"],
    [2, "codex", null],
    [3, "codex", null],
  ]);
});

test("S3, an AI signs out mid-run: #151's run answers auth_required, the job waits for Claude, a sign-in starts it again to round 1 posted", async () => {
  const start = await loaded("S3");
  expect(start.reviews[id(151)]?.run).toMatchObject({ reviewer: "claude", step: "finding" });
  // Forty seconds in, what Claude did so far (ADR 0055): the live log of `review-running-log`.
  const claude = (activity: RunActivity["activity"]): RunActivity => ({
    engine: "claude",
    pass: "find",
    activity,
  });
  expect(start.reviews[id(151)]?.run?.activities).toEqual([
    claude({ kind: "read", path: "src/invoices/csv.ts" }),
    claude({ kind: "read", path: "src/invoices/invoice.ts" }),
    claude({ kind: "search", pattern: "toCsv" }),
    claude({ kind: "read", path: "src/invoices/routes.ts" }),
    claude({ kind: "list", pattern: "src/**/*.test.ts" }),
    claude({ kind: "read", path: "test/invoices.test.ts" }),
    claude({ kind: "search", pattern: "customer" }),
  ]);

  // Claude signs out twenty seconds on; the run already under way asks for a sign-in at its end, and the job waits.
  const out = await after(30_000);
  expect(out.engines.claude).toMatchObject({ state: "signed-out" });
  const waiting = await after(MIN + 30_000);
  expect(waiting.reviews[id(151)]?.run).toBeNull();
  expect(waiting.reviews[id(151)]?.job).toMatchObject({
    state: "deferred",
    deferral: { reason: "engine-signed-out", engine: "claude" },
  });
  expect(posted(waiting, 151)).toEqual([]);

  // Sign in: the login is done five seconds on, but the run's answer holds Claude signed out for a minute from
  // its end (t115's hold), so the watch sees it ready half a minute later, and the review starts again.
  expect(await sent({ type: "engine.signIn", id: "claude" })).toBe(200);
  expect((await after(5_000)).engines.claude).toMatchObject({ state: "signed-out", signingIn: true });
  const again = await after(30_000);
  expect(again.engines.claude).toMatchObject({ state: "ready", signingIn: false });
  expect(again.reviews[id(151)]?.run).toMatchObject({ reviewer: "claude", step: "finding" });

  const one = await after(4 * MIN);
  expect(posted(one, 151)).toEqual([1]);
  expect(findingsOf(one, 151)).toEqual([["F1", "should_fix", "open", true]]);
  expect(one.reviews[id(151)]?.rounds.map((r) => [r.n, r.reviewer, r.confirmer])).toEqual([
    [1, "claude", "codex"],
  ]);
});

test("S4, the agent keeps asking without fixing: #149's blocking F1 answered won't fix twice, kept in round 2, escalated in round 3", async () => {
  await loaded("S4");
  expect(scenarioOf("S4").later).toBe("");
  // Written by Claude, so Codex finds and Claude double-checks.
  const opened = await after(30_000);
  expect(opened.changes[id(149)]).toMatchObject({ author: "you", writtenBy: "claude" });
  expect(opened.reviews[id(149)]?.run).toMatchObject({ reviewer: "codex", confirmer: "claude" });

  const one = await after(4 * MIN);
  expect(posted(one, 149)).toEqual([1]);
  expect(findingsOf(one, 149)).toEqual([["F1", "blocking", "open", true]]);
  expect(one.reviews[id(149)]?.findings[0]?.claim).toBeNull();

  // The agent answers F1 "won't fix" on its thread, pushes something else and asks: round 2 keeps F1.
  const two = await after(4 * MIN);
  expect(posted(two, 149)).toEqual([1, 2]);
  expect(findingsOf(two, 149)).toEqual([["F1", "blocking", "open", true]]);
  expect(two.reviews[id(149)]?.findings[0]).toMatchObject({
    kept: 1,
    claim: {
      kind: "wont_fix",
      by: "sasensi",
      text: "Won't fix: the provider only calls us from its own IP range.",
    },
  });
  expect(two.reviews[id(149)]?.loop).toBe("open");

  // Once more: kept against its author twice, F1 is the owner's to settle.
  const three = await after(4 * MIN);
  expect(posted(three, 149)).toEqual([1, 2, 3]);
  expect(three.reviews[id(149)]?.job).toMatchObject({ trigger: "comment", state: "done" });
  expect(findingsOf(three, 149)).toEqual([["F1", "blocking", "escalated", true]]);
  expect(three.reviews[id(149)]?.findings[0]).toMatchObject({
    kept: 2,
    claim: { kind: "wont_fix", by: "sasensi", text: "Won't fix. The firewall drops every other sender." },
  });
  expect(three.reviews[id(149)]?.loop).toBe("needs_owner");
  expect(three.reviews[id(149)]?.rounds.map((r) => [r.n, r.reviewer, r.open])).toEqual([
    [1, "codex", 1],
    [2, "codex", 1],
    [3, "codex", 1],
  ]);
});

test("S6, new commits after a review: round 1 posted, the owner pushes two commits, nothing runs until Review again", async () => {
  const start = await loaded("S6");
  expect(posted(start, 153)).toEqual([1]);
  expect(findingsOf(start, 153)).toEqual([
    ["F1", "should_fix", "open", true],
    ["F2", "should_fix", "open", true],
  ]);
  // F2 sits on removed lines, the old file's 11 to 13, its text found there in the diff (#61).
  expect(start.reviews[id(153)]?.findings.map((f) => [f.side, f.line, f.endLine, f.anchoring])).toEqual([
    ["head", 6, null, "reported"],
    ["base", 11, 13, "reported"],
  ]);
  expect(start.changes[id(153)]).toMatchObject({ author: "you", writtenBy: null, newCommits: 0 });

  // The owner pushes two commits at once: shown, not reviewed.
  const pushed = await after(MIN);
  expect(pushed.changes[id(153)]).toMatchObject({ newCommits: 2 });
  expect(pushed.reviews[id(153)]?.timeline.at(-1)).toMatchObject({ kind: "pushed", by: "you", commits: 2 });
  expect(pushed.reviews[id(153)]?.job).toMatchObject({ state: "done" });
  expect(pushed.reviews[id(153)]?.run).toBeNull();

  // Review again: round 2 finds F1 and F2 fixed and settles.
  expect(await sent({ type: "review.request", changeId: id(153) })).toBe(200);
  const two = await after(3 * MIN);
  expect(posted(two, 153)).toEqual([1, 2]);
  expect(two.reviews[id(153)]?.job).toMatchObject({ trigger: "manual", state: "done" });
  expect(findingsOf(two, 153)).toEqual([
    ["F1", "should_fix", "verified_fixed", true],
    ["F2", "should_fix", "verified_fixed", true],
  ]);
  expect(two.reviews[id(153)]?.loop).toBe("settled");
  expect(two.changes[id(153)]).toMatchObject({ newCommits: 0 });
});

test("S7, too noisy: #148's round 1 counted at load; turning F2's rule off, then posting only blocking findings, written to ledger-api's file; F1 dismissed as wrong", async () => {
  const start = await loaded("S7");
  expect(scenarioOf("S7")).toMatchObject({ path: "/reviews/ledger-api/148", later: "" });
  expect(posted(start, 148)).toEqual([1]);
  expect(findingsOf(start, 148)).toEqual([
    ["F1", "blocking", "open", true],
    ["F2", "should_fix", "open", true],
    ["F3", "should_fix", "open", true],
  ]);
  expect(start.reviews[id(148)]?.run).toBeNull();
  // F2 cites main's first rule; the last reviews are this one round: two posted below blocking, one by the rule.
  const rule = start.rules[0];
  expect(rule).toMatchObject({ text: "A list endpoint caps the page size it accepts.", enabled: true });
  expect(start.reviews[id(148)]?.findings[1]?.rule?.id).toBe(rule?.id);
  expect(start.repos[0]?.noise).toEqual({
    reviews: 1,
    postedBelowBlocking: 2,
    raisedByRule: { [String(rule?.id)]: 1 },
  });

  const [room] = readdirSync(join(door.home, "rooms")).filter((name) => name.endsWith("-S7"));
  const file = join(door.home, "rooms", String(room), "sasensi", "ledger-api", "settings.yaml");
  const choice = (c: Record<string, string>) =>
    sent({ type: "noise.apply", choice: { changeId: id(148), ...c } });
  expect(await choice({ kind: "rule-off", findingId: "F2" })).toBe(200);
  const off = await snapshotOf(door);
  expect(off.rules.map((r) => r.enabled)).toEqual([false, true]);
  // The rule kept off by its file and its text (ADR 0049), the only entry of the repository's file.
  const HEAD = "$schema: lookover.settings/v1\nversion: 1\n";
  const RULE_OFF =
    "rulesOff:\n  - file: REVIEW.md\n    text: A list endpoint caps the page size it accepts.\n";
  expect(readFileSync(file, "utf8")).toBe(`${HEAD}${RULE_OFF}`);
  // F1 cites no rule; a finding the change hasn't isn't one to quiet.
  // The refusal's code is what the UI picks its words from; the error line is the console's.
  const refusal = async (c: Record<string, string>) => {
    const answer = await send(door, { type: "noise.apply", choice: { changeId: id(148), ...c } });
    return [answer.status, await answer.json()];
  };
  expect(await refusal({ kind: "rule-off", findingId: "F1" })).toEqual([
    409,
    { error: "the finding cites no rule", refused: "no_rule" },
  ]);
  expect(await refusal({ kind: "rule-off", findingId: "F9" })).toEqual([
    404,
    { error: "no such finding", refused: "no_such_finding" },
  ]);

  expect(await choice({ kind: "blocking-only" })).toBe(200);
  const quiet = await snapshotOf(door);
  expect(quiet.repos[0]?.settings.strictness).toMatchObject({ value: "blocking" });
  expect(readFileSync(file, "utf8")).toBe(`${HEAD}strictness: blocking\n${RULE_OFF}`);
  expect(
    await sent({ type: "noise.apply", choice: { kind: "blocking-only", changeId: changeId("other#1") } }),
  ).toBe(404);

  // "This finding is wrong" (ADR 0052) on the blocking F1: dismissed in the app, the loop still open on F2 and F3.
  expect(await choice({ kind: "wrong", findingId: "F1" })).toBe(200);
  const wrong = await snapshotOf(door);
  expect(findingsOf(wrong, 148)).toEqual([
    ["F1", "blocking", "dismissed", true],
    ["F2", "should_fix", "open", true],
    ["F3", "should_fix", "open", true],
  ]);
  expect(wrong.reviews[id(148)]?.loop).toBe("open");
  expect(await refusal({ kind: "wrong", findingId: "F1" })).toEqual([
    409,
    { error: "the finding is settled or not on the pull request", refused: "settled" },
  ]);
});

test("S5, skipped on purpose: dependabot's #150 skipped as not yours, Mira's #152 from her fork as a fork, nothing run", async () => {
  await loaded("S5");
  const first = await after(30_000);
  expect(first.changes[id(150)]).toMatchObject({ author: "other", openedBy: "dependabot[bot]" });
  expect(first.reviews[id(150)]?.job).toMatchObject({ state: "skipped", skip: "not-yours" });

  const both = await after(MIN);
  expect(both.changes[id(152)]).toMatchObject({ author: "other", openedBy: "mira", fork: true });
  expect(both.changes[id(150)]).toMatchObject({ fork: false });
  for (const [n, skip] of [
    [150, "not-yours"],
    [152, "fork"],
  ] as const) {
    expect(both.reviews[id(n)]?.job).toMatchObject({ trigger: "opened", state: "skipped", skip });
    expect(both.reviews[id(n)]?.rounds).toEqual([]);
    expect(both.reviews[id(n)]?.run).toBeNull();
  }

  // Asked for by hand, the fork is reviewed by Claude alone (ADR 0048).
  expect(await sent({ type: "review.request", changeId: id(152) })).toBe(200);
  const reviewed = await after(3 * MIN);
  expect(reviewed.reviews[id(152)]?.job).toMatchObject({ trigger: "manual", state: "done" });
  expect(reviewed.reviews[id(152)]?.rounds.map((r) => [r.n, r.reviewer])).toEqual([[1, "claude"]]);
});

test("each refusal's page, as GitHub's redirect would get it, shown in demo mode for proof; no other page there", async () => {
  const pages = {
    unknown: [400, "This page ran out"],
    expired: [400, "This page ran out"],
    refused: [400, "GitHub refused to make the App"],
    unreachable: [502, "GitHub couldn't be reached"],
    "not-kept": [500, "Lookover couldn't keep the App's key"],
    "live-config": [409, "Live runs use the test App"],
    "already-made": [409, "Lookover already keeps an App"],
    "no-place": [409, "Choose where to make the App"],
    elsewhere: [400, "GitHub made lookover-demo on sam, not on acme."],
  } as const satisfies Record<RefusedPage, readonly [number, string]>;
  const shown = (name: string) =>
    fetch(`${door.service.origin}${DEMO_API.listing}/pages/${name}`, { headers: { cookie: door.cookie } });
  for (const name of REFUSED_PAGES) {
    const [status, words] = pages[name];
    const res = await shown(name);
    expect([name, res.status]).toEqual([name, status]);
    expect(res.headers.get("content-security-policy")).toStartWith("default-src 'none'; style-src 'nonce-");
    const html = await res.text();
    expect(html).toContain(words);
    // S10's setup is done: the page leads back to Lookover, not to setup.
    expect(html).toContain(">Back to Lookover</a>");
  }
  for (const name of ["installed", "toString", "constructor"]) expect((await shown(name)).status).toBe(404);
  expect((await fetch(`${door.service.origin}${DEMO_API.listing}/pages/expired`)).status).toBe(401);
});
