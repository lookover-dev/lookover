// Many repositories in one room (ADR 0053), through the service's door on the held demo clock and the fake host
// holding two of the owner's repositories: one poll loop lists both, each at its own cadence, and a pull request
// opened in either is reviewed; a repository switched off is still listed, and its `/lookover review` is recorded as
// a skip (ADR 0047); a rate limit met on one stops the listing of both until it ends, one refused alone (not found,
// or 5xx) never stops the other's, at start neither; "Review now" lists its change's repository only; the settings,
// the rules, the switch, the setup's choice and its first review work for either, and each round counts its own.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  changeId,
  commitSha,
  type HostChange,
  HostError,
  type Listing,
  type Repository,
  type RepositoryRef,
  repositoryId,
} from "@lookover/contracts";
import { openStore } from "@lookover/store";
import { DemoClock, type FakeChange, FakeGitHost } from "@lookover/testkit";
import {
  api,
  BOT,
  fakeEngines,
  home,
  messages,
  OWNER,
  openApp,
  post,
  pr1,
  SANDBOX,
  SANDBOX_SETTINGS,
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
const LEDGER: RepositoryRef = { owner: SANDBOX.owner, name: "ledger-api" };
const SANDBOX_ID = repositoryId(`${SANDBOX.owner}/${SANDBOX.name}`);
const LEDGER_ID = repositoryId(`${LEDGER.owner}/${LEDGER.name}`);
/** ledger-api's own settings file, in the data folder (ADR 0049). */
const LEDGER_SETTINGS = `${LEDGER.owner}/${LEDGER.name}/settings.yaml`;

/** A pull request the owner opens in `repo`, on commits of its own. */
const opened = (repo: RepositoryRef, number: number): FakeChange => ({
  ...pr1,
  repo,
  number,
  title: `Pull request ${number} of ${repo.name}`,
  url: `https://github.com/${repo.owner}/${repo.name}/pull/${number}`,
  head: {
    ref: `branch-${number}`,
    sha: commitSha(`${repo.name.length}${number}`.padStart(7, "e").padEnd(40, "0")),
  },
});

/** A fake GitHub holding the sandbox and ledger-api, which counts each repository's listings. */
class TwoRepos extends FakeGitHost {
  lists = new Map<string, number>();
  /** The listings of this repository are refused so, until set back to null. */
  refusing: { repo: RepositoryRef; error: HostError } | null = null;
  /** Every repository's listing refused so (the App's own reads answering), until set back to null. */
  everyListing: HostError | null = null;
  readonly time: DemoClock;
  constructor(time: DemoClock, changes: FakeChange[] = []) {
    super({ repo: SANDBOX, repositories: [LEDGER], bot: BOT, changes, clock: time });
    this.time = time;
  }
  override listOpenChanges(repo: RepositoryRef): Promise<Listing<HostChange>> {
    this.lists.set(repo.name, (this.lists.get(repo.name) ?? 0) + 1);
    const refusing = this.refusing;
    if (refusing !== null && refusing.repo.name === repo.name) return Promise.reject(refusing.error);
    if (this.everyListing !== null) return Promise.reject(this.everyListing);
    return super.listOpenChanges(repo);
  }
  listed(repo: RepositoryRef): number {
    return this.lists.get(repo.name) ?? 0;
  }
}

const both = { repos: [SANDBOX, LEDGER] };

test("a pull request opened in each of two repositories is reviewed, and both are shown", async () => {
  const host = new TwoRepos(new DemoClock({ at: T0 }));
  const { service, time } = await start({
    ...both,
    host,
    time: host.time,
    engines: fakeEngines({ reviews: 2 }),
  });
  const cookie = await openApp(service);
  expect((await snapshot(service, cookie)).repos.map((r: Repository) => r.id)).toEqual([
    SANDBOX_ID,
    LEDGER_ID,
  ]);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

  host.open(opened(SANDBOX, 3));
  host.open(opened(LEDGER, 7));
  await time.advance(MIN);
  await until(stream, "round.finished");
  await until(stream, "round.finished");
  const state = await snapshot(service, cookie);
  expect(state.reviews[changeId("lookover-sandbox#3")]?.rounds).toHaveLength(1);
  expect(state.reviews[changeId("ledger-api#7")]?.rounds).toHaveLength(1);
  expect(state.changes[changeId("ledger-api#7")]).toMatchObject({ repoId: LEDGER_ID, number: 7 });
  // Each review lands on its own repository's pull request, with its check.
  expect(host.view({ repo: LEDGER, number: 7 }).checks.map((c) => c.conclusion)).toEqual(["success"]);
  expect(host.view({ repo: SANDBOX, number: 3 }).checks.map((c) => c.conclusion)).toEqual(["success"]);
});

test("a repository switched off is still listed: its pull request is not reviewed, its /lookover review is recorded as a skip, and the other is reviewed", async () => {
  const host = new TwoRepos(new DemoClock({ at: T0 }));
  const { service, time } = await start({
    ...both,
    host,
    time: host.time,
    engines: fakeEngines({ reviews: 1 }),
  });
  const cookie = await openApp(service);
  const off = { type: "repo.setEnabled", repoId: LEDGER_ID, enabled: false };
  expect((await post(service, cookie, off)).status).toBe(200);
  expect((await snapshot(service, cookie)).repos).toMatchObject([
    { id: SANDBOX_ID, enabled: true },
    { id: LEDGER_ID, enabled: false },
  ]);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

  host.open(opened(LEDGER, 7));
  host.open(opened(SANDBOX, 3));
  await time.advance(MIN);
  await until(stream, "round.finished");
  const ledgerSeven = changeId("ledger-api#7");
  // Listed and shown, never reviewed: the switch decides only whether it is reviewed.
  expect((await snapshot(service, cookie)).changes[ledgerSeven]).toMatchObject({ repoId: LEDGER_ID });
  expect((await snapshot(service, cookie)).reviews[ledgerSeven]).toMatchObject({ job: null });

  host.seedComment({ repo: LEDGER, number: 7 }, { author: OWNER, body: "/lookover review" });
  await time.advance(MIN);
  await time.advance(0);
  expect((await snapshot(service, cookie)).reviews[ledgerSeven]?.job).toMatchObject({
    trigger: "comment",
    state: "skipped",
    skip: "repo-off",
  });
  expect(host.view({ repo: LEDGER, number: 7 }).checks.map((c) => c.conclusion)).toEqual(["skipped"]);
  const sandboxThree = changeId("lookover-sandbox#3");
  expect((await snapshot(service, cookie)).reviews[sandboxThree]?.rounds).toHaveLength(1);
});

test("a rate limit met on one repository stops the listing of both until GitHub's reset, then both are listed again", async () => {
  const host = new TwoRepos(new DemoClock({ at: T0 }));
  const logged: string[] = [];
  const log = (line: string) => logged.push(line);
  const { service, time } = await start({ ...both, host, time: host.time, log });
  const cookie = await openApp(service);
  const resetAt = time.now() + 6 * MIN;
  const limit = new HostError("rate_limited", "API rate limit exceeded", { retryAt: resetAt });
  host.refusing = { repo: SANDBOX, error: limit };
  await time.advance(MIN);
  expect((await snapshot(service, cookie)).connection.limitUntil).toBe(resetAt);
  expect(logged).toEqual(["the pull requests could not be listed: API rate limit exceeded"]);
  const sandbox = host.listed(SANDBOX);
  const ledger = host.listed(LEDGER);

  // Nothing is asked of GitHub before the reset, of either repository.
  host.refusing = null;
  await time.advance(5 * MIN - 1);
  expect([host.listed(SANDBOX), host.listed(LEDGER)]).toEqual([sandbox, ledger]);
  await time.advance(1);
  expect([host.listed(SANDBOX), host.listed(LEDGER)]).toEqual([sandbox + 1, ledger + 1]);
  expect((await snapshot(service, cookie)).connection.limitUntil).toBeNull();
});

test("each repository is polled at its own cadence: the one with a review asked every 10 s, the quiet one every minute", async () => {
  const host = new TwoRepos(new DemoClock({ at: T0 }), [opened(SANDBOX, 3)]);
  const engines = fakeEngines({ signedIn: false });
  const { service, time } = await start({ ...both, host, time: host.time, engines });
  const cookie = await openApp(service);
  // Claude is signed out: the review asked waits, and keeps the sandbox hot.
  const review = { type: "review.request", changeId: changeId("lookover-sandbox#3") };
  expect((await post(service, cookie, review)).status).toBe(200);
  await time.advance(MIN);
  const sandbox = host.listed(SANDBOX);
  const ledger = host.listed(LEDGER);
  await time.advance(2 * MIN);
  expect(host.listed(SANDBOX) - sandbox).toBe(12);
  expect(host.listed(LEDGER) - ledger).toBe(2);
});

test("the setup's choice, the switch and the settings work for either repository, and the first review may be of either", async () => {
  const host = new TwoRepos(new DemoClock({ at: T0 }), [opened(SANDBOX, 3), opened(LEDGER, 7)]);
  const { service, time } = await start({
    ...both,
    host,
    time: host.time,
    engines: fakeEngines({ reviews: 1 }),
  });
  const cookie = await openApp(service);

  const choose = { type: "setup.chooseRepos", enabled: [LEDGER_ID] };
  expect((await post(service, cookie, choose)).status).toBe(200);
  const chosen = (await snapshot(service, cookie)).repos.map((r: Repository) => r.enabled);
  expect(chosen).toEqual([false, true]);
  const on = { type: "repo.setEnabled", repoId: SANDBOX_ID, enabled: true };
  expect((await post(service, cookie, on)).status).toBe(200);
  const elsewhere = { type: "repo.setEnabled", repoId: "sasensi/elsewhere", enabled: true };
  expect((await post(service, cookie, elsewhere)).status).toBe(404);

  // Each repository's own values: in its own file, sent for it alone.
  const deep = { type: "repo.setSetting", repoId: LEDGER_ID, key: "depth", value: "deep" };
  expect((await post(service, cookie, deep)).status).toBe(200);
  const depths = (await snapshot(service, cookie)).repos.map((r: Repository) => r.settings.depth.value);
  expect(depths).toEqual(["standard", "deep"]);
  // The owner's default applies to both, as one writer reads every file again.
  const strict = { type: "settings.set", key: "strictness", value: "blocking" };
  expect((await post(service, cookie, strict)).status).toBe(200);
  const strictness = (await snapshot(service, cookie)).repos.map(
    (r: Repository) => r.settings.strictness.value,
  );
  expect(strictness).toEqual(["blocking", "blocking"]);

  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  const ledgerSeven = changeId("ledger-api#7");
  const first = { type: "setup.firstReview", changeId: ledgerSeven, preview: true };
  expect((await post(service, cookie, first)).status).toBe(200);
  await until(stream, "round.finished");
  await time.advance(0);
  expect((await snapshot(service, cookie)).setup.firstReviewChange).toBe(ledgerSeven);
  // A preview posts nothing.
  expect(host.posts.filter((p) => p.kind === "review")).toEqual([]);
});

test("one repository's listing refused at every poll, GitHub down for it or not finding it, leaves the other listed and reviewed", async () => {
  const host = new TwoRepos(new DemoClock({ at: T0 }));
  const logged: string[] = [];
  const log = (line: string) => logged.push(line);
  const engines = fakeEngines({ reviews: 2 });
  const { service, time } = await start({ ...both, host, time: host.time, engines, log });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

  // The first repository polled answers 502 every time: the one after it is asked all the same.
  host.refusing = { repo: SANDBOX, error: new HostError("unavailable", "Server Error (502)") };
  host.open(opened(LEDGER, 7));
  const ledger = host.listed(LEDGER);
  await time.advance(MIN);
  await until(stream, "round.finished");
  expect(host.listed(LEDGER)).toBeGreaterThan(ledger);
  expect((await snapshot(service, cookie)).reviews[changeId("ledger-api#7")]?.rounds).toHaveLength(1);

  // Not found, for it alone (the installation leaving it out): the other is still listed, and reviewed.
  host.refusing = { repo: SANDBOX, error: new HostError("not_found", "Not Found (404)") };
  host.open(opened(LEDGER, 8));
  await time.advance(MIN);
  await until(stream, "round.finished");
  expect((await snapshot(service, cookie)).reviews[changeId("ledger-api#8")]?.rounds).toHaveLength(1);
  expect(logged).toContain("the pull requests could not be listed: Not Found (404)");
});

test("a repository answering 502 at every poll, polled after one that answers, never shows the connection down: the other's reviews run", async () => {
  const host = new TwoRepos(new DemoClock({ at: T0 }));
  const engines = fakeEngines({ reviews: 2 });
  const { service, time } = await start({ ...both, host, time: host.time, engines, log: () => {} });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

  // The last repository polled answers 502 every time, after the sandbox answered.
  host.refusing = { repo: LEDGER, error: new HostError("unavailable", "Server Error (502)") };
  host.open(opened(SANDBOX, 3));
  await time.advance(MIN);
  const ran = await until(stream, "round.finished");
  host.open(opened(SANDBOX, 4));
  await time.advance(MIN);
  const again = await until(stream, "round.finished");
  expect([...ran, ...again].filter((e) => e.type === "connection.changed")).toEqual([]);
  const state = await snapshot(service, cookie);
  expect(state.connection).toMatchObject({ state: "connected", cause: null });
  for (const n of [3, 4]) expect(state.reviews[changeId(`lookover-sandbox#${n}`)]?.rounds).toHaveLength(1);

  // Every repository refused: GitHub is unreachable. One answering again: back.
  host.refuse("unavailable");
  await time.advance(MIN);
  expect((await snapshot(service, cookie)).connection).toMatchObject({
    state: "disconnected",
    cause: { kind: "unreachable" },
  });
  host.refuse(null);
  await time.advance(MIN);
  expect((await snapshot(service, cookie)).connection).toMatchObject({ state: "connected", cause: null });
});

test("the service starts when its first listings are refused, logging them: one repository's, every one's (unreachable), or the key's (refused, the others not asked)", async () => {
  const notFound = new TwoRepos(new DemoClock({ at: T0 }), [opened(LEDGER, 7)]);
  notFound.refusing = { repo: SANDBOX, error: new HostError("not_found", "Not Found (404)") };
  const logged: string[] = [];
  const log = (line: string) => logged.push(line);
  const { service } = await start({ ...both, host: notFound, time: notFound.time, log });
  const cookie = await openApp(service);
  expect(Object.keys((await snapshot(service, cookie)).changes)).toEqual(["ledger-api#7"]);
  expect(logged).toEqual([
    "ledger-api#7 opened by sasensi: Pull request 7 of ledger-api",
    "the pull requests could not be listed: Not Found (404)",
  ]);

  // Every repository's listing refused 502 (the App's own reads answering): up, GitHub unreachable.
  const downBoth = new TwoRepos(new DemoClock({ at: T0 }));
  downBoth.everyListing = new HostError("unavailable", "Server Error (502)");
  const upDown = await start({ ...both, host: downBoth, time: downBoth.time, log });
  const downCookie = await openApp(upDown.service);
  expect((await snapshot(upDown.service, downCookie)).connection).toMatchObject({
    state: "disconnected",
    cause: { kind: "unreachable" },
  });

  // The key refused is the installation's: the repositories after it are not asked, and the start says why.
  const keyRefused = new TwoRepos(new DemoClock({ at: T0 }));
  keyRefused.refusing = { repo: SANDBOX, error: new HostError("unauthorized", "Bad credentials (401)") };
  const upRefused = await start({ ...both, host: keyRefused, time: keyRefused.time, log });
  const refusedCookie = await openApp(upRefused.service);
  expect((await snapshot(upRefused.service, refusedCookie)).connection).toMatchObject({
    state: "disconnected",
    cause: { kind: "key-refused", why: null },
  });
  expect(keyRefused.listed(LEDGER)).toBe(0);
});

test("Review now lists only its change's repository", async () => {
  const host = new TwoRepos(new DemoClock({ at: T0 }), [opened(SANDBOX, 3), opened(LEDGER, 7)]);
  const engines = fakeEngines({ reviews: 1 });
  const { service } = await start({ ...both, host, time: host.time, engines });
  const cookie = await openApp(service);
  const [sandbox, ledger] = [host.listed(SANDBOX), host.listed(LEDGER)];
  const now = { type: "review.request", changeId: changeId("ledger-api#7") };
  expect((await post(service, cookie, now)).status).toBe(200);
  expect([host.listed(SANDBOX), host.listed(LEDGER)]).toEqual([sandbox, ledger + 1]);
});

test("a rule of the second repository switched off is written to its file alone; each round sends its repository's counts", async () => {
  const dir = home();
  const store = openStore({ home: dir, durable: false });
  const cents = {
    id: "r-1",
    file: "REVIEW.md" as const,
    line: 1,
    text: "Amounts are in cents",
    parentIds: [],
  };
  store.rules.read(LEDGER_ID, [cents]);
  store.close();
  const changes = [opened(SANDBOX, 3), opened(SANDBOX, 4), opened(LEDGER, 7)];
  const host = new TwoRepos(new DemoClock({ at: T0 }), changes);
  const engines = fakeEngines({ reviews: 3 });
  const { service } = await start({ ...both, home: dir, host, time: host.time, engines });
  const cookie = await openApp(service);

  const off = { type: "rule.setEnabled", ruleId: "r-1", enabled: false };
  expect((await post(service, cookie, off)).status).toBe(200);
  expect(readFileSync(join(dir, LEDGER_SETTINGS), "utf8")).toContain("text: Amounts are in cents");
  expect(existsSync(join(dir, SANDBOX_SETTINGS))).toBe(false);

  // Two changes of the sandbox reviewed, then one of ledger-api: each round counts its own repository's reviews.
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  const counted: unknown[] = [];
  for (const id of ["lookover-sandbox#3", "lookover-sandbox#4", "ledger-api#7"]) {
    expect((await post(service, cookie, { type: "review.request", changeId: id })).status).toBe(200);
    const finished = (await until(stream, "round.finished")).at(-1);
    if (finished?.type !== "round.finished") throw new Error("no round finished");
    counted.push([finished.noise?.repoId, finished.noise?.counts.reviews]);
  }
  expect(counted).toEqual([
    [SANDBOX_ID, 1],
    [SANDBOX_ID, 2],
    [LEDGER_ID, 1],
  ]);
});
