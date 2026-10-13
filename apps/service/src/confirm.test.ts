// The confirm pass in the run (ADR 0044), on fakes alone: a Standard round goes find → confirm → reconcile →
// publish, each engine session in its own sub-folder of the run's; the other engine confirms when it is ready, else
// the finder in a new session, the round saying why; a confirm that fails, the other engine signed out mid-run
// included, still posts, marked not double-checked; a round with nothing new to confirm has no confirm step. Depth:
// a Quick round finds once and confirms nothing; a Deep round finds twice, on both engines, merges, then confirms.
// No git, no `claude`, no `codex`.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { basename, dirname } from "node:path";
import { type Depth, type Event, readResult, SUMMARY_MARKER } from "@lookover/contracts";
import type { FakeEngines, ScriptedRun } from "@lookover/testkit";
import {
  api,
  fakeEngines,
  messages,
  openApp,
  post,
  review,
  SANDBOX,
  start,
  stopAll,
  TEST_LIMIT_MS,
  until,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const PR = { repo: SANDBOX, number: 1 };

const finding = (line: number, severity: string, title: string, key: string) => ({
  path: "src/total.ts",
  line,
  severity,
  category: "correctness",
  title,
  body: `When it runs, ${key} breaks.`,
  defect_key: key,
});

/** A block as the engine writes it, after a line of notes. */
const answered = (block: unknown): ScriptedRun => ({
  outcome: "ok",
  text: ["Notes.", "```json", JSON.stringify(block), "```"].join("\n"),
});

/** The find pass: one finding per severity. */
const FOUND = answered({
  findings: [
    finding(12, "blocking", "The total skips the last invoice", "skips_last"),
    finding(20, "blocking", "The rounding drops a cent", "drops_cent"),
    finding(30, "consider", "The loop could be a reduce", "loop_style"),
  ],
});

/** The confirm pass: the first confirmed, the second unsure, the third refuted. */
const CONFIRMED = answered({
  verdicts: [
    {
      id: "C1",
      verdict: "confirmed",
      reason: "The loop stops at length - 1.",
      evidence: ["src/total.ts:12"],
      severity: "blocking",
    },
    {
      id: "C2",
      verdict: "unsure",
      reason: "The cents may be rounded upstream.",
      evidence: [],
      severity: "blocking",
    },
    {
      id: "C3",
      verdict: "refuted",
      reason: "The loop is clearer here.",
      evidence: ["src/total.ts:30"],
      severity: "consider",
    },
  ],
});

/** Codex installed and signed in, or signed out. */
const codex = (signedIn: boolean) => ({ installed: true, version: "0.162.1", signedIn });

/**
 * "Review now" on pull request #1, and the events of its run up to its round, at `depth` (Standard by default).
 * Codex isn't installed unless `setup` says otherwise: Claude finds and confirms.
 */
async function reviewed(
  answers: ScriptedRun[],
  setup: (engines: FakeEngines) => void = () => {},
  depth: Depth = "standard",
) {
  const engines = fakeEngines();
  engines.answer(...answers);
  setup(engines);
  const started = await start({ engines, repositorySettings: { depth } });
  const cookie = await openApp(started.service);
  const stream = messages(await fetch(api(started.service, "/events"), { headers: { cookie } }));
  expect((await review(started.service, cookie)).status).toBe(200);
  const events = await until(stream, "round.finished");
  await started.time.advance(0);
  const finished = events.at(-1);
  if (finished?.type !== "round.finished") throw new Error("no round");
  const steps = events.flatMap((e: Event) => (e.type === "run.step" ? [e.step] : []));
  const view = started.host.view(PR);
  const summary = view.comments.find((c) => c.body.startsWith(SUMMARY_MARKER))?.body ?? "";
  const result = readResult(view.checks[0]?.output.text ?? "");
  return { engines, finished, steps, summary, result, events };
}

test("Codex not installed, a Standard round confirms on the finder in a new session, then posts what the policy kept", async () => {
  const { engines, finished, steps, summary, result } = await reviewed([FOUND, CONFIRMED]);
  expect(steps).toEqual(["finding", "confirming", "publishing"]);
  // Two sessions, each in its own sub-folder of the run's folder.
  expect(engines.runs.map((r) => [r.engine, basename(r.artefactsDir)])).toEqual([
    ["claude", "find"],
    ["claude", "confirm"],
  ]);
  expect(dirname(engines.runs[0]?.artefactsDir ?? "")).toBe(dirname(engines.runs[1]?.artefactsDir ?? ""));
  expect(finished.round).toMatchObject({
    reviewer: "claude",
    confirmer: "claude",
    confirmFailure: null,
    raised: 2,
  });
  expect(finished.round.ruledOut).toMatchObject([
    { by: "claude", reason: "The loop is clearer here.", candidate: { title: "The loop could be a reduce" } },
  ]);
  expect(finished.findings.map((f) => [`${f.id}`, f.severity, f.confirmation])).toEqual([
    [
      "F1",
      "blocking",
      {
        verdict: "confirmed",
        by: "claude",
        reason: "The loop stops at length - 1.",
        evidence: ["src/total.ts:12"],
      },
    ],
    [
      "F2",
      "should_fix",
      {
        verdict: "unsure",
        by: "claude",
        reason: "The cents may be rounded upstream.",
        evidence: [],
        demoted: true,
      },
    ],
  ]);
  // The result names the confirmer, how many it ruled out and each finding's confirmation; the summary says which
  // one is unconfirmed.
  expect(result?.run.engine).toEqual({ finder: "claude", confirmer: "claude" });
  expect(result?.run.ruled_out).toBe(1);
  expect(result?.findings.map((f) => [f.id, f.confirmation.verdict])).toEqual([
    ["F1", "confirmed"],
    ["F2", "unsure"],
  ]);
  expect(summary).toContain("Should fix, unconfirmed");
  expect(summary).not.toContain("Not double-checked");
});

test("a confirm that fails still posts the round, its findings as found, marked not double-checked", async () => {
  // Nothing scripted for the confirm session: the fake engine's run crashes.
  const { engines, finished, steps, summary, result } = await reviewed([FOUND]);
  expect(steps).toEqual(["finding", "confirming", "publishing"]);
  expect(engines.runs).toHaveLength(2);
  expect(finished.job.state).toBe("done");
  expect(finished.round).toMatchObject({
    confirmer: "claude",
    confirmFailure: "crashed",
    ruledOut: [],
    raised: 3,
  });
  expect(finished.findings.map((f) => [`${f.id}`, f.severity, f.confirmation])).toEqual([
    ["F1", "should_fix", { verdict: "not_checked", demoted: true }],
    ["F2", "should_fix", { verdict: "not_checked", demoted: true }],
    ["F3", "consider", { verdict: "not_checked", demoted: false }],
  ]);
  expect(result?.run.engine).toEqual({ finder: "claude", confirmer: "claude" });
  expect(summary).toContain("Not double-checked");
});

test("a round with no new candidate has no confirm step and no confirmer", async () => {
  const { engines, finished, steps, result } = await reviewed([answered({ findings: [] })]);
  expect(steps).toEqual(["finding", "publishing"]);
  expect(engines.runs).toHaveLength(1);
  expect(finished.round).toMatchObject({ confirmer: null, confirmFailure: null, ruledOut: [] });
  expect(result?.run.engine).toEqual({ finder: "claude", confirmer: null });
});

/** The run the take started, as `run.started` sent it. */
const startedRun = (events: Event[]) => events.find((e) => e.type === "run.started");

test("both engines ready: Claude finds the owner's change and Codex confirms it, the run holding both", async () => {
  const { engines, finished, steps, summary, result, events } = await reviewed([FOUND], (e) => {
    e.setHealth("codex", codex(true));
    e.answerFor("codex", CONFIRMED);
  });
  expect(startedRun(events)).toMatchObject({
    run: { reviewer: "claude", confirmer: "codex", confirmFallback: null },
  });
  expect(steps).toEqual(["finding", "confirming", "publishing"]);
  expect(engines.runs.map((r) => [r.engine, basename(r.artefactsDir)])).toEqual([
    ["claude", "find"],
    ["codex", "confirm"],
  ]);
  expect(finished.round).toMatchObject({
    reviewer: "claude",
    confirmer: "codex",
    confirmFallback: null,
    confirmFailure: null,
    raised: 2,
  });
  expect(finished.round.ruledOut).toMatchObject([{ by: "codex", reason: "The loop is clearer here." }]);
  expect(finished.findings.map((f) => [`${f.id}`, f.severity, f.confirmation.verdict])).toEqual([
    ["F1", "blocking", "confirmed"],
    ["F2", "should_fix", "unsure"],
  ]);
  expect(
    finished.findings.map((f) => (f.confirmation.verdict === "not_checked" ? null : f.confirmation.by)),
  ).toEqual(["codex", "codex"]);
  expect(result?.run.engine).toEqual({ finder: "claude", confirmer: "codex" });
  expect(summary).not.toContain("Not double-checked");
});

test("Codex signed out when the job is taken: Claude confirms in a new session, and the round says why", async () => {
  const { engines, finished, events } = await reviewed([FOUND, CONFIRMED], (e) =>
    e.setHealth("codex", codex(false)),
  );
  const fallback = { reason: "not-ready", engine: "codex", state: "signed-out" };
  expect(startedRun(events)).toMatchObject({
    run: { reviewer: "claude", confirmer: "claude", confirmFallback: fallback },
  });
  expect(engines.runs.map((r) => r.engine)).toEqual(["claude", "claude"]);
  expect(finished.job.state).toBe("done");
  expect(finished.round).toMatchObject({
    confirmer: "claude",
    confirmFallback: fallback,
    confirmFailure: null,
  });
});

test("Codex signed out mid-run: the confirm gives no answer, and the round posts as found, not double-checked", async () => {
  const { engines, finished, summary, result } = await reviewed([FOUND], (e) => {
    e.setHealth("codex", codex(true));
    e.answerFor("codex", { outcome: "auth_required", text: "" });
  });
  expect(engines.runs.map((r) => r.engine)).toEqual(["claude", "codex"]);
  // Never deferred nor failed (ADR 0044): the find pass is spent, the round goes on.
  expect(finished.job.state).toBe("done");
  expect(finished.round).toMatchObject({
    reviewer: "claude",
    confirmer: "codex",
    confirmFallback: null,
    confirmFailure: "auth_required",
    raised: 3,
  });
  expect(finished.findings.map((f) => [`${f.id}`, f.severity, f.confirmation])).toEqual([
    ["F1", "should_fix", { verdict: "not_checked", demoted: true }],
    ["F2", "should_fix", { verdict: "not_checked", demoted: true }],
    ["F3", "consider", { verdict: "not_checked", demoted: false }],
  ]);
  expect(result?.run.engine).toEqual({ finder: "claude", confirmer: "codex" });
  expect(summary).toContain("Not double-checked: Codex is signed out");
});

test("Codex at its limit while confirming shows at its limit, and the next round Claude confirms, saying why", async () => {
  const engines = fakeEngines();
  engines.setHealth("codex", codex(true));
  // Round 2 finds one more: new, it is confirmed.
  const more = answered({ findings: [finding(40, "blocking", "The tax is added twice", "tax_twice")] });
  const confirmed = answered({
    verdicts: [
      { id: "C1", verdict: "confirmed", reason: "Both lines add it.", evidence: [], severity: "blocking" },
    ],
  });
  engines.answerFor("claude", FOUND, more, confirmed);
  engines.answerFor("codex", { outcome: "quota_exhausted", text: "" });
  const { service, time } = await start({ engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  const first = await until(stream, "round.finished");
  expect(first.at(-1)).toMatchObject({ round: { confirmer: "codex", confirmFailure: "quota_exhausted" } });
  expect(first.filter((e) => e.type === "engine.changed")).toMatchObject([
    { id: "codex", patch: { state: "limit" } },
  ]);
  await time.advance(0);

  // Codex's health still says signed in: the limit holds all the same, so no session is spent on it.
  expect((await review(service, cookie)).status).toBe(200);
  const second = await until(stream, "round.finished");
  const fallback = { reason: "not-ready", engine: "codex", state: "limit" };
  expect(second.find((e) => e.type === "run.started")).toMatchObject({
    run: { reviewer: "claude", confirmer: "claude", confirmFallback: fallback },
  });
  expect(engines.runs.map((r) => r.engine)).toEqual(["claude", "codex", "claude", "claude"]);
});

test("Claude at its limit while finding shows at its limit, and its deferred job isn't started again at once", async () => {
  const engines = fakeEngines();
  engines.answer({ outcome: "quota_exhausted", text: "" });
  const { service, time } = await start({ engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "run.started");
  const ended = await until(stream, "engine.changed");
  expect(ended.at(-1)).toMatchObject({ id: "claude", patch: { state: "limit" } });
  expect((await until(stream, "job.changed")).at(-1)).toMatchObject({
    job: { state: "deferred", deferral: { reason: "engine-limit", engine: "claude" } },
  });
  await time.advance(0);
  await time.advance(60_000);
  expect(engines.runs).toHaveLength(1);
});

/** Both engines installed and signed in, each answering its own runs. */
const both =
  (claude: ScriptedRun[], codexRuns: ScriptedRun[]) =>
  (e: FakeEngines): void => {
    e.setHealth("codex", codex(true));
    e.answerFor("claude", ...claude);
    e.answerFor("codex", ...codexRuns);
  };

test("a Quick round finds once and has no confirm step: a blocking finding, not confirmed, is posted unconfirmed", async () => {
  const { engines, finished, steps, summary, result, events } = await reviewed(
    [],
    both([FOUND], []),
    "quick",
  );
  expect(startedRun(events)).toMatchObject({
    run: { reviewer: "claude", secondFinder: null, confirmer: null, confirmFallback: null },
  });
  expect(steps).toEqual(["finding", "publishing"]);
  expect(engines.runs.map((r) => [r.engine, basename(r.artefactsDir)])).toEqual([["claude", "find"]]);
  expect(finished.round).toMatchObject({ confirmer: null, confirmFallback: null, ruledOut: [], raised: 3 });
  // A blocking finding stays blocking only when confirmed (ADR 0044), at Quick too.
  expect(finished.findings.map((f) => [`${f.id}`, f.severity, f.confirmation])).toEqual([
    ["F1", "should_fix", { verdict: "not_checked", demoted: true }],
    ["F2", "should_fix", { verdict: "not_checked", demoted: true }],
    ["F3", "consider", { verdict: "not_checked", demoted: false }],
  ]);
  expect(result?.run.engine).toEqual({ finder: "claude", confirmer: null });
  expect(summary).toContain("Should fix, unconfirmed");
});

test("the repository's own depth and strictness, set from the app, reach its next round: Quick finds once, and only blocking findings are posted (ADR 0049)", async () => {
  const engines = fakeEngines();
  engines.answer(FOUND);
  const started = await start({ engines });
  const cookie = await openApp(started.service);
  const own = (key: string, value: string) =>
    post(started.service, cookie, {
      type: "repo.setSetting",
      repoId: "sasensi/lookover-sandbox",
      key,
      value,
    });
  expect((await own("depth", "quick")).status).toBe(200);
  expect((await own("strictness", "blocking")).status).toBe(200);
  const stream = messages(await fetch(api(started.service, "/events"), { headers: { cookie } }));
  expect((await review(started.service, cookie)).status).toBe(200);
  const events = await until(stream, "round.finished");
  const finished = events.at(-1);
  if (finished?.type !== "round.finished") throw new Error("no round");
  expect(events.flatMap((e: Event) => (e.type === "run.step" ? [e.step] : []))).toEqual([
    "finding",
    "publishing",
  ]);
  // Unconfirmed at Quick, the blocking ones are only should fix: at Only blocking, nothing is posted.
  expect(finished.findings.map((f) => [`${f.id}`, f.severity, f.posted])).toEqual([
    ["F1", "should_fix", false],
    ["F2", "should_fix", false],
    ["F3", "consider", false],
  ]);
});

/** Codex's find pass: the bug on line 12 under another name, and one Claude missed. */
const FOUND_BY_CODEX = answered({
  findings: [
    finding(12, "blocking", "The last invoice is never added", "off_by_one"),
    finding(40, "should_fix", "The currency is ignored", "currency_ignored"),
  ],
});

/** The confirm pass on the merged candidates: every one confirmed. */
const ALL_CONFIRMED = answered({
  verdicts: ["C1", "C2", "C3", "C4"].map((id) => ({
    id,
    verdict: "confirmed",
    reason: "It is so.",
    evidence: [],
    severity: "should_fix",
  })),
});

test("a Deep round finds twice, Claude then Codex, merges the passes and confirms once, on Codex", async () => {
  const { engines, finished, steps, events } = await reviewed(
    [],
    both([FOUND], [FOUND_BY_CODEX, ALL_CONFIRMED]),
    "deep",
  );
  expect(startedRun(events)).toMatchObject({
    run: { reviewer: "claude", secondFinder: "codex", confirmer: "codex", confirmFallback: null },
  });
  expect(steps).toEqual(["finding", "confirming", "publishing"]);
  expect(engines.runs.map((r) => [r.engine, basename(r.artefactsDir)])).toEqual([
    ["claude", "find"],
    ["codex", "find-2"],
    ["codex", "confirm"],
  ]);
  // The bug both passes found is one finding, Claude's; the one only Codex found is kept.
  expect(finished.findings.map((f) => [`${f.id}`, f.title, f.foundBy])).toEqual([
    ["F1", "The total skips the last invoice", "claude"],
    ["F2", "The rounding drops a cent", "claude"],
    ["F3", "The loop could be a reduce", "claude"],
    ["F4", "The currency is ignored", "codex"],
  ]);
  expect(finished.round).toMatchObject({
    reviewer: "claude",
    secondFind: { engine: "codex", failure: null },
    confirmer: "codex",
    raised: 4,
  });
});

test("a Deep round keeps what each of its sessions used, apart: find, second find, confirm (ADR 0055)", async () => {
  const used = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens });
  const { finished } = await reviewed(
    [],
    both(
      [{ ...FOUND, usage: used(21_000, 1_600), tookMs: 3 }],
      [
        { ...FOUND_BY_CODEX, usage: used(32_800, 500), tookMs: 4 },
        { ...ALL_CONFIRMED, usage: null, tookMs: 5 },
      ],
    ),
    "deep",
  );
  expect(finished.round.sessions).toEqual([
    { pass: "find", engine: "claude", ms: 3, usage: used(21_000, 1_600) },
    { pass: "find-2", engine: "codex", ms: 4, usage: used(32_800, 500) },
    { pass: "confirm", engine: "codex", ms: 5, usage: null },
  ]);
});

test("a second find pass that failed after answering still counts what its session used (ADR 0055)", async () => {
  const usage = { inputTokens: 9_800, outputTokens: 210 };
  const { finished } = await reviewed(
    [],
    both([FOUND], [{ outcome: "ok", text: "No block here.", usage }, CONFIRMED]),
    "deep",
  );
  expect(finished.round.secondFind).toEqual({ engine: "codex", failure: "unreadable" });
  expect(finished.round.sessions).toEqual([
    { pass: "find", engine: "claude", ms: 0, usage: null },
    { pass: "find-2", engine: "codex", ms: 0, usage },
    { pass: "confirm", engine: "codex", ms: 0, usage: null },
  ]);
});

test("a round with nothing new to confirm has its find session alone", async () => {
  const { finished } = await reviewed([answered({ findings: [] })]);
  expect(finished.round.sessions).toEqual([{ pass: "find", engine: "claude", ms: 0, usage: null }]);
});

test("a Deep round whose second find pass fails goes on with the first pass's findings, and says why", async () => {
  const { engines, finished, summary } = await reviewed(
    [],
    both([FOUND], [{ outcome: "auth_required", text: "" }, CONFIRMED]),
    "deep",
  );
  expect(engines.runs.map((r) => [r.engine, basename(r.artefactsDir)])).toEqual([
    ["claude", "find"],
    ["codex", "find-2"],
    ["codex", "confirm"],
  ]);
  expect(finished.job.state).toBe("done");
  expect(finished.findings.map((f) => `${f.id} ${f.confirmation.verdict}`)).toEqual([
    "F1 confirmed",
    "F2 unsure",
  ]);
  expect(finished.round.secondFind).toEqual({ engine: "codex", failure: "auth_required" });
  expect(summary).toContain("One find pass, not two: Codex is signed out.");
});
