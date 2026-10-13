// Polling (ADR 0043), through the service's entry, on fakes only: the service lists the watched repository's
// pull requests by itself, every 10 s while one of its changes is hot and every minute otherwise, and what it
// sees becomes events and jobs with nobody clicking: a pull request opened or marked ready is reviewed, a push is
// counted and moves the waiting job (reviewed only with "review after every push" on), a closed one leaves the
// list and its waiting job is cancelled, another author's is skipped with the reason on its check. A rate-limited
// listing waits until GitHub's reset time, and the connection says so.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  changeId,
  commitSha,
  type Event,
  type HostChange,
  HostError,
  type Listing,
  type RepositoryRef,
  type State,
} from "@lookover/contracts";
import { openStore } from "@lookover/store";
import { type FakeChange, FakeGitHost } from "@lookover/testkit";
import {
  api,
  BOT,
  fakeEngines,
  heldRuns,
  home,
  lastEvent,
  messages,
  openApp,
  PLANTED,
  post,
  pr1,
  review,
  SANDBOX,
  SHA1,
  SHA1_PUSHED,
  sinceStart,
  snapshot,
  start,
  stopAll,
  T0,
  TEST_LIMIT_MS,
  until,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const SIGNED_IN = { installed: true, version: "2.4.1", signedIn: true };
const MIN = 60_000;

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
const ref = (number: number) => ({ repo: SANDBOX, number });

/** A fake GitHub that counts how often the open pull requests were listed. */
class CountingHost extends FakeGitHost {
  lists = 0;
  /**
   * GitHub's wait on the repository listings alone, until when it said: the App's own reads at start (ADR 0053) are
   * counted against the App, not the installation, and answer.
   */
  listingsLimitedUntil: number | null = null;
  override listOpenChanges(repo: RepositoryRef): Promise<Listing<HostChange>> {
    this.lists++;
    const retryAt = this.listingsLimitedUntil;
    if (retryAt !== null)
      return Promise.reject(new HostError("rate_limited", "The host asked to wait (429)", { retryAt }));
    return super.listOpenChanges(repo);
  }
}

const named = (e: Event) => {
  if (e.type === "change.opened") return `${e.type} ${e.change.id}`;
  return "changeId" in e ? `${e.type} ${e.changeId}` : e.type;
};

test("a pull request opened is reviewed with nobody asking; those open at the first start are only listed", async () => {
  const { service, host, time } = await start({ changes: [pr1], engines: fakeEngines({ reviews: 1 }) });
  const cookie = await openApp(service);
  // The first listing of a repository shows what was already open: nothing asked for it.
  expect((await snapshot(service, cookie)).reviews[PLANTED]).toMatchObject({ job: null });
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

  host.open(opened(3));
  await time.advance(MIN);
  const events = await until(stream, "round.finished");
  expect(events.map(named)).toEqual([
    `change.opened ${idOf(3)}`,
    `job.changed ${idOf(3)}`,
    `run.started ${idOf(3)}`,
    `run.step ${idOf(3)}`,
    `run.step ${idOf(3)}`,
    `run.posting ${idOf(3)}`,
    `run.posting ${idOf(3)}`,
    `run.posting ${idOf(3)}`,
    `run.posting ${idOf(3)}`,
    `run.posting ${idOf(3)}`,
    `round.finished ${idOf(3)}`,
  ]);
  expect(events[1]).toMatchObject({ job: { trigger: "opened", state: "queued" } });
  const state = await snapshot(service, cookie);
  expect(state.reviews[idOf(3)]?.rounds).toHaveLength(1);
  expect(state.reviews[PLANTED]).toMatchObject({ job: null });
});

test("a draft is left alone until it is marked ready, then reviewed", async () => {
  const { service, host, time } = await start({ changes: [pr1], engines: fakeEngines({ reviews: 1 }) });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

  host.open(opened(4, { draft: true }));
  await time.advance(MIN);
  expect((await until(stream, "change.opened")).map(named)).toEqual([`change.opened ${idOf(4)}`]);
  await time.advance(5 * MIN);
  // No job, no check: nothing was asked (ADR 0043).
  expect((await snapshot(service, cookie)).reviews[idOf(4)]).toMatchObject({ job: null });
  expect(host.posts).toEqual([]);

  host.markReady(ref(4));
  await time.advance(MIN);
  const events = await until(stream, "round.finished");
  expect(events.slice(0, 3).map(named)).toEqual([
    `change.opened ${idOf(4)}`,
    `job.changed ${idOf(4)}`,
    `run.started ${idOf(4)}`,
  ]);
  expect(events[0]).toMatchObject({ change: { draft: false } });
  expect(events[1]).toMatchObject({ job: { trigger: "opened" } });
  // The review it had (its timeline) is kept: marked ready is not opened twice.
  const timeline = (await snapshot(service, cookie)).reviews[idOf(4)]?.timeline ?? [];
  expect(timeline.filter((t: { kind: string }) => t.kind === "opened")).toHaveLength(1);
});

test("a pull request opened while the service was stopped is reviewed at the next start", async () => {
  const dir = home();
  const first = await start({ home: dir, changes: [pr1] });
  await first.service.stop();
  const last = lastEvent(dir);
  first.host.open(opened(5));
  const { service } = await start({
    home: dir,
    host: first.host,
    time: first.time,
    engines: fakeEngines({ reviews: 1 }),
  });
  const cookie = await openApp(service);
  const events = await until(await sinceStart(service, cookie, last), "round.finished");
  expect(events.filter((e) => e.type !== "run.step" && e.type !== "run.posting").map(named)).toEqual([
    `change.opened ${idOf(5)}`,
    `job.changed ${idOf(5)}`,
    `run.started ${idOf(5)}`,
    `round.finished ${idOf(5)}`,
  ]);
});

test("a push shows its commit count, moves the waiting job to the new head, and asks for no review with the switch off", async () => {
  const engines = fakeEngines({ signedIn: false });
  const { service, host, time } = await start({ changes: [pr1], engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  const waiting = (await until(stream, "job.changed")).at(-1);
  await until(stream, "job.changed");

  host.push(ref(1), SHA1_PUSHED, [], [], { commits: 2 });
  await time.advance(10_000);
  const events = [...(await until(stream, "change.pushed")), ...(await until(stream, "job.changed"))];
  expect(events.map(named)).toEqual([`change.pushed ${PLANTED}`, `job.changed ${PLANTED}`]);
  expect(events[0]).toMatchObject({ sha: SHA1_PUSHED, commits: 2 });
  // The same job, on the new head, still waiting for Claude: no other job was made.
  expect(events[1]).toMatchObject({
    job: { id: waiting?.type === "job.changed" ? waiting.job.id : "", sha: SHA1_PUSHED, state: "deferred" },
  });
  const review1 = (await snapshot(service, cookie)).reviews[PLANTED];
  expect(review1?.timeline.at(-1)).toMatchObject({ kind: "pushed", commits: 2, sha: SHA1_PUSHED });

  // Its check followed it: the old commit's is completed, a new one waits on the new head.
  await time.advance(0);
  expect(host.view(ref(1), SHA1).checks.map((c) => `${c.status} ${c.conclusion}`)).toEqual([
    "completed skipped",
  ]);
  expect(host.view(ref(1), SHA1_PUSHED).checks.map((c) => c.status)).toEqual(["queued"]);
});

test("a push on a pull request with no review waiting makes no job: review after every push is off", async () => {
  const { service, host, time } = await start({ changes: [pr1] });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  host.push(ref(1), SHA1_PUSHED, []);
  await time.advance(MIN);
  expect((await until(stream, "change.pushed")).at(-1)).toMatchObject({ commits: 1 });
  await time.advance(MIN);
  expect((await snapshot(service, cookie)).reviews[PLANTED]).toMatchObject({ job: null });
  expect(host.posts).toEqual([]);
});

test("a push GitHub can't count is shown with no count", async () => {
  const { service, host, time } = await start({ changes: [pr1] });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  // GitHub's compare fails (it hasn't computed the push yet, or a bad moment); the listing answers.
  host.refuseCounts("unavailable");
  host.push(ref(1), SHA1_PUSHED, []);
  await time.advance(MIN);
  expect((await until(stream, "change.pushed")).at(-1)).toMatchObject({ commits: 0, sha: SHA1_PUSHED });
});

test("a closed pull request leaves the list, its waiting job cancelled and its check skipped", async () => {
  const { service, host, time } = await start({
    changes: [pr1, opened(3)],
    engines: fakeEngines({ signedIn: false }),
  });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "job.changed");
  await until(stream, "job.changed");

  host.close(ref(1));
  await time.advance(10_000);
  const events = [...(await until(stream, "change.closed")), ...(await until(stream, "job.changed"))];
  expect(events.map(named)).toEqual([`change.closed ${PLANTED}`, `job.changed ${PLANTED}`]);
  expect(events[1]).toMatchObject({ job: { state: "cancelled", cancel: "closed" } });
  const state: State = await snapshot(service, cookie);
  expect(Object.keys(state.changes)).toEqual([idOf(3)]);
  // Its review is kept, out of the list: a reopening goes on from it.
  expect(state.reviews[PLANTED]?.job).toMatchObject({ state: "cancelled", cancel: "closed" });
  await time.advance(0);
  expect(host.view(ref(1)).checks.map((c) => `${c.status} ${c.conclusion}: ${c.output.title}`)).toEqual([
    "completed skipped: The pull request was closed",
  ]);
});

test("a pull request closed while its review runs leaves the list; the review finishes, posts and keeps its round", async () => {
  const engines = fakeEngines({ reviews: 1 });
  const held = heldRuns(engines);
  const dir = home();
  const { service, host, time } = await start({ home: dir, changes: [pr1], engines: held.engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "run.started");

  host.close(ref(1));
  await time.advance(10_000);
  expect((await until(stream, "change.closed")).at(-1)).toMatchObject({ changeId: PLANTED });
  held.release();
  expect((await until(stream, "round.finished")).at(-1)).toMatchObject({ job: { state: "done" } });
  await time.advance(0);
  // Posted on GitHub, its check completed by the round; kept by the store for the next round.
  expect(host.posts.filter((p) => p.kind === "review")).toHaveLength(1);
  expect(host.view(ref(1)).checks.map((c) => `${c.status} ${c.conclusion}`)).toEqual(["completed success"]);
  await service.stop();
  const store = openStore({ home: dir, durable: false });
  expect(store.rounds.of(PLANTED)).toEqual([{ n: 1, sha: SHA1 }]);
  store.close();
});

test("a pull request closed and reopened goes on with its review: its next round is round 2, in the app as in the store", async () => {
  const { service, host, time } = await start({ changes: [pr1], engines: fakeEngines({ reviews: 2 }) });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "round.finished");

  host.close(ref(1));
  await time.advance(10_000);
  await until(stream, "change.closed");
  expect((await snapshot(service, cookie)).changes[PLANTED]).toBeUndefined();

  // Reopened: listed again, so reviewed on opening, as round 2.
  host.reopen(ref(1));
  await time.advance(10_000);
  expect((await until(stream, "round.finished")).at(-1)).toMatchObject({ round: { n: 2 } });
  const state: State = await snapshot(service, cookie);
  expect(state.changes[PLANTED]?.headSha).toBe(SHA1);
  const kept = state.reviews[PLANTED];
  expect(kept?.rounds.map((r) => r.n)).toEqual([1, 2]);
  expect(kept?.timeline.map((t) => (t.kind === "started" ? `started ${t.round}` : t.kind))).toEqual([
    "opened",
    "queued",
    "started 1",
    "posted",
    "opened",
    "queued",
    "started 2",
    "posted",
  ]);
});

test("a pull request closed on the host goes through the poll: it leaves the list", async () => {
  const { service, host } = await start();
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  host.close({ repo: SANDBOX, number: 2 });
  expect((await post(service, cookie, { type: "refresh" })).status).toBe(200);
  expect((await until(stream, "change.closed")).map(named)).toEqual([`change.closed ${idOf(2)}`]);
  expect(Object.keys((await snapshot(service, cookie)).changes)).toEqual([PLANTED]);
});

test("another author's pull request is skipped, with the reason on its check", async () => {
  const { service, host, time } = await start({ changes: [pr1], engines: fakeEngines({ reviews: 1 }) });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  host.open(opened(6, { author: { id: 583231, login: "octocat" } }));
  await time.advance(MIN);
  const events = [...(await until(stream, "change.opened")), ...(await until(stream, "job.changed"))];
  expect(events.at(-1)).toMatchObject({
    changeId: idOf(6),
    job: { state: "skipped", skip: "not-yours", trigger: "opened" },
  });
  await time.advance(0);
  expect(host.view(ref(6)).checks.map((c) => `${c.status} ${c.conclusion}: ${c.output.title}`)).toEqual([
    "completed skipped: Not your pull request",
  ]);
});

test("a pull request from a fork is shown as one, from the first listing and across a restart", async () => {
  const dir = home();
  const first = await start({ home: dir, changes: [pr1, opened(7, { fork: true })] });
  const forks = async (service: typeof first.service) => {
    const { changes } = await snapshot(service, await openApp(service));
    return [changes[PLANTED]?.fork, changes[idOf(7)]?.fork];
  };
  expect(await forks(first.service)).toEqual([false, true]);
  await first.service.stop();
  const again = await start({ home: dir, host: first.host, time: first.time });
  expect(await forks(again.service)).toEqual([false, true]);
});

test("polling runs every minute when nothing is going on, every 10 s while a review waits", async () => {
  const host = new CountingHost({ repo: SANDBOX, bot: BOT, changes: [pr1] });
  const engines = fakeEngines({ signedIn: false, reviews: 1 });
  const { service, time } = await start({ host, engines });
  const cookie = await openApp(service);
  expect(host.lists).toBe(1);
  await time.advance(MIN);
  expect(host.lists).toBe(2);
  await time.advance(MIN - 1);
  expect(host.lists).toBe(2);
  await time.advance(1);
  expect(host.lists).toBe(3);

  // A review asked for: it waits for Claude, and the repository is polled every 10 s.
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "job.changed");
  await until(stream, "job.changed");
  const asked = host.lists;
  await time.advance(MIN);
  expect(host.lists - asked).toBe(6);

  // Posted: still every 10 s for half an hour, the agent likely to push again; then every minute.
  engines.setHealth("claude", SIGNED_IN);
  await time.advance(MIN);
  await until(stream, "round.finished");
  await time.advance(5 * MIN);
  const hot = host.lists;
  await time.advance(10 * MIN);
  expect(host.lists - hot).toBe(60);
  await time.advance(16 * MIN);
  const quiet = host.lists;
  await time.advance(10 * MIN);
  expect(host.lists - quiet).toBe(10);
});

test("a reset time already past still waits 10 s between listings: GitHub is never hammered", async () => {
  const host = new CountingHost({ repo: SANDBOX, bot: BOT, changes: [pr1] });
  const { time } = await start({ host });
  host.refuse("rate_limited", { retryAt: time.now() - MIN });
  await time.advance(MIN);
  const refused = host.lists;
  await time.advance(MIN);
  expect(host.lists - refused).toBe(6);
});

test("a listing rate limited at start still starts the service: it waits for the reset, then lists", async () => {
  const host = new CountingHost({ repo: SANDBOX, bot: BOT, changes: [pr1] });
  const resetAt = T0 + 5 * MIN;
  host.listingsLimitedUntil = resetAt;
  const { service, time } = await start({ host });
  const cookie = await openApp(service);
  const state = await snapshot(service, cookie);
  expect(state.connection.limitUntil).toBe(resetAt);
  expect(state.changes).toEqual({});
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

  host.listingsLimitedUntil = null;
  await time.advance(5 * MIN - 1);
  expect(host.lists).toBe(1);
  await time.advance(1);
  // The first listing that answers: the repository, what is open, shown and not reviewed.
  const events = await until(stream, "change.opened");
  expect(events.map(named)).toEqual(["connection.changed", "repo.added", `change.opened ${PLANTED}`]);
  expect((await snapshot(service, cookie)).reviews[PLANTED]).toMatchObject({ job: null });
});

test("a rate-limited listing waits until GitHub's reset time, and the connection says so until then", async () => {
  const host = new CountingHost({ repo: SANDBOX, bot: BOT, changes: [pr1] });
  const { service, time } = await start({ host });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  const resetAt = time.now() + MIN + 5 * MIN;
  host.refuse("rate_limited", { retryAt: resetAt });
  await time.advance(MIN);
  expect((await until(stream, "connection.changed")).at(-1)).toMatchObject({
    patch: { limitUntil: resetAt },
  });
  expect((await snapshot(service, cookie)).connection.limitUntil).toBe(resetAt);
  const refused = host.lists;

  // Nothing is asked of GitHub before the reset, even past the next minute.
  host.refuse(null);
  host.open(opened(3));
  await time.advance(5 * MIN - 1);
  expect(host.lists).toBe(refused);
  await time.advance(1);
  expect(host.lists).toBe(refused + 1);
  const events = await until(stream, "change.opened");
  expect(events.map(named)).toEqual(["connection.changed", `change.opened ${idOf(3)}`]);
  expect(events[0]).toMatchObject({ patch: { limitUntil: null } });
});
