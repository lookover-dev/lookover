// The run's rounds: "Review now" on the planted sandbox, round 1, the fix pushed and round 2, through the real
// retrieval, engines, review, reconcile and publish, with git on a local bare repository, the fake claude finding
// and the fake codex confirming, as in demo mode (ADR 0039, ADR 0044). What only the queue decides (a deferral while
// Claude is signed out, the re-ask that puts it back in line, who confirms when Codex can't) is tested on fakes, in
// `queue.test.ts` and `confirm.test.ts`: this file spends its time on git and the fake programs alone.
import { afterAll, afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  apply,
  type CommitSha,
  isCounted,
  jobId,
  type ReviewJob,
  readResult,
  repositoryId,
  reviewResultV1,
  type State,
} from "@lookover/contracts";
import {
  api,
  FIXED,
  home,
  messages,
  onFake,
  openApp,
  PLANTED,
  plantedSandbox,
  post,
  pushFix,
  realRetrieval,
  review,
  SANDBOX,
  snapshot,
  start,
  stopAll,
  T0,
  TEST_LIMIT_MS,
  until,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const { dir: sandboxDir, sandbox, head: HEAD, remove } = plantedSandbox();
afterAll(remove);
const plantedAuthor = sandbox.changes[0]?.author;
if (!plantedAuthor) throw new Error("the planted sandbox has no pull request");

test("round 1 posts in order with a valid result; the fix pushed, round 2 verifies it and posts what is new", async () => {
  const dir = home();
  const { service, host } = await start({
    home: dir,
    engines: onFake(dir, ["review", "review-round-2"], { codex: ["confirm-mixed", "confirm-round-2"] }),
    retrieval: realRetrieval(dir),
    changes: sandbox.changes,
    cloneUrl: sandbox.cloneUrl,
    // The planted change is the owner's, as in demo mode: Codex may confirm it (ADR 0044).
    owner: plantedAuthor,
  });
  const cookie = await openApp(service);
  const before: State = await snapshot(service, cookie);
  expect(before.engines.claude.state).toBe("ready");
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect(before.changes[PLANTED]?.headSha).toBe(HEAD);

  // "Review now": the job is recorded and the take starts it at once; the round goes all the way through, on the
  // recorded real review of the planted bugs (`review`: three findings, one per severity).
  expect((await review(service, cookie)).status).toBe(200);
  const events = await until(stream, "round.finished");
  expect(events.map((e) => e.type)).toEqual([
    "job.changed",
    "run.started",
    "run.step",
    "run.activity",
    "run.step",
    "run.step",
    "run.posting",
    "run.posting",
    "run.posting",
    "run.posting",
    "run.posting",
    "round.finished",
  ]);
  const queued: ReviewJob = {
    id: jobId("id-1"),
    sha: HEAD,
    trigger: "manual",
    state: "queued",
    deferral: null,
    stepIn: null,
    skip: null,
    cancel: null,
    failure: null,
    turn: null,
  };
  const running: ReviewJob = { ...queued, state: "running" };
  expect(events[0]).toMatchObject({ type: "job.changed", changeId: PLANTED, job: queued });
  expect(events[1]).toMatchObject({
    type: "run.started",
    changeId: PLANTED,
    job: running,
    run: {
      id: "id-2",
      reviewer: "claude",
      confirmer: "codex",
      confirmFallback: null,
      sha: HEAD,
      preview: false,
      startedAt: T0,
      step: "preparing",
      stepAt: T0,
      steps: [],
    },
  });
  expect(events[2]).toMatchObject({ type: "run.step", step: "finding" });
  // The recording's first tool call, at once; its Glob a moment later waits a second the held clock never gives,
  // and goes with the run (ADR 0055: at most one event a second).
  expect(events[3]).toMatchObject({
    type: "run.activity",
    changeId: PLANTED,
    at: T0,
    activities: [
      {
        engine: "claude",
        pass: "find",
        activity: { kind: "search", pattern: "legacy-name|listInvoices|unpaid|apiKey" },
      },
    ],
  });
  expect(events[4]).toMatchObject({ type: "run.step", step: "confirming" });
  expect(events[5]).toMatchObject({ type: "run.step", step: "publishing" });
  const finished = events.at(-1);
  if (finished?.type !== "round.finished") throw new Error("no round");
  expect(finished).toMatchObject({
    changeId: PLANTED,
    job: { ...running, state: "done" },
    newCommits: 0,
    // The recording's three candidates, double-checked by Codex (its `confirm-mixed`): the blocking one
    // confirmed, the should_fix one unsure, kept; the consider one refuted, ruled out.
    round: {
      n: 1,
      sha: HEAD,
      reviewer: "claude",
      confirmer: "codex",
      confirmFallback: null,
      confirmFailure: null,
      startedAt: T0,
      endedAt: T0,
      raised: 2,
      verifiedFixed: 0,
      open: 2,
      steps: [
        { step: "preparing", ms: 0 },
        { step: "finding", ms: 0 },
        { step: "confirming", ms: 0 },
        { step: "publishing", ms: 0 },
      ],
    },
    loop: "open",
  });
  expect(finished.findings.map((f) => `${f.id} ${f.severity} ${f.file}:${f.line} ${f.posted}`)).toEqual([
    "F1 blocking src/invoices.ts:9 true",
    "F2 should_fix src/invoices.ts:10 true",
  ]);
  // The UI gets the findings as the store holds them once the review landed: each commented on GitHub (rule 3).
  expect(finished.findings.map((f) => [String(f.id), f.commented])).toEqual([
    ["F1", true],
    ["F2", true],
  ]);
  expect(finished.findings).toEqual((await snapshot(service, cookie)).reviews[PLANTED]?.findings ?? []);
  expect(finished.findings.map((f) => [f.confirmation.verdict, f.foundBy])).toEqual([
    ["confirmed", "claude"],
    ["unsure", "claude"],
  ]);
  expect(finished.findings[0]?.confirmation).toMatchObject({
    by: "codex",
    evidence: ["src/invoices.ts:9", "src/invoices.ts:10"],
  });
  // The ruled-out candidate keeps where the recording put it: its side and its range (lines 13 to 15).
  expect(
    finished.round.ruledOut.map((r) => [r.candidate.title, r.candidate.location, r.by, r.reason]),
  ).toEqual([
    [
      "No tests for unpaid(), the total() rewrite, or the change to listInvoices paging",
      { path: "src/invoices.ts", side: "head", line: 13, endLine: 15 },
      "codex",
      "The repository has no tests at all, so this change leaves nothing less tested than before.",
    ],
  ]);

  // What GitHub received: the job's one check, waiting its turn, then in
  // progress (ADR 0043), then the round in the fixed order (ADR 0039), the result as the check's last line, valid.
  expect(
    host.posts.map((p) => (p.kind === "check.updated" ? `${p.kind} ${p.output.title}` : p.kind)),
  ).toEqual([
    "check.created",
    "check.updated Looking over 703205d",
    "review",
    "summary.created",
    "check.completed",
  ]);
  const completed = host.posts[4];
  if (completed?.kind !== "check.completed") throw new Error("no completed check");
  expect(completed.checkId).toBe(host.posts[0]?.kind === "check.created" ? host.posts[0].checkId : "");
  // A blocking finding is open on the pull request: neutral, never failure (ADR 0006).
  expect(completed.conclusion).toBe("neutral");
  expect(completed.output.title).toBe("Looked over 703205d: 2 things to fix");
  const result = readResult(completed.output.text);
  expect(reviewResultV1.safeParse(result).success).toBe(true);
  // The check's count is the posted findings still open, two, and the result says the same (I-152).
  expect(finished.round.open).toBe(2);
  expect(finished.findings.filter(isCounted).map((f) => String(f.id))).toEqual(["F1", "F2"]);
  expect(result?.findings.filter((f) => f.posted).map((f) => f.id)).toEqual(["F1", "F2"]);
  expect(result?.findings.map((f) => f.id)).toEqual(["F1", "F2"]);
  // Each finding where the recording put it, its side and its line; and what the confirmer said of it.
  expect(
    result?.findings.map(
      (f) =>
        `${f.id} ${f.location?.side} ${f.location?.start_line}-${f.location?.end_line} ${f.confirmation.verdict}`,
    ),
  ).toEqual(["F1 head 9-9 confirmed", "F2 head 10-10 unsure"]);
  expect(result?.run.engine).toEqual({ finder: "claude", confirmer: "codex" });
  expect(result?.verdict).toMatchObject({ value: "blocking", conclusion: "neutral" });
  // `core`'s facts through the real wiring: the host is the change's; the agent fixes what is open and posted.
  expect(result?.change.host).toBe("github");
  expect(result?.loop).toEqual({ state: "open", round: 1, next_action: "fix" });
  expect(result?.findings.map((f) => `${f.id} ${f.needs_action_by}`)).toEqual(["F1 agent", "F2 agent"]);
  expect(result?.counts).toEqual({
    open: { blocking: 1, should_fix: 1, consider: 0 },
    escalated: 0,
    verified_fixed: 0,
    withdrawn: 0,
    acknowledged: 0,
    dismissed: 0,
    obsolete: 0,
    kept_in_app: 0,
  });

  // The raw output of the run is kept in the data folder (story 27).
  expect(existsSync(join(dir, "runs", "id-1", "id-2", "find", "stdout.jsonl"))).toBe(true);
  expect(existsSync(join(dir, "runs", "id-1", "id-2", "confirm", "prompt.md"))).toBe(true);

  // A tab that followed the events and one that loads the snapshot see the same thing; the round carries the
  // counts it moved (ADR 0049): one review, its Should fix posted one below blocking.
  const state: State = await snapshot(service, cookie);
  expect(state).toEqual(events.reduce(apply, before));
  expect(finished.noise).toEqual({
    repoId: repositoryId("sasensi/lookover-sandbox"),
    counts: { reviews: 1, postedBelowBlocking: 1, raisedByRule: {} },
  });
  expect(state.repos[0]?.noise).toEqual(finished.noise?.counts);
  expect(state.reviews[PLANTED]?.rounds).toHaveLength(1);
  expect(state.engines.claude.state).toBe("ready");

  // A fake push: the planted pull request gets its fix commit, and the host shows the new head. It goes through
  // the poll, as a push seen on GitHub does: counted (one commit), and no review asked with the switch off.
  pushFix(host, sandboxDir);
  expect((await post(service, cookie, { type: "refresh" })).status).toBe(200);
  expect((await until(stream, "change.pushed")).at(-1)).toMatchObject({
    type: "change.pushed",
    changeId: PLANTED,
    sha: FIXED,
    commits: 1,
  });

  // Round 2 on the fix commit, with round 1's open findings in the prompt (the `review-round-2` recording:
  // the logged key is gone, the cap is still missing, the new eval is blocking, confirmed by `confirm-round-2`).
  // The fixed finding is verified fixed on the fix commit; the one reported again keeps its identity; the new
  // blocking one is posted, numbered after the ledger's last (the ruled-out candidate never had a number); the
  // summary is edited, not posted again.
  expect((await review(service, cookie)).status).toBe(200);
  const second = await until(stream, "round.finished");
  expect(second.map((e) => e.type)).toEqual([
    "job.changed",
    "run.started",
    "run.step",
    "run.activity",
    "run.step",
    "run.step",
    "run.posting",
    "run.posting",
    "run.posting",
    "run.posting",
    "run.posting",
    "round.finished",
  ]);
  const round2 = second.at(-1);
  if (round2?.type !== "round.finished") throw new Error("no round 2");
  expect(round2).toMatchObject({
    changeId: PLANTED,
    job: { id: "id-3", sha: FIXED, state: "done" },
    round: { n: 2, sha: FIXED, raised: 1, verifiedFixed: 1, open: 2 },
    loop: "open",
  });
  expect(
    round2.findings.map((f) => `${f.id} ${f.severity} ${f.file}:${f.line} ${f.status} ${f.posted}`),
  ).toEqual([
    "F1 blocking src/invoices.ts:9 verified_fixed true",
    "F2 should_fix src/invoices.ts:10 open true",
    "F3 blocking src/invoices.ts:17 open true",
  ]);
  expect(round2.findings[0]).toMatchObject({ closedIn: 2, verifiedSha: FIXED, raisedIn: 1 });
  expect(round2.findings[2]).toMatchObject({ raisedIn: 2, closedIn: null, category: "security" });
  // Only the new finding went to round 2's confirm pass; the earlier ones keep round 1's verdicts.
  expect(round2.round).toMatchObject({ confirmer: "codex", ruledOut: [] });
  expect(round2.findings.map((f) => f.confirmation.verdict)).toEqual(["confirmed", "unsure", "confirmed"]);
  expect(round2.findings[2]?.confirmation).toMatchObject({ by: "codex", verdict: "confirmed" });

  // Two reviews, one summary created then edited, two checks; the second check names the fix commit.
  expect(host.posts.map((p) => p.kind)).toEqual([
    "check.created",
    "check.updated",
    "review",
    "summary.created",
    "check.completed",
    "check.created",
    "check.updated",
    "review",
    "summary.edited",
    "check.completed",
  ]);
  const shown = host.view({ repo: SANDBOX, number: 1 });
  expect(shown.reviews.map((r) => r.sha)).toEqual([HEAD, FIXED]);
  expect(shown.comments).toHaveLength(1);
  // One check per commit: the view shows the head's, or the commit's named.
  const checks = (sha?: CommitSha) =>
    host.view({ repo: SANDBOX, number: 1 }, sha).checks.map((c) => `${c.sha} ${c.status} ${c.conclusion}`);
  expect(checks(HEAD)).toEqual([`${HEAD} completed neutral`]);
  expect(checks()).toEqual([`${FIXED} completed neutral`]);
  const completed2 = host.posts[9];
  if (completed2?.kind !== "check.completed") throw new Error("no second completed check");
  expect(completed2.output.title).toBe("Looked over 4700cff: 2 things to fix");
  const result2 = readResult(completed2.output.text);
  expect(reviewResultV1.safeParse(result2).success).toBe(true);
  expect(result2?.findings.map((f) => `${f.id} ${f.posted} ${f.status}`)).toEqual([
    "F3 true open",
    "F2 true open",
    "F1 true verified_fixed",
  ]);
  // Round 2's facts: F3 is new and posted, F2 still open, F1 verified fixed; nobody acts on F1.
  expect(result2?.change.host).toBe("github");
  expect(result2?.verdict.value).toBe("blocking");
  expect(result2?.loop).toEqual({ state: "open", round: 2, next_action: "fix" });
  expect(result2?.findings.map((f) => `${f.id} ${f.needs_action_by}`)).toEqual([
    "F3 agent",
    "F2 agent",
    "F1 none",
  ]);
  expect(result2?.counts).toEqual({
    open: { blocking: 1, should_fix: 1, consider: 0 },
    escalated: 0,
    verified_fixed: 1,
    withdrawn: 0,
    acknowledged: 0,
    dismissed: 0,
    obsolete: 0,
    kept_in_app: 0,
  });
  // A finding never appears twice on the change: each review's comments carry their own findings, once.
  const commented = shown.reviews.map((r) =>
    r.comments.map((c) => /lookover:finding \{[^}]*"id":"(F\d+)"/.exec(c.body)?.[1]),
  );
  expect(commented).toEqual([["F1", "F2"], ["F3"]]);
  // F3 is on line 17, the `eval` line whose text the recording quotes.
  expect(shown.reviews[1]?.comments.map((c) => [c.side, c.line, c.endLine])).toEqual([["head", 17, null]]);
  expect(round2.findings[2]?.lineText).toBe("  return invoices.filter((i) => eval(expression));");
  expect(new Set(round2.findings.map((f) => f.id)).size).toBe(3);
  const after: State = await snapshot(service, cookie);
  expect(after.reviews[PLANTED]?.rounds.map((r) => r.n)).toEqual([1, 2]);
});
