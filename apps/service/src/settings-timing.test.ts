// A settings change lands at the right moment (ADR 0049): a `reviewers` change re-plans what waits (each job deferred
// on an engine is sent again with who may step in for it now, then the queue takes), and a round already running
// keeps the settings and the rule switches it started with, the next round taking the new ones. On fakes alone: no
// git, no engine.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { changeId, type Event, type Rule } from "@lookover/contracts";
import type { Retrieval } from "@lookover/retrieval";
import { ScriptedRetrieval, type ScriptedRun } from "@lookover/testkit";
import {
  api,
  fakeEngines,
  heldRuns,
  messages,
  openApp,
  post,
  review,
  SANDBOX,
  SHA1,
  snapshot,
  start,
  stopAll,
  TEST_LIMIT_MS,
  until,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const SANDBOX_ID = "sasensi/lookover-sandbox";
const PR1 = changeId("sasensi/lookover-sandbox#1");
const own = (key: string, value: unknown) => ({ type: "repo.setSetting", repoId: SANDBOX_ID, key, value });

test("a job deferred on Codex, reviewers set to Claude only: its step-in is sent again and it runs on Claude", async () => {
  // Codex isn't installed: with Codex alone reviewing, the review waits on it and nobody may step in.
  const { service } = await start({
    engines: fakeEngines({ reviews: 1 }),
    repositorySettings: { reviewers: "codex" },
  });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "job.changed");
  const deferred = (await until(stream, "job.changed")).at(-1);
  expect(deferred).toMatchObject({
    changeId: PR1,
    job: { state: "deferred", deferral: { engine: "codex" }, stepIn: null },
  });

  // Strictness moves no step-in: the job isn't sent again.
  expect((await post(service, cookie, own("strictness", "blocking"))).status).toBe(200);
  expect((await post(service, cookie, own("reviewers", "claude"))).status).toBe(200);
  const after = await until(stream, "run.started");
  expect(after.map((e) => e.type)).toEqual([
    "settings.changed",
    "settings.changed",
    "job.changed",
    "run.started",
  ]);
  expect(after[2]).toMatchObject({ changeId: PR1, job: { state: "deferred", stepIn: "claude" } });
  expect(after[3]).toMatchObject({ changeId: PR1, run: { reviewer: "claude" } });
});

test("a job deferred on Claude: reviewers set to Claude only takes Codex's offer away, set back to both gives it again", async () => {
  // Claude signed out, both reviewing: the owner's review waits on Claude, and Codex may step in.
  const { service } = await start({ engines: fakeEngines({ signedIn: false }) });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "job.changed");
  expect((await until(stream, "job.changed")).at(-1)).toMatchObject({
    job: { state: "deferred", deferral: { engine: "claude" }, stepIn: "codex" },
  });

  expect((await post(service, cookie, own("reviewers", "claude"))).status).toBe(200);
  const alone = await until(stream, "job.changed");
  expect(alone.map((e) => e.type)).toEqual(["settings.changed", "job.changed"]);
  expect(alone[1]).toMatchObject({ changeId: PR1, job: { state: "deferred", stepIn: null } });

  expect((await post(service, cookie, own("reviewers", "both"))).status).toBe(200);
  const both = await until(stream, "job.changed");
  expect(both.map((e) => e.type)).toEqual(["settings.changed", "job.changed"]);
  expect(both[1]).toMatchObject({ changeId: PR1, job: { state: "deferred", stepIn: "codex" } });
});

/** A block as the engine writes it. */
const answered = (block: unknown): ScriptedRun => ({
  outcome: "ok",
  text: ["```json", JSON.stringify(block), "```"].join("\n"),
});

/** One finding that should be fixed, not blocking: posted at Recommended, not at Only blocking. */
const shouldFix = (line: number, key: string) =>
  answered({
    findings: [
      {
        path: "src/total.ts",
        line,
        severity: "should_fix",
        category: "correctness",
        title: `The total breaks at line ${line}`,
        body: `When it runs, ${key} breaks.`,
        defect_key: key,
      },
    ],
  });

const CONFIRMED = answered({
  verdicts: [{ id: "C1", verdict: "confirmed", reason: "It does.", evidence: [], severity: "should_fix" }],
});

/** The steps of the run whose events these are. */
const stepsOf = (events: Event[]) => events.flatMap((e) => (e.type === "run.step" ? [e.step] : []));

test("strictness and depth changed during a round leave its plan and its posting as started; the next round takes them", async () => {
  const engines = fakeEngines();
  engines.answer(shouldFix(12, "first"), CONFIRMED, shouldFix(30, "second"));
  const held = heldRuns(engines);
  const { service, time } = await start({ engines: held.engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "run.started");

  // The round is finding, at Standard and Recommended: Only blocking and Quick from now on.
  expect((await post(service, cookie, own("strictness", "blocking"))).status).toBe(200);
  expect((await post(service, cookie, own("depth", "quick"))).status).toBe(200);
  held.release();
  const first = await until(stream, "round.finished");
  expect(stepsOf(first)).toEqual(["finding", "confirming", "publishing"]);
  const round1 = first.at(-1);
  if (round1?.type !== "round.finished") throw new Error("no round");
  expect(round1.findings.map((f) => [f.severity, f.posted])).toEqual([["should_fix", true]]);

  await time.advance(0);
  expect((await review(service, cookie)).status).toBe(200);
  const second = await until(stream, "round.finished");
  expect(stepsOf(second)).toEqual(["finding", "publishing"]);
  const round2 = second.at(-1);
  if (round2?.type !== "round.finished") throw new Error("no round");
  expect(round2.round.confirmer).toBeNull();
  expect(round2.findings.map((f) => [f.raisedIn, f.posted])).toEqual([
    [1, true],
    [2, false],
  ]);
});

const RULE = "Never log a secret: an API key, a token or a password.";
const CENTS = "Every amount is in integer cents.";
const NOTHING = answered({ findings: [] });

test("a rule switched off while a round prepares leaves that round's prompt as started; the next round's goes without it", async () => {
  const scripted = new ScriptedRetrieval();
  scripted.scriptRules(SANDBOX, [{ path: "REVIEW.md", text: `- ${RULE}\n- ${CENTS}\n`, commit: SHA1 }]);
  // The prepare waits while `hold` is set: the round has started, its prompt not yet built.
  let hold: Promise<void> | null = null;
  const retrieval: Retrieval = {
    prepare: async (request) => {
      await hold;
      return scripted.prepare(request);
    },
  };
  const engines = fakeEngines();
  engines.answer(NOTHING, NOTHING, NOTHING);
  const { service } = await start({ engines, retrieval, repositorySettings: { depth: "quick" } });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  /** The prompt of the round "Review now" runs, `during` done once its run has started. */
  const round = async (during: () => Promise<void> = async () => {}) => {
    const before = engines.runs.length;
    expect((await review(service, cookie)).status).toBe(200);
    await until(stream, "run.started");
    await during();
    await until(stream, "round.finished");
    expect(engines.runs.length).toBe(before + 1);
    return engines.runs.at(-1)?.prompt ?? "";
  };
  expect(await round()).toContain(CENTS);
  const cents = (await snapshot(service, cookie)).rules.find((r: Rule) => r.text === CENTS);
  if (cents === undefined) throw new Error("no such rule");

  let release = () => {};
  hold = new Promise((resolve) => {
    release = resolve;
  });
  const during = await round(async () => {
    const off = { type: "rule.setEnabled", ruleId: cents.id, enabled: false };
    expect((await post(service, cookie, off)).status).toBe(200);
    hold = null;
    release();
  });
  expect(during).toContain(CENTS);
  const next = await round();
  expect(next).toContain(RULE);
  expect(next).not.toContain(CENTS);
});
