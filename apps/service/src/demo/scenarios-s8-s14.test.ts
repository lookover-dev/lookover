// S8 to S14 through the drawer's door (ADR 0046): one demo service for the whole file, each test loading its
// scenario (`demo.load`) on the real service and the scripted fakes, its clock standing still at `T0`, then
// driving it as the app and the drawer drive it (commands, `demo.advance`), its milestones read from the snapshot
// and the listing. S1 to S7 have their own file; the catalogue and the invariants over every scenario are in
// `scenarios.test.ts`.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  changeId,
  commitSha,
  type EngineActivity,
  type EngineId,
  type RunActivity,
  type RunPass,
  repositoryId,
  type State,
} from "@lookover/contracts";
import { scenarioOf } from "../index.ts";
import { TEST_LIMIT_MS } from "../service.test-support.ts";
import {
  advance,
  inject,
  listing,
  load,
  send,
  snapshotOf,
  startScenario,
  stopAll,
  stream,
  T0,
  until,
} from "./demo.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);

let door: Awaited<ReturnType<typeof startScenario>>;
beforeAll(async () => {
  door = await startScenario(scenarioOf("S10"));
});
afterAll(stopAll);

/** Loads `scenario` on the file's service: the clock stands at `T0`, the seed played; the snapshot then. */
async function loaded(scenario: string): Promise<State> {
  const { status, body } = await load(door, scenario);
  expect({ status, body }).toEqual({ status: 200, body: { ok: true } });
  const state = await snapshotOf(door);
  expect(state.now).toBe(T0);
  return state;
}

const MIN = 60_000;
const id = (n: number) => changeId(`sasensi/lookover-sandbox#${n}`);
const SANDBOX = repositoryId("sasensi/lookover-sandbox");

test("S8, pause and resume: two pull requests arrive while paused and wait; resumed, they run one after the other, each on both AIs; then all checks run", async () => {
  const seeded = await loaded("S8");
  expect(Object.keys(seeded.changes)).toEqual([id(160)]);
  expect(seeded.reviews[id(160)]?.job).toMatchObject({ state: "done" });
  // The seed ends paused, as from the pill, for an hour.
  expect(seeded.service.paused).toEqual({ since: T0, until: T0 + 60 * MIN });

  // The agent opens #161 two minutes on, the owner #162 a minute later: both arrive while paused, and wait.
  await advance(door, 2 * MIN);
  const first = await snapshotOf(door);
  expect(first.service.paused).not.toBeNull();
  expect(first.reviews[id(161)]?.job).toMatchObject({ state: "deferred", deferral: { reason: "paused" } });
  await advance(door, 2 * MIN);
  const paused = await snapshotOf(door);
  expect(paused.service.paused).toEqual({ since: T0, until: T0 + 60 * MIN });
  for (const n of [161, 162]) {
    expect(paused.reviews[id(n)]?.job).toMatchObject({ state: "deferred", deferral: { reason: "paused" } });
  }

  // Resumed: they run one after the other. Each review holds both AIs, one finding and the other there to
  // double-check: #161 first, Codex finding what Claude wrote; #162, Claude finding, waits its turn behind it.
  const resuming = await stream(door, paused.seq);
  expect((await send(door, { type: "service.resume" })).status).toBe(200);
  await until(resuming, "run.started");
  const resumed = await snapshotOf(door);
  expect(resumed.service.paused).toBeNull();
  expect(resumed.reviews[id(161)]?.run).toMatchObject({ reviewer: "codex", confirmer: "claude" });
  // It says what it waits behind: both AIs on #161 (ADR 0055).
  expect(resumed.reviews[id(162)]?.job).toMatchObject({
    state: "queued",
    turn: { behind: "engines", engines: ["claude", "codex"], changes: [id(161)], testing: false },
  });
  await advance(door, 2 * MIN);
  const turn = await snapshotOf(door);
  expect(turn.reviews[id(161)]?.job).toMatchObject({ state: "done" });
  expect(turn.reviews[id(162)]?.run).toMatchObject({ reviewer: "claude", confirmer: "codex" });
  await advance(door, 2 * MIN);
  const done = await snapshotOf(door);
  expect(
    [161, 162].map((n) => [done.reviews[id(n)]?.job?.state, done.reviews[id(n)]?.rounds[0]?.reviewer]),
  ).toEqual([
    ["done", "codex"],
    ["done", "claude"],
  ]);

  // "Run all checks" from the pill: each check's result, the AIs read again.
  const events = await stream(door, done.seq);
  expect((await send(door, { type: "service.runChecks" })).status).toBe(200);
  await until(events, "service.changed");
  await until(events, "service.changed");
  const checked = (await snapshotOf(door)).service.checks;
  expect(checked).toMatchObject({ at: T0 + 8 * MIN, running: false });
  expect(checked?.items.map((item) => item.check)).toEqual([
    "engine",
    "engine",
    "connection",
    "service",
    "settings",
    "disk",
    "version",
  ]);
  expect(checked?.items.slice(0, 3)).toEqual([
    { check: "engine", engine: "claude", state: "ready", cli: "claude", version: "2.4.1", unusable: null },
    { check: "engine", engine: "codex", state: "ready", cli: "codex", version: "0.162.1", unusable: null },
    // The App's key as demo mode keeps it: in the room's keychain (ADR 0053).
    {
      check: "connection",
      state: "connected",
      cause: null,
      bot: "lookover-spike-sasensi[bot]",
      key: "keychain",
    },
  ]);
});

test("S10, a quiet day: six pull requests seen since early morning, more than Home lists without its search; the last hour's three, one clean, one settled after two rounds, one skipped; nothing waits", async () => {
  const state = await loaded("S10");
  // The seed is two and a half hours long: the service has run since then.
  expect(state.service.since).toBe(T0 - 150 * MIN);
  expect(Object.keys(state.changes).sort()).toEqual([135, 137, 139, 141, 144, 146].map(id));
  // Nothing waits or runs; every review ended within the last two and a half hours, so all of them are today's,
  // and six is more than the four Home lists before it offers to search.
  const reviews = Object.values(state.reviews);
  expect(reviews.every((r) => r.run === null && T0 - r.updatedAt < 150 * MIN)).toBe(true);
  expect(reviews.map((r) => r.job?.state).sort()).toEqual([
    "done",
    "done",
    "done",
    "done",
    "skipped",
    "skipped",
  ]);

  // #135, the owner's, first thing: one clean round.
  expect(state.changes[id(135)]).toMatchObject({ author: "you", openedAt: T0 - 149 * MIN });
  expect(state.reviews[id(135)]?.rounds.map((r) => [r.reviewer, r.raised])).toEqual([["claude", 0]]);
  expect(state.reviews[id(135)]?.loop).toBe("settled");
  // #137, mira's: skipped.
  expect(state.changes[id(137)]).toMatchObject({ author: "other", openedBy: "mira" });
  expect(state.reviews[id(137)]?.job).toMatchObject({ state: "skipped", skip: "not-yours" });
  // #139, the owner's: Claude found one, Codex confirmed it; no commit since, so it is still to fix.
  const left = state.reviews[id(139)];
  expect(left?.rounds.map((r) => [r.reviewer, r.confirmer, r.raised, r.open])).toEqual([
    ["claude", "codex", 1, 1],
  ]);
  expect(
    left?.findings.map((f) => [f.id, f.severity, f.status, f.file, f.line, f.confirmation.verdict]),
  ).toEqual([["F1", "should_fix", "open", "src/rates/cache.ts", 10, "confirmed"]]);
  // It follows the repository's first rule, and says so.
  expect(left?.findings.map((f) => [f.rule?.file, f.rule?.line, f.why.ruleText])).toEqual([
    ["REVIEW.md", 3, "Every cache says when its entries expire."],
  ]);
  expect(left?.loop).toBe("open");
  // main's REVIEW.md, counted: #139's finding raised under the first rule, #146's first under the second, fixed.
  expect(state.rules.map((r) => [r.source, r.line, r.raised, r.acted, r.enabled])).toEqual([
    ["REVIEW.md", 3, 1, 0, true],
    ["REVIEW.md", 4, 1, 1, true],
    ["REVIEW.md", 5, 0, 0, true],
    ["REVIEW.md", 6, 0, 0, true],
  ]);
  expect(state.changes[id(139)]).toMatchObject({ newCommits: 0 });

  expect(state.service.paused).toBeNull();
  expect(state.engines.claude).toMatchObject({ state: "ready", version: "2.4.1" });
  expect(state.engines.codex).toMatchObject({ state: "ready", version: "0.162.1" });
  expect(state.connection).toMatchObject({ state: "connected", bot: "lookover-spike-sasensi[bot]" });
  expect(state.repos.map((r) => r.id)).toEqual([repositoryId("sasensi/lookover-sandbox")]);

  // #141, the owner's own, opened 39 minutes ago: one clean round, Claude finding, nothing to confirm.
  expect(state.changes[id(141)]).toMatchObject({ author: "you", writtenBy: null, openedAt: T0 - 39 * MIN });
  const clean = state.reviews[id(141)];
  expect(clean?.job).toMatchObject({ state: "done", trigger: "opened" });
  expect(clean?.rounds).toHaveLength(1);
  expect(clean?.rounds[0]).toMatchObject({ n: 1, reviewer: "claude", confirmer: null, raised: 0, open: 0 });
  expect(clean?.rounds[0]?.steps).toEqual([
    { step: "preparing", ms: 0 },
    { step: "finding", ms: 130_000 },
    { step: "publishing", ms: 0 },
  ]);
  expect(clean?.findings).toEqual([]);
  expect(clean?.loop).toBe("settled");

  // #144, dependabot's: skipped when it opened, and the check says why.
  expect(state.changes[id(144)]).toMatchObject({ author: "other", openedBy: "dependabot[bot]" });
  expect(state.reviews[id(144)]?.job).toMatchObject({ state: "skipped", skip: "not-yours" });
  expect(state.reviews[id(144)]?.rounds).toEqual([]);

  // #146, written by Claude: Codex found two, Claude confirmed both; the agent pushed the fix and asked again;
  // round 2 verified both fixed. Settled.
  expect(state.changes[id(146)]).toMatchObject({ author: "you", writtenBy: "claude", newCommits: 0 });
  const settled = state.reviews[id(146)];
  expect(settled?.job).toMatchObject({ state: "done", trigger: "comment" });
  expect(
    settled?.rounds.map((r) => [r.n, r.reviewer, r.confirmer, r.raised, r.verifiedFixed, r.open]),
  ).toEqual([
    [1, "codex", "claude", 2, 0, 2],
    [2, "codex", null, 0, 2, 0],
  ]);
  expect(settled?.rounds[0]?.steps).toEqual([
    { step: "preparing", ms: 0 },
    { step: "finding", ms: 130_000 },
    { step: "confirming", ms: 58_000 },
    { step: "publishing", ms: 0 },
  ]);
  expect(settled?.findings.map((f) => [f.id, f.severity, f.status, f.file, f.line, f.foundBy])).toEqual([
    ["F1", "blocking", "verified_fixed", "src/webhooks/deliver.ts", 9, "codex"],
    ["F2", "should_fix", "verified_fixed", "src/webhooks/deliver.ts", 11, "codex"],
  ]);
  expect(settled?.findings.map((f) => f.confirmation.verdict)).toEqual(["confirmed", "confirmed"]);
  expect(settled?.loop).toBe("settled");
  expect(settled?.timeline.map((t) => t.kind)).toEqual([
    "opened",
    "queued",
    "started",
    "posted",
    "pushed",
    "queued",
    "started",
    "posted",
  ]);
  // Nine minutes apart, as the script says: opened at 19 minutes, pushed at 28.
  expect(settled?.timeline[0]?.at).toBe(T0 - 21 * MIN);
  expect(settled?.timeline[4]?.at).toBe(T0 - 12 * MIN);
});

test("S9, the one repository: two values of its own, one reset from the app and gone from its file; turned off, a pull request opened there is skipped", async () => {
  await loaded("S9");
  // What it can't show yet is said in the drawer: other repositories.
  const { body } = await listing(door);
  const s9 = body.scenarios.find((s: { id: string }) => s.id === "S9");
  expect(s9).toMatchObject({ title: "The one repository", path: "/repositories" });
  expect(s9.later).not.toContain("row 4");
  expect(s9.later).toContain("row 7");

  const state = await snapshotOf(door);
  expect(state.repos).toHaveLength(1);
  const [repo] = state.repos;
  expect(repo).toMatchObject({ id: SANDBOX, owner: "sasensi", name: "lookover-sandbox", enabled: true });
  // Two values of its own, planted in its file; the rest follow the defaults. Reset in the app, one leaves the file.
  const own = (r: typeof repo) =>
    Object.entries(r?.settings ?? {}).filter(([, s]) => s.origin === "owner-repository");
  expect(own(repo).map(([key, s]) => [key, s.value])).toEqual([
    ["strictness", "blocking"],
    ["onPush", true],
  ]);
  const room = readdirSync(join(door.home, "rooms")).find((r) => r.endsWith("-S9")) ?? "";
  const file = join(door.home, "rooms", room, "sasensi", "lookover-sandbox", "settings.yaml");
  expect(readFileSync(file, "utf8")).toContain("onPush: true");
  const reset = { type: "repo.resetSetting", repoId: SANDBOX, key: "onPush" } as const;
  expect((await send(door, reset)).status).toBe(200);
  expect(own((await snapshotOf(door)).repos[0]).map(([key]) => key)).toEqual(["strictness"]);
  expect(readFileSync(file, "utf8")).not.toContain("onPush");
  // #168 was reviewed and merged this morning; #169 and #170 are open, each reviewed once, clean.
  expect(Object.keys(state.changes).sort()).toEqual([id(169), id(170)]);
  expect(Object.values(state.changes).every((c) => c.repoId === SANDBOX)).toBe(true);
  expect(state.reviews[id(168)]?.rounds).toHaveLength(1);
  const last = Math.max(...Object.values(state.reviews).map((r) => r.updatedAt));
  expect(T0 - last).toBe(8 * MIN - 75_000);

  // The page's switch: off, the agent's next pull request is listed and nothing reviews it; asked for by hand, the
  // review is recorded as skipped, and says why.
  expect((await send(door, { type: "repo.setEnabled", repoId: SANDBOX, enabled: false })).status).toBe(200);
  expect((await snapshotOf(door)).repos[0]?.enabled).toBe(false);
  expect((await send(door, { type: "demo.inject", fault: "agent-opens-change" })).status).toBe(200);
  await advance(door, 2 * MIN);
  const off = await snapshotOf(door);
  expect(off.changes[id(171)]).toMatchObject({ writtenBy: "claude" });
  expect(off.reviews[id(171)]).toMatchObject({ job: null, rounds: [] });
  expect((await send(door, { type: "review.request", changeId: id(171) })).status).toBe(200);
  expect((await snapshotOf(door)).reviews[id(171)]?.job).toMatchObject({
    state: "skipped",
    skip: "repo-off",
  });
  expect((await send(door, { type: "repo.setEnabled", repoId: SANDBOX, enabled: true })).status).toBe(200);
  expect((await snapshotOf(door)).repos[0]?.enabled).toBe(true);
});

test("S11, phone glance: a service reached from elsewhere shows view-only until unlocked; Unlock unlocks it once", async () => {
  await loaded("S11");
  const { body } = await listing(door);
  const s11 = body.scenarios.find((s: { id: string }) => s.id === "S11");
  expect(s11).toMatchObject({ title: "Phone glance", path: "/" });
  // The remote service is the demo's own: no service is reached from elsewhere until a server mode exists.
  expect(s11.later).toContain("server mode");

  const state = await snapshotOf(door);
  expect(state.service).toMatchObject({ remote: true, unlocked: false });
  // Something to glance at: a finding to fix on #180, and #181 being reviewed right now.
  expect(state.reviews[id(180)]?.findings.map((f) => `${f.id} ${f.status}`)).toEqual(["F1 open"]);
  expect(state.reviews[id(181)]?.run).toMatchObject({ reviewer: "claude", step: "finding" });

  // "Unlock": the session unlocked, one event; asked again, nothing more.
  const events = await stream(door, state.seq);
  expect((await send(door, { type: "service.unlock" })).status).toBe(200);
  const unlocked = await until(events, "service.changed");
  expect(unlocked.map((e) => e.type)).toEqual(["service.changed"]);
  expect((await snapshotOf(door)).service).toMatchObject({ remote: true, unlocked: true });
  expect((await send(door, { type: "service.unlock" })).status).toBe(200);
  expect((await snapshotOf(door)).seq).toBe(state.seq + 1);
});

test("S12, everything through the keyboard: the richest Home, a review waiting on a signed-out Claude with Codex ready, one running, new commits; the reroute sends the waiting one to Codex", async () => {
  await loaded("S12");
  const state = await snapshotOf(door);
  // The App on all seven of the owner's repositories, each watched.
  expect(state.repos.map((r) => [r.id, r.enabled])).toEqual(
    ["lookover-sandbox", "ledger-api", "ledger-web", "invoice-pdf", "mobile-app", "infra", "dotfiles"].map(
      (name) => [repositoryId(`sasensi/${name}`), true],
    ),
  );
  expect(state.engines.claude.state).toBe("signed-out");
  expect(state.engines.codex.state).toBe("ready");
  // #190: reviewed this morning, a finding to fix, and the owner pushed a commit since: "Review again".
  expect(state.changes[id(190)]).toMatchObject({ author: "you", newCommits: 1 });
  expect(state.reviews[id(190)]?.job).toMatchObject({ state: "done" });
  expect(state.reviews[id(190)]?.findings.map((f) => `${f.id} ${f.status}`)).toEqual(["F1 open"]);
  // #191, the owner's: Claude would find, but it signed out; Codex may step in.
  expect(state.reviews[id(191)]?.job).toMatchObject({
    state: "deferred",
    deferral: { reason: "engine-signed-out", engine: "claude" },
    stepIn: "codex",
  });
  // #192, written by Claude: Codex is finding right now.
  expect(state.reviews[id(192)]?.run).toMatchObject({ reviewer: "codex", step: "finding" });

  // "Send the waiting review to Codex": #191 goes to Codex, behind the review Codex is running.
  expect((await send(door, { type: "engine.reroute", from: "claude" })).status).toBe(200);
  expect((await snapshotOf(door)).reviews[id(191)]?.job).toMatchObject({ state: "queued", deferral: null });
  await advance(door, 2 * MIN);
  const turn = await snapshotOf(door);
  expect(turn.reviews[id(192)]?.job).toMatchObject({ state: "done" });
  expect(turn.reviews[id(191)]?.run).toMatchObject({ reviewer: "codex" });
  await advance(door, 3 * MIN);
  const done = await snapshotOf(door);
  expect(done.reviews[id(191)]?.job).toMatchObject({ state: "done" });
  expect(done.reviews[id(191)]?.rounds.map((r) => [r.reviewer, r.raised])).toEqual([["codex", 0]]);
});

test("S13, service problems: GitHub out of reach until Reconnect finds it back; both AIs missing until Check again finds them installed", async () => {
  await loaded("S13");
  const seeded = await snapshotOf(door);
  expect(seeded.connection.state).toBe("connected");
  expect(seeded.reviews[id(200)]?.job).toMatchObject({ state: "done" });

  // Forty seconds on, GitHub stops answering: the connection shows it at once.
  await advance(door, 40_000);
  expect((await snapshotOf(door)).connection).toMatchObject({ state: "disconnected", since: T0 + 40_000 });
  // "Reconnect GitHub" while it is still down: refused, and still disconnected.
  const early = await send(door, { type: "connection.reconnect" });
  expect(early.status).toBe(502);
  expect((await snapshotOf(door)).connection.state).toBe("disconnected");
  // Two and a half minutes later GitHub answers again; "Reconnect GitHub" finds it before the next poll would.
  await advance(door, 150_000 + 1_000);
  expect((await snapshotOf(door)).connection.state).toBe("disconnected");
  expect((await send(door, { type: "connection.reconnect" })).status).toBe(200);
  expect((await snapshotOf(door)).connection).toMatchObject({ state: "connected", since: T0 + 191_000 });

  // Six minutes in, both AIs' programs are gone.
  await advance(door, 6 * MIN - 191_000);
  const missing = await snapshotOf(door);
  expect([missing.engines.claude.state, missing.engines.codex.state]).toEqual(["missing", "missing"]);
  // "Check again" before they are back: still missing.
  expect((await send(door, { type: "engine.check" })).status).toBe(200);
  expect((await snapshotOf(door)).engines.claude.state).toBe("missing");
  // Two minutes later they are installed again; nothing says so until "Check again".
  await advance(door, 2 * MIN);
  expect((await snapshotOf(door)).engines.codex.state).toBe("missing");
  expect((await send(door, { type: "engine.check" })).status).toBe(200);
  const back = await snapshotOf(door);
  expect(back.engines.claude).toMatchObject({ state: "ready", version: "2.4.1" });
  expect(back.engines.codex).toMatchObject({ state: "ready", version: "0.162.1" });
});

// S14 "The planted sandbox": the stages `bun run proof` shoots in place of the `service-*` story, each test
// loading S14 and advancing from the load to its stage. The words of #1's rounds are the recordings'.
const PLANTED = id(1);
const PLANTED_SHA = commitSha("703205dec59961a3a08427d7b4af007e278451a4");
const FIX_SHA = commitSha("4700cffcc191fa0290cc7d91340f924a74c7f803");

/** S14 loaded and advanced `ms` from the load: one stage of the story; the snapshot there, and the door. */
async function s14At(ms: number) {
  await loaded("S14");
  if (ms > 0) await advance(door, ms);
  return { door, state: await snapshotOf(door) };
}

/** #1 round by round: number, commit, finder, confirmer, raised, verified fixed, open, ruled out. */
const roundsOf = (state: State) =>
  state.reviews[PLANTED]?.rounds.map((r) => [
    r.n,
    r.sha,
    r.reviewer,
    r.confirmer,
    r.raised,
    r.verifiedFixed,
    r.open,
    r.ruledOut.length,
  ]);
/** #1 finding by finding: id, severity, status, line, the confirmer's verdict. */
const findingsOf = (state: State) =>
  state.reviews[PLANTED]?.findings.map((f) => [
    String(f.id),
    f.severity,
    f.status,
    f.line,
    f.confirmation.verdict,
  ]);

test("S14 plays the program's command: a tab without the session is told the binary's `open`; other scenarios name none (ADR 0058)", async () => {
  const signedOut = async () => {
    const res = await fetch(`${door.service.origin}/api/v1/snapshot`);
    expect(res.status).toBe(401);
    return res.json();
  };
  await loaded("S10");
  expect(await signedOut()).toEqual({ error: "no session" });
  const { state } = await s14At(0);
  const binary = String.raw`& 'C:\Users\Your Name\Downloads\lookover.exe'`;
  expect(state.service.command).toBe(binary);
  expect(await signedOut()).toEqual({ error: "no session", open: `${binary} open` });
});

test("S14 at load: #2 reviewed clean, #3 a draft, and round 1 of the planted #1 finding", async () => {
  const { state } = await s14At(0);
  expect(state.now).toBe(T0);
  expect(state.engines.claude).toMatchObject({ state: "ready", version: "2.1.283" });
  expect(state.engines.codex).toMatchObject({ state: "ready", version: "0.162.1" });
  expect(Object.keys(state.changes).sort()).toEqual([id(1), id(2), id(3)]);
  expect(state.reviews[id(2)]?.rounds.map((r) => [r.reviewer, r.raised])).toEqual([["claude", 0]]);
  expect(state.changes[id(3)]).toMatchObject({ draft: true });
  expect(state.reviews[id(3)]?.job).toBeNull();
  // Opened ten seconds ago: Claude is finding, Codex will confirm.
  expect(state.changes[PLANTED]).toMatchObject({ headSha: PLANTED_SHA, openedAt: T0 - 10_000 });
  expect(state.reviews[PLANTED]?.job).toMatchObject({ state: "running", trigger: "opened" });
  expect(state.reviews[PLANTED]?.run).toMatchObject({
    reviewer: "claude",
    confirmer: "codex",
    step: "finding",
  });
});

/** What an engine did in a pass of #1's run, as the live log holds it (ADR 0055). */
const did = (engine: EngineId, pass: RunPass, activity: EngineActivity): RunActivity => ({
  engine,
  pass,
  activity,
});
/** Claude's tool calls in round 1's find, as its recording has them: `service-review-running-log`'s lines. */
const ROUND_1_FIND = [
  did("claude", "find", { kind: "search", pattern: "legacy-name|listInvoices|unpaid|apiKey" }),
  did("claude", "find", { kind: "list", pattern: "**/*.{ts,js,json}" }),
];

test("S14 at load, the live log holds what Claude did so far in round 1's find, from its recording", async () => {
  const { state } = await s14At(0);
  expect(state.reviews[PLANTED]?.run?.activities).toEqual(ROUND_1_FIND);
});

test("S14 half a minute on, Codex double-checks: its commands follow Claude's, their shell wrapper gone", async () => {
  const { state } = await s14At(30_000);
  expect(state.reviews[PLANTED]?.run?.step).toBe("confirming");
  expect(state.reviews[PLANTED]?.run?.activities).toEqual([
    ...ROUND_1_FIND,
    did("codex", "confirm", {
      kind: "command",
      text: "Get-Location; rg --files -g '!node_modules' -g '!\\.git'; git status --short; git show --format=fuller --stat HEAD; git show HEAD -- src/invoices.ts",
    }),
    did("codex", "confirm", {
      kind: "command",
      // Cut at 200 characters, as every activity's text is.
      text: "$files = @('src/invoices.ts', 'src/greeting.ts', 'README.md'); foreach ($file in $files) { Write-Output $file; $line = 0; Get-Content -LiteralPath $file | ForEach-Object { $line++; '{0}: {1}' -f $line",
    }),
  ]);
});

test("S14 a minute on, round 1 posted: the run and its lines are gone, as `service-review-ended-log` shows", async () => {
  const { state } = await s14At(MIN);
  expect(state.reviews[PLANTED]?.rounds).toHaveLength(1);
  expect(state.reviews[PLANTED]?.run).toBeNull();
});

test("S14 round 1, two minutes on: Claude's three candidates, Codex confirms one, is unsure of one, rules out the tests", async () => {
  const { state } = await s14At(2 * MIN);
  expect(state.reviews[PLANTED]?.job).toMatchObject({ state: "done" });
  expect(roundsOf(state)).toEqual([[1, PLANTED_SHA, "claude", "codex", 2, 0, 2, 1]]);
  // Claude's find as recorded, Codex's confirm as chosen.
  expect(state.reviews[PLANTED]?.rounds[0]?.steps).toEqual([
    { step: "preparing", ms: 0 },
    { step: "finding", ms: 23_889 },
    { step: "confirming", ms: 41_000 },
    { step: "publishing", ms: 0 },
  ]);
  expect(findingsOf(state)).toEqual([
    ["F1", "blocking", "open", 9, "confirmed"],
    ["F2", "should_fix", "open", 10, "unsure"],
  ]);
  const [ruledOut] = state.reviews[PLANTED]?.rounds[0]?.ruledOut ?? [];
  expect(ruledOut).toMatchObject({
    by: "codex",
    candidate: { defectKey: "missing_tests", severity: "consider", foundBy: "claude" },
    reason: "The repository has no tests at all, so this change leaves nothing less tested than before.",
  });
});

test("S14 the fix pushed, three minutes on: #1 has a new commit, nothing asked yet", async () => {
  const { state } = await s14At(3 * MIN);
  expect(state.changes[PLANTED]).toMatchObject({ headSha: FIX_SHA, newCommits: 1 });
  expect(state.reviews[PLANTED]?.job).toMatchObject({ sha: PLANTED_SHA, state: "done" });
  expect(state.reviews[PLANTED]?.timeline.at(-1)).toMatchObject({ kind: "pushed", sha: FIX_SHA });
});

test("S14 round 2, five minutes on: the key no longer logged, the cap still gone, the eval found and confirmed", async () => {
  const { state } = await s14At(5 * MIN);
  expect(state.changes[PLANTED]).toMatchObject({ newCommits: 0 });
  expect(state.reviews[PLANTED]?.job).toMatchObject({ sha: FIX_SHA, trigger: "manual", state: "done" });
  expect(roundsOf(state)).toEqual([
    [1, PLANTED_SHA, "claude", "codex", 2, 0, 2, 1],
    [2, FIX_SHA, "claude", "codex", 1, 1, 2, 0],
  ]);
  expect(findingsOf(state)).toEqual([
    ["F1", "blocking", "verified_fixed", 9, "confirmed"],
    ["F2", "should_fix", "open", 10, "unsure"],
    ["F3", "blocking", "open", 17, "confirmed"],
  ]);
  expect(state.reviews[PLANTED]?.loop).toBe("open");
});

test("S14 #2 closed on GitHub, six minutes on: it leaves the list", async () => {
  const { state } = await s14At(6 * MIN);
  expect(Object.keys(state.changes).sort()).toEqual([id(1), id(3)]);
});

test("S14 paused for an hour, eight minutes on: “Review now” on #1 waits for the resume", async () => {
  const { state } = await s14At(8 * MIN);
  expect(state.service.paused).toEqual({ since: T0 + 6 * MIN + 20_000, until: T0 + 66 * MIN + 20_000 });
  expect(state.reviews[PLANTED]?.job).toMatchObject({
    sha: FIX_SHA,
    state: "deferred",
    deferral: { reason: "paused" },
  });
});

test("S14 the drawer's fault at the pause: a newer Codex fails its self-test", async () => {
  const { door } = await s14At(8 * MIN);
  expect(await inject(door, "codex-failed-self-test")).toBe(200);
  await advance(door, 0);
  const state = await snapshotOf(door);
  expect(state.engines.codex).toMatchObject({ state: "failed-self-test", version: "0.163.0" });
  expect(state.engines.claude).toMatchObject({ state: "ready" });
});
