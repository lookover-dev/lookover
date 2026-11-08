// Review requests (ADR 0021, ADR 0043), through the service's entry, on fakes only: the owner, or the owner's coding
// agent, writes `/lookover review` on a pull request, and the poll turns it into a review with nobody clicking. 👀
// when the request is recorded, 🚀 when the round it led to is posted. Only the owner's new conversation comments
// on open pull requests count, each once, across a restart too.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  changeId,
  commitSha,
  HostError,
  type Reaction,
  type RepositoryRef,
  reviewRequest,
  STATUS_MARKER,
} from "@lookover/contracts";
import { DemoClock, FakeGitHost, type HostPost } from "@lookover/testkit";
import {
  api,
  fakeEngines,
  heldRuns,
  home,
  lastEvent,
  messages,
  OTHER_BOT,
  OWNER,
  openApp,
  PLANTED,
  post,
  pr1,
  pr2,
  refusingEnds,
  roundWritten,
  SANDBOX,
  SHA1,
  SHA1_PUSHED,
  SHARED_BOT,
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

const MIN = 60_000;
const OCTOCAT = { id: 583231, login: "octocat" };
const ref = (number: number) => ({ repo: SANDBOX, number });
const DRAFT = changeId("sasensi/lookover-sandbox#2");

/** A post as a short line: a reaction with its comment, a check with its state. */
function line(p: HostPost): string {
  switch (p.kind) {
    case "reaction":
      return `${p.reaction} ${p.commentId}`;
    case "check.created":
    case "check.updated":
      return `check ${p.status}`;
    case "check.completed":
      return `check ${p.conclusion}`;
    case "review":
      return "review";
    case "status.written":
      // The job's block as it waits or runs (ADR 0074), or a round's.
      return roundWritten(p) ? "status" : "status of the job";
    case "reply":
    case "minimized":
      return p.kind;
  }
}

/** What the host was asked, in order. */
const asked = (posts: HostPost[]): string[] => posts.map(line);

const reactions = (posts: HostPost[]) => asked(posts).filter((p) => /^(eyes|rocket) /.test(p));

/**
 * The rounds posted, one status block write each. The rounds here find nothing, so they post no review
 * (ADR 0074): the block is what says a round posted.
 */
const postedRounds = (posts: HostPost[]) => posts.filter(roundWritten);

test("the owner's /lookover review gets 👀, a queued check, a round, then 🚀, with nobody clicking", async () => {
  const { service, host, time } = await start({ changes: [pr1], engines: fakeEngines({ reviews: 1 }) });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  await time.advance(5_000);

  const comment = host.seedComment(ref(1), { author: OWNER, body: "/lookover review" });
  await time.advance(MIN);
  const events = await until(stream, "round.finished");
  expect(events.find((e) => e.type === "job.changed")).toMatchObject({
    changeId: PLANTED,
    job: { trigger: "comment", state: "queued", sha: SHA1 },
  });
  await time.advance(0);
  expect(asked(host.posts)).toEqual([
    `eyes ${comment}`,
    "check queued",
    "check in_progress",
    "status of the job",
    "status",
    "check success",
    "minimized",
    `rocket ${comment}`,
  ]);
  expect(host.view(ref(1)).comments.find((c) => c.id === comment)?.reactions).toEqual({ eyes: 1, rocket: 1 });
});

test("the command from another account, from the App, on an issue or a closed pull request, quoting a marker, or edited in, does nothing", async () => {
  const { service, host, time } = await start({ engines: fakeEngines({ reviews: 1 }) });
  const cookie = await openApp(service);
  await time.advance(5_000);
  const thanks = host.seedComment(ref(1), { author: OWNER, body: "Thanks, looks good" });
  await time.advance(MIN);

  host.editComment(thanks, "/lookover review");
  host.seedComment(ref(1), { author: OCTOCAT, body: "/lookover review" });
  host.seedComment(ref(1), { author: OTHER_BOT, body: "/lookover review" });
  host.seedIssueComment(7, { author: OWNER, body: "/lookover review" });
  // A post of Lookover's that quotes the command holds Lookover's own marker.
  host.seedComment(ref(1), { author: OWNER, body: `/lookover review\n${STATUS_MARKER}` });
  host.seedComment(ref(2), { author: OWNER, body: "/lookover review" });
  host.close(ref(2));
  await time.advance(5 * MIN);

  expect(host.posts).toEqual([]);
  expect((await snapshot(service, cookie)).reviews[PLANTED]).toMatchObject({ job: null });
});

test("the owner's request on a draft, and on another author's pull request, is reviewed (ADR 0016, ADR 0026)", async () => {
  const mine = { ...pr1, number: 3, title: "Draft", url: pr1.url.replace(/\/1$/, "/3"), draft: true };
  const { service, host, time } = await start({
    // #2 is octocat's draft.
    changes: [pr1, pr2, { ...mine, head: { ref: "draft", sha: SHA1_PUSHED } }],
    engines: fakeEngines({ reviews: 2 }),
  });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  await time.advance(5_000);
  host.seedComment(ref(2), { author: OWNER, body: "/lookover review" });
  host.seedComment(ref(3), { author: OWNER, body: "/LOOKOVER Review " });
  await time.advance(MIN);
  const rounds = [...(await until(stream, "round.finished")), ...(await until(stream, "round.finished"))]
    .filter((e) => e.type === "round.finished")
    .map((e) => ("changeId" in e ? e.changeId : ""));
  expect(rounds).toEqual([DRAFT, changeId("sasensi/lookover-sandbox#3")]);
  await time.advance(0);
  expect(reactions(host.posts)).toEqual(["eyes 1", "eyes 2", "rocket 1", "rocket 2"]);
});

test("two requests while a review waits make one job; a request during the run makes one follow-up", async () => {
  const engines = fakeEngines({ signedIn: false, reviews: 2 });
  const held = heldRuns(engines);
  const { service, host, time } = await start({ changes: [pr1], engines: held.engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  await time.advance(5_000);

  // Claude is signed out: the first request waits, and the second joins it.
  const first = host.seedComment(ref(1), { author: OWNER, body: "/lookover review" });
  const second = host.seedComment(ref(1), { author: OWNER, body: "/lookover review" });
  await time.advance(MIN);
  await time.advance(0);
  expect(reactions(host.posts)).toEqual([`eyes ${first}`, `eyes ${second}`]);
  const waiting = (await until(stream, "job.changed")).filter((e) => e.type === "job.changed");
  expect([...new Set(waiting.map((e) => (e.type === "job.changed" ? String(e.job.id) : "")))]).toEqual([
    "id-1",
  ]);

  // Signed in: it runs; two requests during the run make one follow-up, on the newest commit.
  engines.setHealth("claude", { installed: true, version: "2.4.1", signedIn: true });
  await time.advance(MIN);
  await until(stream, "run.started");
  host.push(ref(1), SHA1_PUSHED, []);
  const third = host.seedComment(ref(1), { author: OWNER, body: "/lookover review" });
  const fourth = host.seedComment(ref(1), { author: OWNER, body: reviewRequest(SHA1_PUSHED) });
  await time.advance(10_000);
  await time.advance(0);
  expect(reactions(host.posts).slice(2)).toEqual([`eyes ${third}`, `eyes ${fourth}`]);

  held.release();
  const events = [...(await until(stream, "round.finished")), ...(await until(stream, "round.finished"))];
  const ran = events.flatMap((e) => (e.type === "run.started" ? [`${e.job.id} ${e.job.sha}`] : []));
  // One follow-up (`id-2` is the first run's id).
  expect(ran).toEqual([`id-3 ${SHA1_PUSHED}`]);
  await time.advance(0);
  // Each request's 🚀 when the round its job led to is posted: the first two by round 1, the others by round 2.
  expect(reactions(host.posts).slice(4)).toEqual([
    `rocket ${first}`,
    `rocket ${second}`,
    `rocket ${third}`,
    `rocket ${fourth}`,
  ]);
  expect(host.posts.filter((p) => p.kind === "review")).toEqual([]);
  expect(postedRounds(host.posts)).toHaveLength(2);
});

test("a colleague's draft marked ready while the owner's request waits records no skip beside it", async () => {
  const engines = fakeEngines({ signedIn: false, reviews: 1 });
  // #2 is octocat's draft.
  const { service, host, time } = await start({ changes: [pr1, pr2], engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  await time.advance(5_000);
  const checks = () => host.view(ref(2)).checks.map((c) => `${c.status} ${c.conclusion}: ${c.output.title}`);

  // Claude is signed out: the owner's request waits; the draft marked ready skips nothing beside it.
  host.seedComment(ref(2), { author: OWNER, body: "/lookover review" });
  await time.advance(MIN);
  host.markReady(ref(2));
  await time.advance(MIN);
  await time.advance(0);
  expect((await snapshot(service, cookie)).reviews[DRAFT]).toMatchObject({
    job: { id: "id-1", trigger: "comment", state: "deferred" },
  });
  expect(checks().filter((c) => c.includes("skipped"))).toEqual([]);

  // Signed in, the owner's job runs and is the review shown.
  engines.setHealth("claude", { installed: true, version: "2.4.1", signedIn: true });
  await time.advance(MIN);
  await until(stream, "round.finished");
  await time.advance(0);
  expect((await snapshot(service, cookie)).reviews[DRAFT]).toMatchObject({
    job: { id: "id-1", state: "done" },
  });
  expect(checks().filter((c) => c.includes("skipped"))).toEqual([]);
});

test("a colleague's draft marked ready while the owner's request runs records no skip beside it", async () => {
  const held = heldRuns(fakeEngines({ reviews: 1 }));
  // #2 is octocat's draft.
  const { service, host, time } = await start({ changes: [pr1, pr2], engines: held.engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  await time.advance(5_000);

  host.seedComment(ref(2), { author: OWNER, body: "/lookover review" });
  await time.advance(MIN);
  await until(stream, "run.started");
  host.markReady(ref(2));
  await time.advance(10_000);
  await time.advance(0);
  held.release();
  await until(stream, "round.finished");
  await time.advance(0);
  // After the run, the change shows the owner's job, not a skip recorded during it.
  expect((await snapshot(service, cookie)).reviews[DRAFT]).toMatchObject({
    job: { id: "id-1", state: "done" },
  });
  expect(host.view(ref(2)).checks.map((c) => c.conclusion)).toEqual(["success"]);
});

test("a request whose round was posted gets its 🚀, though the round's end could not be recorded", async () => {
  const dir = home();
  const { host, time } = await start({
    home: dir,
    store: refusingEnds(dir, "round", 2),
    changes: [pr1],
    engines: fakeEngines({ reviews: 1 }),
    log: () => {},
  });
  await time.advance(5_000);
  const comment = host.seedComment(ref(1), { author: OWNER, body: "/lookover review" });
  await time.advance(MIN);
  await time.advance(0);
  // Its status block and its completed check are on GitHub (no review: no line comment): the request was answered.
  expect(host.posts.filter((p) => p.kind === "review")).toEqual([]);
  expect(postedRounds(host.posts)).toHaveLength(1);
  expect(reactions(host.posts)).toEqual([`eyes ${comment}`, `rocket ${comment}`]);
});

/** A fake GitHub that refuses the next `refusals` reactions, as a bad moment would. */
class RefusingReactions extends FakeGitHost {
  refusals = 0;
  override react(repo: RepositoryRef, commentId: string, reaction: Reaction): Promise<void> {
    if (this.refusals <= 0) return super.react(repo, commentId, reaction);
    this.refusals--;
    return Promise.reject(new HostError("unavailable", "The host could not be reached"));
  }
}

test("a reaction GitHub refused is sent again, a request's 👀 before its 🚀, each once", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new RefusingReactions({
    repo: SANDBOX,
    bot: SHARED_BOT,
    person: OWNER,
    changes: [pr1],
    clock: time,
  });
  const logged: string[] = [];
  await start({ host, time, engines: fakeEngines({ reviews: 1 }), log: (l) => logged.push(l) });
  await time.advance(5_000);
  const comment = host.seedComment(ref(1), { author: OWNER, body: "/lookover review" });
  host.refusals = 1;
  await time.advance(MIN);
  await time.advance(MIN);
  expect(reactions(host.posts)).toEqual([`eyes ${comment}`, `rocket ${comment}`]);
  expect(logged.filter((l) => l.includes("reaction"))).toEqual([
    `the eyes reaction on comment ${comment} was not sent: The host could not be reached`,
  ]);
});

/**
 * A fake GitHub whose next comments listing gives every comment twice, as GitHub's pages do when a comment is edited
 * between two page reads: the listing is by "last edited, newest first", so the rest move down a place.
 */
class PagedTwice extends FakeGitHost {
  twice = false;
  override async listComments(repo: RepositoryRef, since: number) {
    const listing = await super.listComments(repo, since);
    if (!this.twice) return listing;
    this.twice = false;
    return { ...listing, items: [...listing.items, ...listing.items] };
  }
}

test("a request GitHub lists twice in one poll is answered once, in that poll", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new PagedTwice({ repo: SANDBOX, bot: SHARED_BOT, person: OWNER, changes: [pr1], clock: time });
  const logged: string[] = [];
  await start({ host, time, engines: fakeEngines({ reviews: 1 }), log: (l) => logged.push(l) });
  await time.advance(5_000);
  const comment = host.seedComment(ref(1), { author: OWNER, body: "/lookover review" });
  host.twice = true;
  await time.advance(MIN);
  await time.advance(0);
  expect(reactions(host.posts)).toEqual([`eyes ${comment}`, `rocket ${comment}`]);
  expect(host.posts.filter((p) => p.kind === "review")).toEqual([]);
  expect(postedRounds(host.posts)).toHaveLength(1);
  // Nothing went wrong: the log says the one review, and nothing else (ADR 0055).
  expect(logged).toEqual([
    "sasensi/lookover-sandbox#1 opened by sasensi: Add unpaid filter and rewrite total",
    "sasensi/lookover-sandbox#1 review queued (asked on GitHub) for a1b2c3d",
    "sasensi/lookover-sandbox#1 round 1 started on a1b2c3d, standard: Claude finds, Claude double-checks",
    "sasensi/lookover-sandbox#1 round 1 posted: no open findings",
  ]);
});

/** A fake GitHub that does `between` once, after it answers a listing of the open changes. */
class Between extends FakeGitHost {
  between: (() => void) | null = null;
  override async listOpenChanges(repo: RepositoryRef) {
    const listing = await super.listOpenChanges(repo);
    const now = this.between;
    this.between = null;
    now?.();
    return listing;
  }
}

test("a request on a pull request opened after the poll listed them is answered by the next poll", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new Between({ repo: SANDBOX, bot: SHARED_BOT, person: OWNER, changes: [pr1], clock: time });
  await start({ host, time, engines: fakeEngines({ reviews: 1 }) });
  await time.advance(5_000);
  // A colleague's pull request, which only a request gets reviewed, opened and asked for between the poll's two
  // listings: the changes listed don't have it yet, the comments do.
  const colleagues = { ...pr2, number: 3, draft: false, url: pr2.url.replace(/\/2$/, "/3") };
  let comment = "";
  host.between = () => {
    host.open(colleagues);
    comment = host.seedComment(ref(3), { author: OWNER, body: "/lookover review" });
  };
  await time.advance(MIN);
  await time.advance(MIN);
  await time.advance(0);
  expect(reactions(host.posts)).toEqual([`eyes ${comment}`, `rocket ${comment}`]);
  expect(host.view(ref(3)).checks.map((c) => c.conclusion)).toContain("success");
});

test("a request on a closed pull request is no request when it is reopened later", async () => {
  // A colleague's pull request: reopened, it asks for no review by itself.
  const colleagues = { ...pr2, number: 3, draft: false, url: pr2.url.replace(/\/2$/, "/3") };
  const { host, time } = await start({ changes: [pr1, colleagues], engines: fakeEngines({ reviews: 1 }) });
  await time.advance(5_000);
  host.close(ref(3));
  await time.advance(MIN);
  host.seedComment(ref(3), { author: OWNER, body: "/lookover review" });
  await time.advance(5 * MIN);
  host.reopen(ref(3));
  await time.advance(5 * MIN);
  expect(reactions(host.posts)).toEqual([]);
  expect(host.posts.filter((p) => p.kind === "review")).toEqual([]);
});

test("requests written before Lookover first ran are not requests, edited into one later neither", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({
    repo: SANDBOX,
    bot: SHARED_BOT,
    person: OWNER,
    changes: [pr1],
    clock: time,
  });
  host.seedComment(ref(1), { author: OWNER, body: "/lookover review" });
  const old = host.seedComment(ref(1), { author: OWNER, body: "Will ask later" });
  await time.advance(5_000);
  const { service } = await start({ host, time, engines: fakeEngines({ reviews: 1 }) });
  const cookie = await openApp(service);
  await time.advance(MIN);
  // Edited after the start: listed again (its update is new), still written before Lookover watched.
  host.editComment(old, "/lookover review");
  await time.advance(5 * MIN);
  expect(host.posts).toEqual([]);
  expect((await snapshot(service, cookie)).reviews[PLANTED]).toMatchObject({ job: null });
});

/** A fake GitHub whose clock is `skew` ms ahead of this machine's (behind when negative). */
function skewedHost(time: DemoClock, skew: number): FakeGitHost {
  return new FakeGitHost({
    repo: SANDBOX,
    bot: SHARED_BOT,
    person: OWNER,
    changes: [pr1],
    clock: { now: () => time.now() + skew },
  });
}

test("where the requests start is GitHub's time, not this machine's: with GitHub's clock ahead, nothing written before the first start is a request", async () => {
  const time = new DemoClock({ at: T0 });
  const host = skewedHost(time, 5 * MIN);
  // Two minutes before the first start, by GitHub's clock: later than this machine's "now".
  host.seedComment(ref(1), { author: OWNER, body: "/lookover review" }, time.now() + 3 * MIN);
  const { service } = await start({ host, time, engines: fakeEngines({ reviews: 1 }) });
  const cookie = await openApp(service);
  await time.advance(5 * MIN);
  expect(host.posts).toEqual([]);
  expect((await snapshot(service, cookie)).reviews[PLANTED]).toMatchObject({ job: null });
});

test("where the requests start is GitHub's time, not this machine's: with GitHub's clock behind, a request written after the first start is answered", async () => {
  const time = new DemoClock({ at: T0 });
  const host = skewedHost(time, -5 * MIN);
  await start({ host, time, engines: fakeEngines({ reviews: 1 }) });
  await time.advance(MIN);
  // Written a minute after the first start, by GitHub's clock: earlier than this machine's start.
  const comment = host.seedComment(ref(1), { author: OWNER, body: "/lookover review" });
  await time.advance(MIN);
  await time.advance(0);
  expect(reactions(host.posts)).toEqual([`eyes ${comment}`, `rocket ${comment}`]);
});

test("a request GitHub lists late, behind newer comments, is still answered", async () => {
  const { host, time } = await start({ changes: [pr1], engines: fakeEngines({ reviews: 1 }) });
  await time.advance(2 * MIN);
  const written = time.now();
  await time.advance(20_000);
  host.seedComment(ref(1), { author: OCTOCAT, body: "Nice" });
  await time.advance(MIN);
  // Written before "Nice", listed only now.
  const late = host.seedComment(ref(1), { author: OWNER, body: "/lookover review" }, written);
  await time.advance(MIN);
  await time.advance(0);
  expect(reactions(host.posts)).toEqual([`eyes ${late}`, `rocket ${late}`]);
});

test("a restart runs no handled request again and reacts no twice; one written while stopped is answered", async () => {
  const dir = home();
  const first = await start({ home: dir, changes: [pr1], engines: fakeEngines({ reviews: 1 }) });
  await first.time.advance(5_000);
  const answered = first.host.seedComment(ref(1), { author: OWNER, body: "/lookover review" });
  await first.time.advance(MIN);
  await first.time.advance(0);
  expect(reactions(first.host.posts)).toEqual([`eyes ${answered}`, `rocket ${answered}`]);
  await first.service.stop();
  const last = lastEvent(dir);

  // Written while the service was stopped (a laptop asleep): answered at the next start, once.
  await first.time.advance(10 * MIN);
  const asleep = first.host.seedComment(ref(1), { author: OWNER, body: "/lookover review" });
  await first.time.advance(5_000);
  const { service, host, time } = await start({
    home: dir,
    host: first.host,
    time: first.time,
    idsFrom: 100,
    engines: fakeEngines({ reviews: 1 }),
  });
  const cookie = await openApp(service);
  const events = await until(await sinceStart(service, cookie, last), "round.finished");
  expect(events.filter((e) => e.type === "job.changed").at(0)).toMatchObject({ job: { trigger: "comment" } });
  await time.advance(10 * MIN);
  expect(reactions(host.posts)).toEqual([
    `eyes ${answered}`,
    `rocket ${answered}`,
    `eyes ${asleep}`,
    `rocket ${asleep}`,
  ]);
  expect(host.posts.filter((p) => p.kind === "review")).toEqual([]);
  expect(postedRounds(host.posts)).toHaveLength(2);
});

test("a request whose run a restart cut, behind a follow-up, is answered by the follow-up's round", async () => {
  const dir = home();
  const engines = fakeEngines({ reviews: 1 });
  const held = heldRuns(engines);
  const first = await start({ home: dir, changes: [pr1], engines: held.engines });
  const cookie = await openApp(first.service);
  const stream = messages(await fetch(api(first.service, "/events"), { headers: { cookie } }));
  await first.time.advance(5_000);
  const cut = first.host.seedComment(ref(1), { author: OWNER, body: "/lookover review" });
  await first.time.advance(MIN);
  await until(stream, "run.started");
  first.host.push(ref(1), SHA1_PUSHED, []);
  const behind = first.host.seedComment(ref(1), { author: OWNER, body: "/lookover review" });
  await first.time.advance(10_000);
  await first.service.stop();

  // The cut run would run again, but the follow-up on the newest commit takes its place and answers both.
  const { host, time } = await start({
    home: dir,
    host: first.host,
    time: first.time,
    idsFrom: 100,
    engines: fakeEngines({ reviews: 1 }),
  });
  await time.advance(MIN);
  // One round posted, on the newest commit: its check there is the one that succeeded.
  expect(postedRounds(host.posts)).toHaveLength(1);
  expect(host.view(ref(1), SHA1_PUSHED).checks.map((c) => [c.status, c.conclusion])).toEqual([
    ["completed", "success"],
  ]);
  expect(reactions(host.posts)).toEqual([
    `eyes ${cut}`,
    `eyes ${behind}`,
    `rocket ${cut}`,
    `rocket ${behind}`,
  ]);
});

// ---- who asked, who pushed (ADR 0081) ----

test("the agent's request says the agent asked, a person's that you asked on GitHub, in the event and the log", async () => {
  const { service, host, time, logged } = await start({
    changes: [pr1, pr2],
    engines: fakeEngines({ reviews: 2 }),
  });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  await time.advance(5_000);
  host.seedComment(ref(1), { author: OWNER, body: reviewRequest(SHA1) });
  host.seedComment(ref(2), { author: OWNER, body: "/lookover review" });
  await time.advance(MIN);
  const events = await until(stream, "job.changed");
  expect(events.find((e) => e.type === "job.changed")).toMatchObject({
    changeId: PLANTED,
    job: { trigger: "comment", askedBy: "agent" },
  });
  await time.advance(0);
  expect(logged.filter((l) => l.includes("queued"))).toEqual([
    "sasensi/lookover-sandbox#1 review queued (asked by the agent on GitHub) for a1b2c3d",
    "sasensi/lookover-sandbox#2 review queued (asked on GitHub) for b2c3d4e",
  ]);
  const { reviews } = await snapshot(service, cookie);
  expect(reviews[PLANTED].timeline).toContainEqual(
    expect.objectContaining({ kind: "queued", trigger: "comment", by: "agent" }),
  );
  expect(reviews[DRAFT].timeline).toContainEqual(
    expect.objectContaining({ kind: "queued", trigger: "comment", by: "person" }),
  );
});

test("a request joining the review waiting since the pull request opened says who asked, once", async () => {
  const { service, host, time, logged } = await start({
    changes: [],
    engines: fakeEngines({ signedIn: false }),
  });
  const cookie = await openApp(service);
  await time.advance(5_000);
  host.open(pr1);
  await time.advance(MIN);
  host.seedComment(ref(1), { author: OWNER, body: reviewRequest(SHA1) });
  host.seedComment(ref(1), { author: OWNER, body: "/lookover review" });
  await time.advance(MIN);
  await time.advance(0);
  const lines = logged.filter((l) => l.startsWith("sasensi/lookover-sandbox#1 review"));
  expect(lines[0]).toBe("sasensi/lookover-sandbox#1 review queued (on opening) for a1b2c3d");
  // The agent's request joined it; the person's after it names no one new.
  expect(lines.filter((l) => l.includes("asked"))).toEqual([
    "sasensi/lookover-sandbox#1 review asked for by the agent on GitHub, back in the queue",
  ]);
  const { reviews } = await snapshot(service, cookie);
  const timeline: { kind: string }[] = reviews[PLANTED].timeline;
  expect(timeline.filter((t) => t.kind === "queued" || t.kind === "asked")).toEqual([
    expect.objectContaining({ kind: "queued", trigger: "opened", by: null }),
    expect.objectContaining({ kind: "asked", by: "agent" }),
  ]);
});

test("a follow-up no request asked for, taking the place of the agent's cut run, says the agent asked, in the app", async () => {
  const dir = home();
  const held = heldRuns(fakeEngines());
  const first = await start({ home: dir, changes: [pr1], engines: held.engines });
  const cookie = await openApp(first.service);
  const stream = messages(await fetch(api(first.service, "/events"), { headers: { cookie } }));
  await first.time.advance(5_000);
  first.host.seedComment(ref(1), { author: OWNER, body: reviewRequest(SHA1) });
  await first.time.advance(MIN);
  await until(stream, "run.started");
  // A push during the run, and "Review now" on it: a follow-up nobody asked for by a comment.
  first.host.push(ref(1), SHA1_PUSHED, []);
  await first.time.advance(MIN);
  expect((await post(first.service, cookie, { type: "review.request", changeId: PLANTED })).status).toBe(200);
  await first.service.stop();

  // The cut run would run again: the follow-up takes its place, with the agent's request and who asked.
  const { service, time } = await start({
    home: dir,
    host: first.host,
    time: first.time,
    idsFrom: 100,
    engines: heldRuns(fakeEngines()).engines,
  });
  await time.advance(5_000);
  const { reviews } = await snapshot(service, await openApp(service));
  // The store handed who asked over in the run's end: the UI heard of it, as the change's follow-up shown after it.
  expect(reviews[PLANTED].job).toMatchObject({ sha: SHA1_PUSHED, askedBy: "agent" });
  const timeline: { kind: string }[] = reviews[PLANTED].timeline;
  expect(timeline.filter((t) => t.kind === "queued").at(-1)).toMatchObject({
    trigger: "manual",
    by: "agent",
  });
});

/** Who `change.pushed` named, and how many commits it counted, for the push the poll saw. */
async function pushedBy(stream: Awaited<ReturnType<typeof messages>>) {
  const events = await until(stream, "change.pushed");
  return events.flatMap((e) => (e.type === "change.pushed" ? [[e.commits, e.by]] : []))[0];
}

test("a push is the agent's only when an agent signed every commit GitHub listed; any other names no one", async () => {
  const { service, host, time, logged } = await start({ changes: [pr1], engines: fakeEngines() });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  await time.advance(5_000);
  const signed = "Fix the total\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>";
  const pushes: [string, { commits: number; messages: string[] }][] = [
    ["c3d4e5f60718293a4b5c6d7e8f9012345678a1b2", { commits: 2, messages: [signed, signed] }],
    // A person's commit among them.
    ["d4e5f60718293a4b5c6d7e8f9012345678a1b2c3", { commits: 2, messages: [signed, "Bump the version"] }],
    // GitHub listed only some of them: the rest are not known.
    ["e5f60718293a4b5c6d7e8f9012345678a1b2c3d4", { commits: 3, messages: [signed, signed] }],
  ];
  const by: unknown[] = [];
  for (const [sha, how] of pushes) {
    host.push(ref(1), commitSha(sha), [], [], how);
    await time.advance(MIN);
    by.push(await pushedBy(stream));
  }
  // A compare GitHub refused: no count, no one.
  host.refuseCounts("unavailable");
  host.push(ref(1), commitSha("f60718293a4b5c6d7e8f9012345678a1b2c3d4e5"), []);
  await time.advance(MIN);
  by.push(await pushedBy(stream));
  expect(by).toEqual([
    [2, "agent"],
    [2, null],
    [3, null],
    [0, null],
  ]);
  expect(logged.filter((l) => l.includes(" now at "))).toEqual([
    "sasensi/lookover-sandbox#1 the agent pushed 2 commits, now at c3d4e5f",
    "sasensi/lookover-sandbox#1 2 new commits, now at d4e5f60",
    "sasensi/lookover-sandbox#1 3 new commits, now at e5f6071",
    "sasensi/lookover-sandbox#1 new commits, now at f607182",
  ]);
  expect(logged.join("\n")).not.toContain("by you");
});
