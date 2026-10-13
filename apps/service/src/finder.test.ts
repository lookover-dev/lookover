// Who finds (ADR 0044), through the service's entry, on fakes only: the service reads who wrote a pull request from
// what GitHub shows (its commits' `Co-authored-by` trailers, from the compare the poll asks for, and its branch), keeps
// it on the change, shows it in the app, and the engine that didn't write it finds. Codex never finds another
// author's change: Claude does, even on Claude's own code.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  type CommitCount,
  type CommitSha,
  changeId,
  commitSha,
  type Event,
  type RepositoryRef,
  type State,
} from "@lookover/contracts";
import { DemoClock, type FakeChange, FakeGitHost, type ScriptedRun } from "@lookover/testkit";
import {
  ACME_WEB,
  api,
  BOT,
  fakeEngines,
  home,
  messages,
  OWNER,
  onAcmeWeb,
  onOrganisationApp,
  openApp,
  organisationHost,
  post,
  pr1,
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

const MIN = 60_000;
const NO_FINDINGS: ScriptedRun = { outcome: "ok", text: '```json\n{"findings": []}\n```' };
const CLAUDE_CODE = "Fix the total\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>";

/** Another pull request on the sandbox, the owner's unless said, on commits of its own. */
const opened = (number: number, more: Partial<FakeChange> = {}): FakeChange => ({
  ...pr1,
  number,
  title: `Pull request ${number}`,
  url: pr1.url.replace(/\/1$/, `/${number}`),
  head: { ref: `branch-${number}`, sha: commitSha(`${number}`.padStart(7, "e").padEnd(40, "0")) },
  ...more,
});
const idOf = (number: number) => changeId(`lookover-sandbox#${number}`);

/** Claude and Codex both signed in, each with one find pass scripted for its own runs. */
function bothEngines() {
  const engines = fakeEngines();
  engines.setHealth("codex", { installed: true, version: "0.162.1", signedIn: true });
  engines.answerFor("claude", NO_FINDINGS);
  engines.answerFor("codex", NO_FINDINGS);
  return engines;
}

/** A fake GitHub whose compares take a moment, counting them and how many ran at once at most. */
class CompareCountingHost extends FakeGitHost {
  compares = 0;
  most = 0;
  private running = 0;
  override async countCommits(repo: RepositoryRef, from: CommitSha, to: CommitSha): Promise<CommitCount> {
    this.compares++;
    this.running++;
    this.most = Math.max(this.most, this.running);
    await new Promise((resolve) => setImmediate(resolve));
    try {
      return await super.countCommits(repo, from, to);
    } finally {
      this.running--;
    }
  }
}

const startedBy = (events: Event[]) =>
  events.flatMap((e) => (e.type === "run.started" ? [e.run.reviewer] : []));

test("a pull request whose head commit says Co-authored-by: Claude is found by Codex, and the app says Claude wrote it", async () => {
  const engines = bothEngines();
  const { service, host, time } = await start({ changes: [pr1], engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

  host.open(opened(3, { messages: ["Start the filter", CLAUDE_CODE] }));
  await time.advance(MIN);
  const events = await until(stream, "round.finished");
  expect(events[0]).toMatchObject({ type: "change.opened", change: { id: idOf(3), writtenBy: "claude" } });
  expect(startedBy(events)).toEqual(["codex"]);
  expect(engines.runs.map((r) => r.engine)).toEqual(["codex"]);
  expect((await snapshot(service, cookie)).changes[idOf(3)]).toMatchObject({ writtenBy: "claude" });
});

test("another author's pull request written by Claude is found by Claude, when the owner asks", async () => {
  const engines = bothEngines();
  const { service, host, time } = await start({ changes: [pr1], engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

  const theirs = opened(6, { author: { id: 583231, login: "octocat" } });
  host.open({ ...theirs, head: { ...theirs.head, ref: "claude/fix" } });
  await time.advance(MIN);
  expect((await until(stream, "job.changed")).at(-1)).toMatchObject({ job: { skip: "not-yours" } });
  host.seedComment({ repo: SANDBOX, number: 6 }, { author: OWNER, body: "/lookover review" });
  await time.advance(MIN);
  const events = await until(stream, "round.finished");
  expect(startedBy(events)).toEqual(["claude"]);
  expect(engines.runs.map((r) => r.engine)).toEqual(["claude"]);
  expect((await snapshot(service, cookie)).changes[idOf(6)]).toMatchObject({ writtenBy: "claude" });
});

test("on an organisation's App, the person's change written by Claude is found by Codex; a teammate's by Claude, when the person asks", async () => {
  const engines = bothEngines();
  const time = new DemoClock({ at: T0 });
  const host = organisationHost(time, [onAcmeWeb(pr1)]);
  const dir = home();
  const { service } = await start({
    home: dir,
    host,
    time,
    engines,
    github: await onOrganisationApp(host, dir),
  });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

  // The person's own, though the App's account is the organisation's.
  host.open(onAcmeWeb(opened(3, { messages: [CLAUDE_CODE] })));
  await time.advance(MIN);
  expect(startedBy(await until(stream, "round.finished"))).toEqual(["codex"]);

  const theirs = opened(6, { author: { id: 583231, login: "octocat" }, messages: [CLAUDE_CODE] });
  host.open(onAcmeWeb(theirs));
  await time.advance(MIN);
  expect((await until(stream, "job.changed")).at(-1)).toMatchObject({ job: { skip: "not-yours" } });
  host.seedComment({ repo: ACME_WEB, number: 6 }, { author: OWNER, body: "/lookover review" });
  await time.advance(MIN);
  expect(startedBy(await until(stream, "round.finished"))).toEqual(["claude"]);
  expect(engines.runs.map((r) => r.engine)).toEqual(["codex", "claude"]);
});

test("a push whose commits say Codex wrote them moves the writer, in the app and for the next review", async () => {
  const engines = bothEngines();
  const { service, host, time } = await start({ changes: [pr1], engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  host.open(opened(7, { messages: [CLAUDE_CODE] }));
  await time.advance(MIN);
  await until(stream, "round.finished");

  const codex = "Rewrite the filter\n\nCo-authored-by: Codex <codex@openai.com>";
  host.push({ repo: SANDBOX, number: 7 }, commitSha("7".repeat(40)), [], [], { messages: ["Bump", codex] });
  await time.advance(10_000);
  const pushed = [...(await until(stream, "change.pushed")), ...(await until(stream, "change.opened"))];
  expect(pushed.at(-1)).toMatchObject({ change: { id: idOf(7), writtenBy: "codex" } });
  // A push whose commits say nothing keeps it.
  host.push({ repo: SANDBOX, number: 7 }, commitSha("8".repeat(40)), [], [], { messages: ["By hand"] });
  await time.advance(10_000);
  await until(stream, "change.pushed");
  expect((await snapshot(service, cookie)).changes[idOf(7)]).toMatchObject({ writtenBy: "codex" });
  // The next review is Claude's, since Codex wrote it last.
  expect((await post(service, cookie, { type: "review.request", changeId: idOf(7) })).status).toBe(200);
  expect(startedBy(await until(stream, "round.finished"))).toEqual(["claude"]);
  expect(engines.runs.map((r) => r.engine)).toEqual(["codex", "claude"]);
});

test("a compare GitHub refuses leaves who wrote the change unread: the next poll reads it", async () => {
  const engines = bothEngines();
  const { service, host, time } = await start({ changes: [pr1], engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  host.refuseCounts("unavailable");
  host.open(opened(8, { messages: [CLAUDE_CODE], draft: true }));
  await time.advance(MIN);
  expect((await until(stream, "change.opened")).at(-1)).toMatchObject({ change: { writtenBy: null } });

  host.refuseCounts(null);
  await time.advance(MIN);
  expect((await until(stream, "change.opened")).at(-1)).toMatchObject({
    change: { id: idOf(8), writtenBy: "claude" },
  });
  expect((await snapshot(service, cookie)).changes[idOf(8)]).toMatchObject({ writtenBy: "claude" });
});

test("a compare GitHub refuses as rate limited makes the poll wait, as a listing refused so does", async () => {
  const { service, host, time } = await start({ changes: [pr1], engines: bothEngines() });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  host.refuseCounts("rate_limited");
  host.open(opened(9, { draft: true }));
  await time.advance(MIN);
  expect((await until(stream, "connection.changed")).at(-1)).toMatchObject({
    patch: { limitUntil: expect.any(Number) },
  });
  expect((await snapshot(service, cookie)).connection.limitUntil).toBeGreaterThan(time.now());
});

test("a first listing of many pull requests compares a few at a time", async () => {
  const host = new CompareCountingHost({
    repo: SANDBOX,
    bot: BOT,
    changes: Array.from({ length: 12 }, (_, i) => opened(20 + i, { messages: [CLAUDE_CODE] })),
  });
  const { service } = await start({ host, engines: bothEngines() });
  const cookie = await openApp(service);
  const state: State = await snapshot(service, cookie);
  expect(Object.values(state.changes).map((c) => c.writtenBy)).toEqual(
    Array.from({ length: 12 }, () => "claude"),
  );
  expect(host.compares).toBe(12);
  expect(host.most).toBeLessThanOrEqual(4);
});
