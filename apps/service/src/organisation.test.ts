// An organisation's repositories (ADR 0059, ADR 0066), through the service's entry, on fakes only: the owner signed in
// to the shared App, installed on ACME, whose repositories it lists. Discovery takes that installation, and the person
// rule holds as on the person's own account: only the person's changes, and their coding
// agents' pushed under their login, are reviewed by themselves; a teammate's gets nothing on GitHub (ADR 0078), their
// `/lookover review` ignored, the person's on it reviewed by Claude alone; the person's fork follows the fork rule.
// Replies count from the person and the change's author, never another teammate (a fork's: `claims.test.ts`).
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { changeId, commitSha, type Event, type Repository } from "@lookover/contracts";
import { DemoClock, type FakeChange, type FakeEngines, type ScriptedRun } from "@lookover/testkit";
import { again, roundOne, STILL } from "./claims.test-support.ts";
import {
  ACME,
  ACME_WEB,
  api,
  fakeEngines,
  home,
  messages,
  OWNER,
  openApp,
  organisationHost,
  pr1,
  signedInOn,
  snapshot,
  start,
  stopAll,
  T0,
  TEST_LIMIT_MS,
  until,
  writeSettings,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const MIN = 60_000;
const NO_FINDINGS: ScriptedRun = { outcome: "ok", text: '```json\n{"findings": []}\n```' };
/** A teammate in ACME: not the person Lookover works for. */
const TEAMMATE = { id: 583231, login: "octocat" };
/** Another teammate in ACME. */
const ANOTHER_TEAMMATE = { id: 583232, login: "monalisa" };
const CLAUDE_CODE = "Fix the total\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>";

/** A pull request on ACME's `web`, the person's unless said, on a commit of its own. */
const opened = (number: number, more: Partial<FakeChange> = {}): FakeChange => ({
  ...pr1,
  repo: ACME_WEB,
  number,
  title: `Pull request ${number}`,
  url: `https://github.com/acme/web/pull/${number}`,
  head: { ref: `branch-${number}`, sha: commitSha(`${number}`.padStart(7, "f").padEnd(40, "0")) },
  ...more,
});
const ref = (number: number) => ({ repo: ACME_WEB, number });
const idOf = (number: number) => changeId(`acme/web#${number}`);

/** Claude and Codex both signed in, each answering every run with no finding. */
function bothEngines(): FakeEngines {
  const engines = fakeEngines();
  engines.setHealth("codex", { installed: true, version: "0.162.1", signedIn: true });
  engines.answerFor("claude", NO_FINDINGS);
  engines.answerFor("codex", NO_FINDINGS);
  return engines;
}

const startedBy = (events: Event[]) =>
  events.flatMap((e) => (e.type === "run.started" ? [e.run.reviewer] : []));

/** The service signed in as the owner, the shared App installed on ACME; listening to its events. */
async function onAcme(changes: FakeChange[] = [], options: { onPush?: boolean } = {}) {
  const time = new DemoClock({ at: T0 });
  const host = organisationHost(time, changes);
  const dir = home();
  if (options.onPush)
    writeSettings(dir, "acme/web/settings.yaml", "$schema: lookover.settings/v1\nversion: 1\nonPush: true\n");
  const engines = bothEngines();
  const { service } = await start({
    home: dir,
    host,
    time,
    engines,
    github: await signedInOn(host, dir),
  });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  return { service, host, time, engines, cookie, stream };
}

test("the installation on the organisation is found and its repositories discovered; the person is not the organisation", async () => {
  const { service, cookie } = await onAcme();
  const state = await snapshot(service, cookie);
  expect(state.connection).toMatchObject({
    state: "connected",
    person: OWNER,
    accounts: [{ account: ACME, cause: null }],
  });
  expect(state.repos.map((r: Repository) => r.id)).toEqual(["acme/web", "acme/api"]);
});

test("the person's change is reviewed by itself, and their coding agent's, pushed under their login, found by Codex", async () => {
  const { service, host, time, cookie, stream } = await onAcme();

  host.open(opened(3));
  await time.advance(MIN);
  const own = await until(stream, "round.finished");
  expect(own.at(-1)).toMatchObject({ changeId: idOf(3) });

  host.open(opened(4, { messages: [CLAUDE_CODE] }));
  await time.advance(MIN);
  const agents = await until(stream, "round.finished");
  expect(agents.at(-1)).toMatchObject({ changeId: idOf(4) });
  expect(startedBy(agents)).toEqual(["codex"]);
  const changes = (await snapshot(service, cookie)).changes;
  expect(changes[idOf(3)]).toMatchObject({ author: "you" });
  expect(changes[idOf(4)]).toMatchObject({ author: "you", writtenBy: "claude" });
});

test("a teammate's change gets nothing on GitHub: opened, a draft marked ready, pushed to, their own request (ADR 0078)", async () => {
  const { service, host, time, engines, cookie, stream } = await onAcme([], { onPush: true });

  // Written by Claude: on the person's own change Codex would find it.
  host.open(opened(5, { author: TEAMMATE, messages: [CLAUDE_CODE] }));
  host.open(opened(6, { author: TEAMMATE, draft: true }));
  await time.advance(MIN);
  await until(stream, "change.opened");
  host.markReady(ref(6));
  host.push(ref(5), commitSha("5".repeat(40)), []);
  await time.advance(MIN);
  host.seedComment(ref(5), { author: TEAMMATE, body: "/lookover review" });
  await time.advance(5 * MIN);

  const state = await snapshot(service, cookie);
  expect(state.changes[idOf(5)]).toMatchObject({ author: "other", headSha: commitSha("5".repeat(40)) });
  expect(state.changes[idOf(6)]).toMatchObject({ author: "other", draft: false });
  // No job, no check, no status block, no reaction: as if Lookover wasn't installed.
  expect([state.reviews[idOf(5)]?.job, state.reviews[idOf(6)]?.job]).toEqual([null, null]);
  expect(engines.runs).toEqual([]);
  expect(host.posts).toEqual([]);
});

test("the person's request on a teammate's change is reviewed by Claude alone and posted; the teammate's push then gets nothing", async () => {
  const { host, time, engines, stream } = await onAcme([], { onPush: true });
  host.open(opened(5, { author: TEAMMATE, messages: [CLAUDE_CODE] }));
  await time.advance(MIN);
  await until(stream, "change.opened");

  host.seedComment(ref(5), { author: OWNER, body: "/lookover review" });
  await time.advance(MIN);
  const events = await until(stream, "round.finished");
  expect(events.at(-1)).toMatchObject({ changeId: idOf(5) });
  expect(startedBy(events)).toEqual(["claude"]);
  expect(engines.runs.map((r) => r.engine)).toEqual(["claude"]);
  await time.advance(0);
  const asked = host.view(ref(5));
  expect(asked.checks.map((c) => `${c.status} ${c.conclusion}`)).toEqual(["completed success"]);
  expect(host.posts.some((p) => p.kind === "reaction")).toBe(true);

  // The teammate pushes, with reviews after every push on: nothing on the new head, the block left as it was.
  const posted = host.posts.length;
  const block = host.description(ref(5));
  const pushed = commitSha("5".repeat(40));
  host.push(ref(5), pushed, []);
  await time.advance(5 * MIN);
  expect(host.posts.slice(posted)).toEqual([]);
  expect(host.view(ref(5), pushed).checks).toEqual([]);
  expect(host.description(ref(5))).toBe(block);
  expect(engines.runs.map((r) => r.engine)).toEqual(["claude"]);
});

test("the person's request waiting on a teammate's change moves to the teammate's push: its check and block on the new head, nothing else (ADR 0040)", async () => {
  const { service, host, time, engines, cookie, stream } = await onAcme();
  engines.setHealth("claude", { installed: true, version: "2.4.1", signedIn: false });
  host.open(opened(5, { author: TEAMMATE }));
  await time.advance(MIN);
  await until(stream, "change.opened");

  // Claude is signed out, and Codex never reviews a teammate's change: the person's request waits.
  host.seedComment(ref(5), { author: OWNER, body: "/lookover review" });
  await time.advance(MIN);
  await time.advance(0);
  const before = (await snapshot(service, cookie)).reviews[idOf(5)]?.job;
  expect(before).toMatchObject({ trigger: "comment", state: "deferred", sha: opened(5).head.sha });

  // The teammate pushes: the person asked for this pull request's review, so the same job moves to the new head.
  const posted = host.posts.length;
  const pushed = commitSha("5".repeat(40));
  host.push(ref(5), pushed, []);
  await time.advance(MIN);
  await time.advance(0);
  expect((await snapshot(service, cookie)).reviews[idOf(5)]?.job).toMatchObject({
    id: before?.id,
    state: "deferred",
    sha: pushed,
  });
  const checks = (sha: string) =>
    host.view(ref(5), commitSha(sha)).checks.map((c) => `${c.status} ${c.conclusion}: ${c.output.title}`);
  // The old head's check is closed as left behind, the new head's says why it waits, the block follows: no reaction,
  // no review, no reply.
  expect([checks(opened(5).head.sha), checks(pushed)]).toEqual([
    ["completed skipped: A newer commit was pushed"],
    ["queued null: Waiting: Claude is signed out"],
  ]);
  expect(host.description(ref(5))).toContain(pushed.slice(0, 7));
  expect(
    host.posts.slice(posted).map((p) => (p.kind === "check.created" ? `${p.kind} ${p.sha}` : p.kind)),
  ).toEqual(["check.completed", `check.created ${pushed}`, "status.written"]);
  expect(engines.runs).toEqual([]);
});

test("the person's fork of an organisation's repository follows the fork rule: skipped, and Claude alone when asked", async () => {
  const { host, time, engines, stream } = await onAcme();

  host.open(opened(7, { fork: true }));
  await time.advance(MIN);
  expect((await until(stream, "job.changed")).at(-1)).toMatchObject({ job: { skip: "fork" } });
  expect(engines.runs).toEqual([]);

  host.seedComment(ref(7), { author: OWNER, body: "/lookover review" });
  await time.advance(MIN);
  expect(startedBy(await until(stream, "round.finished"))).toEqual(["claude"]);
});

/** Round 1 on `change`, one of ACME's `web`, the owner signed in to the shared App installed on ACME. */
async function roundOneOnAcme(change: FakeChange) {
  const time = new DemoClock({ at: T0 });
  const host = organisationHost(time);
  const dir = home();
  const github = await signedInOn(host, dir);
  return roundOne({ change, host, time, home: dir, github });
}

test("the person's reply on their own change counts: the account is the organisation, the person who replies is them", async () => {
  const w = await roundOneOnAcme(opened(8));
  w.host.seedReply(w.ref, w.root, { author: OWNER, body: "Won't fix: the last invoice is a sentinel." });
  await w.ask(again(true, STILL));

  expect(w.prompt()).toContain("Won't fix: the last invoice is a sentinel.");
  expect(w.result().findings[0]).toMatchObject({
    id: "F1",
    claim: { kind: "wont_fix", by: "sasensi", count: 1 },
    resolution: { kind: "kept", round: 2 },
  });
});

test("on a teammate's change the person asked for, its author's reply counts (ADR 0052) and another teammate's never steers", async () => {
  const w = await roundOneOnAcme(opened(9, { author: TEAMMATE }));
  w.host.seedReply(w.ref, w.root, { author: TEAMMATE, body: "Deferred: the sentinel goes next sprint." });
  // Newer, but from a teammate who neither runs Lookover nor wrote the change.
  w.host.seedReply(w.ref, w.root, { author: ANOTHER_TEAMMATE, body: "Fixed, trust me." });
  await w.ask(again(true, STILL));

  expect(w.prompt()).toContain("Deferred: the sentinel goes next sprint.");
  expect(w.prompt()).not.toContain("trust me");
  expect(w.result().findings[0]).toMatchObject({
    id: "F1",
    claim: { kind: "deferred", by: TEAMMATE.login, count: 1 },
  });
});
