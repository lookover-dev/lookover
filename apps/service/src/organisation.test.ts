// An organisation's App (ADR 0059), through the service's entry, on fakes only: the App ACME owns, put straight into
// the data folder's App store with the person it works for, as the manifest flow and "Use an existing App" will keep
// it. GitHub (the fake) describes the App as ACME's, installs it on ACME and lists ACME's repositories. Discovery takes
// that installation, and the person rule holds as on a personal App: only the person's changes, and their coding
// agents' pushed under their login, are reviewed by themselves; a teammate's is skipped `not-yours`, their
// `/lookover review` ignored, the person's on it reviewed by Claude alone; a fork follows the fork rule. Replies
// count from the person and the change's author, never another teammate (a fork's: `claims.test.ts`).
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  type AppCredentials,
  changeId,
  commitSha,
  connectionCauseOf,
  type Event,
  HostError,
  type Repository,
} from "@lookover/contracts";
import { openStore } from "@lookover/store";
import {
  DemoClock,
  type FakeChange,
  type FakeEngines,
  FakeGitHost,
  type ScriptedRun,
} from "@lookover/testkit";
import { again, roundOne, STILL } from "./claims.test-support.ts";
import {
  ACME,
  ACME_WEB,
  api,
  BOT,
  fakeEngines,
  home,
  messages,
  OWNER,
  onFakeGitHub,
  onOrganisationApp,
  openApp,
  organisationHost,
  pr1,
  SANDBOX,
  snapshot,
  start,
  startRoom,
  stopAll,
  T0,
  TEST_LIMIT_MS,
  until,
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

/** The service on ACME's App, kept in the data folder, working for the owner; listening to its events. */
async function onAcme(changes: FakeChange[] = []) {
  const time = new DemoClock({ at: T0 });
  const host = organisationHost(time, changes);
  const dir = home();
  const engines = bothEngines();
  const { service } = await start({
    home: dir,
    host,
    time,
    engines,
    github: await onOrganisationApp(host, dir),
  });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  return { service, host, time, engines, cookie, stream };
}

test("the installation on the organisation is found and its repositories discovered; the App's account and the person apart", async () => {
  const { service, cookie } = await onAcme();
  const state = await snapshot(service, cookie);
  expect(state.connection).toMatchObject({
    state: "connected",
    app: { account: ACME, person: OWNER },
    accounts: [{ account: ACME, installationId: 60_000_001, cause: null }],
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

test("a teammate's change is skipped not-yours, their request ignored; the person's request has Claude alone review it", async () => {
  const { service, host, time, engines, cookie, stream } = await onAcme();

  // Written by Claude: on the person's own change Codex would find it.
  host.open(opened(5, { author: TEAMMATE, messages: [CLAUDE_CODE] }));
  await time.advance(MIN);
  expect((await until(stream, "job.changed")).at(-1)).toMatchObject({ job: { skip: "not-yours" } });
  expect((await snapshot(service, cookie)).changes[idOf(5)]).toMatchObject({ author: "other" });

  // Its skipped check posted; then nothing more, however long the polls go on.
  const skipped = host.posts.length;
  host.seedComment(ref(5), { author: TEAMMATE, body: "/lookover review" });
  await time.advance(5 * MIN);
  expect(engines.runs).toEqual([]);
  expect(host.posts.slice(skipped)).toEqual([]);

  host.seedComment(ref(5), { author: OWNER, body: "/lookover review" });
  await time.advance(MIN);
  const events = await until(stream, "round.finished");
  expect(events.at(-1)).toMatchObject({ changeId: idOf(5) });
  expect(startedBy(events)).toEqual(["claude"]);
  expect(engines.runs.map((r) => r.engine)).toEqual(["claude"]);
});

test("a fork of an organisation's repository follows the fork rule: skipped, even the person's, and Claude alone when asked", async () => {
  const { host, time, engines, stream } = await onAcme();

  host.open(opened(7, { fork: true }));
  await time.advance(MIN);
  expect((await until(stream, "job.changed")).at(-1)).toMatchObject({ job: { skip: "fork" } });
  expect(engines.runs).toEqual([]);

  host.seedComment(ref(7), { author: OWNER, body: "/lookover review" });
  await time.advance(MIN);
  expect(startedBy(await until(stream, "round.finished"))).toEqual(["claude"]);
});

/** Round 1 on `change`, one of ACME's `web`, with ACME's App kept in the data folder working for the owner. */
async function roundOneOnAcme(change: FakeChange) {
  const time = new DemoClock({ at: T0 });
  const host = organisationHost(time);
  const dir = home();
  const github = await onOrganisationApp(host, dir);
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

test("live.json's organisation App works for the person their own gh names; without gh, it is refused at start", async () => {
  const time = new DemoClock({ at: T0 });
  const host = organisationHost(time);
  const { connect } = onFakeGitHub(host);
  // As `live.json` names it: never stored, described by GitHub at start, ACME's.
  const given = { installations: host, connect, given: host.credentials() };
  const asked: string[] = [];
  const person = async () => {
    asked.push("person");
    return { id: 11247504, login: "sasensi" };
  };
  const { service } = await start({ home: home(), host, time, github: { ...given, person } });
  const state = await snapshot(service, await openApp(service));
  expect(state.connection).toMatchObject({
    state: "connected",
    app: { account: ACME, person: { id: 11247504, login: "sasensi" } },
  });
  expect(asked).toEqual(["person"]);

  // The person is never the organisation: with nobody to ask, the App is refused at start, as before.
  const dir = home();
  // Its own store, closed after: a refused start leaves it open.
  const store = openStore({ home: dir, durable: false });
  await expect(start({ home: dir, store, host, time, github: given })).rejects.toThrow(
    "belongs to the organisation acme",
  );
  store.close();
});

test("live.json's organisation App described after start, gh signed out by then: GitHub's refusal, its cause unreachable", async () => {
  const time = new DemoClock({ at: T0 });
  const host = organisationHost(time);
  const { connect } = onFakeGitHub(host);
  // GitHub refuses the App at start, then answers: it is described at the first call that needs it, here Reconnect.
  let refusing = true;
  const app = (credentials: AppCredentials) =>
    refusing ? Promise.reject(new HostError("unavailable", "GitHub is down")) : host.app(credentials);
  const person = () => Promise.reject(new Error("gh is signed out (gh auth login)"));
  const github = {
    installations: {
      convertManifest: (code: string) => host.convertManifest(code),
      app,
      installation: (credentials: AppCredentials) => host.installation(credentials),
      repositories: (credentials: AppCredentials, id: number) => host.repositories(credentials, id),
    },
    connect,
    given: host.credentials(),
    person,
  };
  const { room } = await startRoom({ home: home(), host, time, github });
  refusing = false;

  const refused = await room.reconnect().then(
    () => null,
    (error: unknown) => error,
  );
  if (!(refused instanceof HostError)) throw new Error(`refused with ${String(refused)}`);
  expect(refused.failure).toBe("unavailable");
  expect(connectionCauseOf(refused)).toEqual({ kind: "unreachable" });
  expect(refused.message).toBe("gh is signed out (gh auth login)");
});

test("an organisation's App not installed says the organisation; a personal App, the person's account", async () => {
  const time = new DemoClock({ at: T0 });
  const host = organisationHost(time);
  host.uninstall();
  const dir = home();
  const { logged } = await startRoom({ home: dir, host, time, github: await onOrganisationApp(host, dir) });
  expect(logged.join("\n")).toContain("lookover-spike-sasensi is not installed on the organisation acme");

  const personal = new FakeGitHost({ repo: SANDBOX, bot: BOT, changes: [], clock: time });
  personal.uninstall();
  const mine = await startRoom({ host: personal, time });
  expect(mine.logged.join("\n")).toContain("lookover-spike-sasensi is not installed on sasensi's account");
});
