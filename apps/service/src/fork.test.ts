// The fork rule (ADR 0048), through the service's entry, on fakes only: a pull request whose head is in another
// repository than its base is never reviewed by itself, whoever wrote it; its check says why. Asked by hand, Claude
// alone reviews it: Codex never finds it, confirms it or steps in on it.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { changeId, commitSha, type Event } from "@lookover/contracts";
import type { FakeChange, ScriptedRun } from "@lookover/testkit";
import {
  api,
  fakeEngines,
  messages,
  OWNER,
  openApp,
  post,
  pr1,
  SANDBOX,
  snapshot,
  start,
  stopAll,
  TEST_LIMIT_MS,
  until,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const MIN = 60_000;
const NO_FINDINGS: ScriptedRun = { outcome: "ok", text: '```json\n{"findings": []}\n```' };
/** A block as the engine writes it. */
const answered = (block: unknown): ScriptedRun => ({
  outcome: "ok",
  text: ["```json", JSON.stringify(block), "```"].join("\n"),
});
const FOUND = answered({
  findings: [
    {
      path: "src/total.ts",
      line: 12,
      severity: "blocking",
      category: "correctness",
      title: "The total skips the last invoice",
      body: "When it runs, skips_last breaks.",
      defect_key: "skips_last",
    },
  ],
});
const CONFIRMED = answered({
  verdicts: [
    {
      id: "C1",
      verdict: "confirmed",
      reason: "The loop stops at length - 1.",
      evidence: ["src/total.ts:12"],
      severity: "blocking",
    },
  ],
});
/** Codex wrote it: on the owner's own change from the repository itself, Claude would find and Codex confirm. */
const CODEX_CODE = "Fix the total\n\nCo-Authored-By: Codex <noreply@openai.com>";

/** The owner's own pull request, from a fork, written by Codex. */
const fork: FakeChange = {
  ...pr1,
  number: 7,
  title: "Fix the total, from my fork",
  url: pr1.url.replace(/\/1$/, "/7"),
  head: { ref: "fork-7", sha: commitSha("7".repeat(40)) },
  messages: ["Start the filter", CODEX_CODE],
  fork: true,
};
const FORK = { repo: SANDBOX, number: 7 };
const id = changeId("sasensi/lookover-sandbox#7");

/** Claude and Codex both signed in and ready. */
function bothEngines(...claude: ScriptedRun[]) {
  const engines = fakeEngines();
  engines.setHealth("codex", { installed: true, version: "0.162.1", signedIn: true });
  engines.answerFor("claude", ...(claude.length > 0 ? claude : [NO_FINDINGS]));
  engines.answerFor("codex", NO_FINDINGS);
  return engines;
}

const startedBy = (events: Event[]) =>
  events.flatMap((e) => (e.type === "run.started" ? [e.run.reviewer] : []));

test("a fork opened, even the owner's, is skipped with its reason on the check; nothing runs", async () => {
  const engines = bothEngines();
  const { service, host, time } = await start({ changes: [pr1], engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

  host.open(fork);
  await time.advance(MIN);
  expect((await until(stream, "job.changed")).at(-1)).toMatchObject({ job: { skip: "fork" } });
  await time.advance(0);
  expect(host.view(FORK).checks.map((c) => `${c.status} ${c.conclusion}: ${c.output.title}`)).toEqual([
    "completed skipped: Not reviewed: it comes from a fork",
  ]);
  expect(host.view(FORK).checks[0]?.output.summary).toContain("To ask, comment `/lookover review` on it");
  expect((await snapshot(service, cookie)).changes[id]).toMatchObject({ fork: true, author: "you" });
  expect(engines.runs).toEqual([]);
});

test("a fork opened where only Codex may review says to let Claude review, in Settings: a request would be skipped too", async () => {
  const engines = bothEngines();
  const { host, time } = await start({ changes: [pr1], engines, repositorySettings: { reviewers: "codex" } });

  host.open(fork);
  await time.advance(MIN);
  await time.advance(0);
  expect(host.view(FORK).checks.map((c) => c.output.summary)).toEqual([
    "Lookover did not look over 7777777: it reviews a pull request from a fork only when the owner asks, and with Claude only, and only Codex may review here. To have it reviewed, the owner lets Claude review too, in Lookover's Settings.",
  ]);
  expect(engines.runs).toEqual([]);
});

test("a fork asked for by hand is found and confirmed by Claude alone, though Codex would find the owner's change", async () => {
  const engines = bothEngines(FOUND, CONFIRMED);
  const { service, host, time } = await start({ changes: [pr1], engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

  host.open(fork);
  await time.advance(MIN);
  await until(stream, "job.changed");
  host.seedComment(FORK, { author: OWNER, body: "/lookover review" });
  await time.advance(MIN);
  const events = await until(stream, "round.finished");
  expect(startedBy(events)).toEqual(["claude"]);
  expect(engines.runs.map((r) => r.engine)).toEqual(["claude", "claude"]);
  expect(events.at(-1)).toMatchObject({
    round: { confirmer: "claude", confirmFallback: { reason: "not-own", engine: "codex" } },
  });
});

test("a fork's request waiting when the fork is pushed ends cancelled on its commit: the new head was asked by nobody", async () => {
  const engines = fakeEngines({ signedIn: false });
  const { service, host, time } = await start({ changes: [pr1], engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  const checks = (on: typeof fork.head.sha) =>
    host.view(FORK, on).checks.map((c) => `${c.status} ${c.conclusion}: ${c.output.title}`);

  host.open(fork);
  await time.advance(MIN);
  await until(stream, "job.changed");
  // Claude is signed out: the owner's request waits on the fork's head.
  host.seedComment(FORK, { author: OWNER, body: "/lookover review" });
  await time.advance(MIN);
  expect((await until(stream, "job.changed")).at(-1)).toMatchObject({
    job: { trigger: "comment", skip: null, sha: fork.head.sha },
  });

  const pushed = commitSha("8".repeat(40));
  host.push(FORK, pushed, []);
  engines.setHealth("claude", { installed: true, version: "2.4.1", signedIn: true });
  await time.advance(MIN);
  await time.advance(MIN);
  await time.advance(0);
  const jobs = (await snapshot(service, cookie)).reviews[id]?.job;
  expect(jobs).toMatchObject({ state: "cancelled", cancel: "pushed", id: "id-2", sha: fork.head.sha });
  // Its check ends on the commit it was asked for, saying to ask again; the new head has none: nothing asked for it.
  expect(checks(fork.head.sha)).toEqual([
    "completed skipped: Not reviewed: it comes from a fork",
    "completed skipped: A newer commit was pushed after the request",
  ]);
  expect(checks(pushed)).toEqual([]);
  expect(engines.runs).toEqual([]);
});

test('"Review now" on a fork reviews it with Claude alone, as a comment does', async () => {
  const engines = bothEngines();
  const { service, host, time } = await start({ changes: [pr1], engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

  host.open(fork);
  await time.advance(MIN);
  await until(stream, "job.changed");
  expect((await post(service, cookie, { type: "review.request", changeId: id })).status).toBe(200);
  const events = await until(stream, "round.finished");
  expect(startedBy(events)).toEqual(["claude"]);
  expect(engines.runs.map((r) => r.engine)).toEqual(["claude"]);
});
