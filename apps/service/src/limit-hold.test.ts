// An engine at its limit is held until its reset (ADR 0055, I-055), on fakes and a held clock: a run that met the
// limit says when it resets, and the queue sends that engine nothing before then, its jobs starting at that time;
// with no time read, it holds 15 minutes and the log says once what the engine said of its limit, its secrets
// removed; a self-test that meets the limit holds the engine the same way.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { commitSha } from "@lookover/contracts";
import type { ScriptedRun } from "@lookover/testkit";
import { openLogSink } from "./index.ts";
import {
  api,
  fakeEngines,
  HeldSelfTests,
  home,
  messages,
  openApp,
  PLANTED,
  pr1,
  review,
  snapshot,
  start,
  stopAll,
  T0,
  TEST_LIMIT_MS,
  until,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const MIN = 60_000;
const HOUR = 60 * MIN;
/** A find pass that finds nothing. */
const NOTHING: ScriptedRun = { outcome: "ok", text: '```json\n{"findings": []}\n```' };

test("Claude at its limit until T takes no job before T; its job starts at T; the snapshot says T", async () => {
  const engines = fakeEngines();
  const reset = T0 + 3 * HOUR + 7 * MIN;
  engines.answer({ outcome: "quota_exhausted", text: "", limitUntil: reset }, NOTHING);
  const { service, time } = await start({ engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "run.started");
  expect((await until(stream, "engine.changed")).at(-1)).toMatchObject({
    id: "claude",
    patch: { state: "limit", limitUntil: reset },
  });
  await until(stream, "job.changed");
  expect((await snapshot(service, cookie)).engines.claude).toMatchObject({
    state: "limit",
    limitUntil: reset,
  });

  // Every tick before the reset leaves the job deferred: no run spent to find the limit again.
  await time.advance(reset - time.now() - 1);
  expect(engines.runs).toHaveLength(1);
  expect((await snapshot(service, cookie)).reviews[PLANTED]?.job).toMatchObject({
    state: "deferred",
    deferral: { reason: "engine-limit", engine: "claude" },
  });

  await time.advance(1);
  expect((await until(stream, "run.started")).at(-1)).toMatchObject({ at: reset });
  expect(engines.runs).toHaveLength(2);
  expect((await snapshot(service, cookie)).engines.claude).toMatchObject({
    state: "ready",
    limitUntil: null,
  });
});

test("no reset read: held 15 minutes with no end shown, and the log says once what the engine said, its secrets removed", async () => {
  const dir = home();
  const sink = await openLogSink({ home: dir, clock: { now: () => T0 }, userOnly: async () => {} });
  const token = `ghp_${"S".repeat(36)}`;
  const said = `You've hit your usage limit (${token}).`;
  const engines = fakeEngines();
  engines.answer(
    { outcome: "quota_exhausted", text: "", limitSaid: said },
    { outcome: "quota_exhausted", text: "", limitSaid: said },
    NOTHING,
  );
  const { service, time } = await start({ engines, home: dir, logSink: sink });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "run.started");
  await until(stream, "engine.changed");
  expect((await snapshot(service, cookie)).engines.claude).toMatchObject({
    state: "limit",
    limitUntil: null,
  });
  expect(sink.tail()).toContainEqual(expect.stringContaining("Claude reached its limit until it resets"));
  await time.advance(15 * MIN - 1);
  expect(engines.runs).toHaveLength(1);
  // The hold over, the job runs and meets the limit again: the same words are not written twice.
  await time.advance(1);
  await until(stream, "run.started");
  await until(stream, "engine.changed");
  expect(engines.runs).toHaveLength(2);
  const lines = sink.tail().filter((line) => line.includes("usage limit"));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("Claude gave no reset time Lookover can read: You've hit your usage limit");
  expect(lines.join("\n")).not.toContain(token);
});

test("a self-test that meets the limit holds the engine until its reset the same way", async () => {
  const engines = fakeEngines({ reviews: 1 });
  const selfTests = new HeldSelfTests();
  const { service, time, logged } = await start({ engines, selfTests });
  const cookie = await openApp(service);
  const reset = T0 + 26 * HOUR;
  selfTests.end("claude", { limitUntil: reset });
  await time.advance(0);
  expect((await snapshot(service, cookie)).engines.claude).toMatchObject({
    state: "limit",
    limitUntil: reset,
  });
  // The log says why the self-test couldn't say, and until when the engine is held.
  expect(logged.filter((line) => line.includes("limit"))).toEqual([
    "self-test of claude 2.4.1: inconclusive (at its limit), 0 ms",
    "Claude reached its limit until 2026-10-07 10:52",
  ]);

  expect((await review(service, cookie)).status).toBe(200);
  await time.advance(reset - time.now() - 1);
  expect(engines.runs).toHaveLength(0);
  expect(selfTests.ran).toHaveLength(1);
  // At the reset the version is tested again: once it passes, the job starts.
  await time.advance(1);
  expect(selfTests.ran).toHaveLength(2);
  selfTests.end("claude", "passed");
  await time.advance(0);
  expect(engines.runs).toHaveLength(1);
});

test("a hold that ends before the armed tick wakes the take at its end: the job starts at T, not at the tick", async () => {
  const engines = fakeEngines();
  const { service, host, time } = await start({ engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  // Claude wrote pull request #3, so Codex finds; Codex is missing: the job waits on it and the tick is armed.
  host.open({
    ...pr1,
    number: 3,
    title: "Pull request 3",
    url: pr1.url.replace(/\/1$/, "/3"),
    head: { ref: "branch-3", sha: commitSha("3".repeat(40)) },
    messages: ["Fix the total\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"],
  });
  await time.advance(MIN);
  await until(stream, "job.changed");
  expect((await until(stream, "job.changed")).at(-1)).toMatchObject({
    job: { state: "deferred", deferral: { reason: "engine-missing", engine: "codex" } },
  });
  // Claude meets its limit on the planted one, resetting in 20 seconds: sooner than the armed tick.
  const reset = time.now() + 20_000;
  engines.answer({ outcome: "quota_exhausted", text: "", limitUntil: reset }, NOTHING);
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "run.started");
  await until(stream, "engine.changed");
  await time.advance(reset - time.now() - 1);
  expect(engines.runs).toHaveLength(1);
  await time.advance(1);
  expect(engines.runs).toHaveLength(2);
  expect((await until(stream, "run.started")).at(-1)).toMatchObject({ at: reset });
});
