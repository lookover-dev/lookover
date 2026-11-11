// The coding agent's request waits for the choice of repositories (ADR 0090, #577): while setup shows Repositories,
// the `/lookover review` `lookover wait` writes (its marker naming the commit) asks nothing, so nothing reaches
// GitHub (no job, no check, no reaction); it is kept, across a restart, and answered once the person chooses (Continue
// on Repositories, or a step past it) if its repository stays on and its pull request open, else dropped without a
// word. Making the choice again drops it. Through the service's door, on the fakes and the held clock.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { changeId, reviewRequest, type SignIn } from "@lookover/contracts";
import { DemoClock, FakeGitHost } from "@lookover/testkit";
import { type GitHubSide, type Keychain, memoryKeychain, signInStore } from "./index.ts";
import {
  api,
  eventually,
  fakeEngines,
  home,
  lastEvent,
  messages,
  OWNER,
  openApp,
  post,
  pr1,
  SANDBOX,
  SHARED_BOT,
  setupOn,
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
const SANDBOX_ID = `${SANDBOX.owner}/${SANDBOX.name}`;
const PR1 = { repo: SANDBOX, number: 1 };
const PR1_ID = changeId(`${SANDBOX_ID}#1`);

/** Setup at Repositories on `dir`, the owner's pull request #1 open. */
async function atRepositories(dir = home()) {
  const started = await start({
    home: dir,
    changes: [pr1],
    setup: setupOn("repos"),
    engines: fakeEngines({ reviews: 1 }),
  });
  const cookie = await openApp(started.service);
  return { ...started, dir, cookie };
}

/** The coding agent's request for #1's head, as `lookover wait` writes it, seen by a poll. */
async function agentAsks(host: FakeGitHost, time: DemoClock): Promise<string> {
  const comment = host.seedComment(PR1, { author: OWNER, body: reviewRequest(pr1.head.sha) });
  await time.advance(MIN);
  await time.advance(MIN);
  return comment;
}

test("the agent's request before the choice asks nothing; Continue with its repository on answers it: a job, 👀 and a check", async () => {
  const { service, host, time, cookie } = await atRepositories();
  const comment = await agentAsks(host, time);
  expect((await snapshot(service, cookie)).reviews[PR1_ID]?.job ?? null).toBeNull();
  expect(host.posts).toEqual([]);

  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await post(service, cookie, { type: "setup.chooseRepos", enabled: [SANDBOX_ID] })).status).toBe(
    200,
  );
  expect((await until(stream, "job.changed")).find((e) => e.type === "job.changed")).toMatchObject({
    changeId: PR1_ID,
    job: { trigger: "comment", askedBy: "agent", sha: pr1.head.sha },
  });
  await until(stream, "round.finished");
  await time.advance(0);
  expect(host.posts.filter((p) => p.kind === "reaction")).toMatchObject([
    { reaction: "eyes", commentId: comment },
    { reaction: "rocket", commentId: comment },
  ]);
  expect(host.view(PR1).checks).toMatchObject([{ status: "completed", conclusion: "success" }]);
});

test("a step past Repositories answers it too", async () => {
  const { service, host, time, cookie } = await atRepositories();
  const comment = await agentAsks(host, time);
  expect((await post(service, cookie, { type: "setup.goto", step: "first-review" })).status).toBe(200);
  await time.advance(0);
  expect((await snapshot(service, cookie)).reviews[PR1_ID]?.job).toMatchObject({ trigger: "comment" });
  await time.advance(MIN);
  expect(host.posts).toContainEqual({ kind: "reaction", reaction: "eyes", commentId: comment });
});

test("its repository switched off at Continue, or its pull request closed before: nothing at all, ever", async () => {
  for (const what of ["switched off", "closed"] as const) {
    const { service, host, time, cookie } = await atRepositories();
    await agentAsks(host, time);
    if (what === "closed") {
      host.close(PR1);
      await time.advance(MIN);
    }
    const enabled = what === "switched off" ? [] : [SANDBOX_ID];
    expect((await post(service, cookie, { type: "setup.chooseRepos", enabled })).status).toBe(200);
    for (let polls = 0; polls < 3; polls++) await time.advance(MIN);
    const state = await snapshot(service, cookie);
    expect([what, state.reviews[PR1_ID]?.job ?? null]).toEqual([what, null]);
    expect([what, host.posts]).toEqual([what, []]);
  }
});

test("a restart between the request and Continue: still answered after Continue", async () => {
  const first = await atRepositories();
  const comment = await agentAsks(first.host, first.time);
  await first.service.stop();
  const last = lastEvent(first.dir);

  const { service, host, time } = await start({
    home: first.dir,
    host: first.host,
    time: first.time,
    idsFrom: 100,
    engines: fakeEngines(),
  });
  const cookie = await openApp(service);
  await time.advance(MIN);
  expect(host.posts).toEqual([]);
  expect((await post(service, cookie, { type: "setup.chooseRepos", enabled: [SANDBOX_ID] })).status).toBe(
    200,
  );
  const events = await until(await sinceStart(service, cookie, last), "job.changed");
  expect(events.find((e) => e.type === "job.changed")).toMatchObject({
    changeId: PR1_ID,
    job: { trigger: "comment", askedBy: "agent" },
  });
  await time.advance(0);
  await time.advance(MIN);
  expect(host.posts).toContainEqual({ kind: "reaction", reaction: "eyes", commentId: comment });
});

test("a restart set up at once (live mode's sign-in kept): the kept request is answered at start, no Continue", async () => {
  const first = await atRepositories();
  const comment = await agentAsks(first.host, first.time);
  await first.service.stop();
  const last = lastEvent(first.dir);

  const { service, host, time } = await start({
    home: first.dir,
    host: first.host,
    time: first.time,
    idsFrom: 100,
    setUpAtOnce: true,
    engines: fakeEngines({ reviews: 1 }),
  });
  const cookie = await openApp(service);
  const events = await until(await sinceStart(service, cookie, last), "job.changed");
  expect(events.find((e) => e.type === "job.changed")).toMatchObject({
    changeId: PR1_ID,
    job: { trigger: "comment", askedBy: "agent" },
  });
  await time.advance(0);
  await time.advance(MIN);
  expect(host.posts).toContainEqual({ kind: "reaction", reaction: "eyes", commentId: comment });
});

const userOnly = async () => {};

/** The shared App on `host` for a data folder keeping its sign-in store on `keychain`. */
const onShared = (host: FakeGitHost, dir: string, keychain: Keychain): GitHubSide => ({
  shared: {
    signIn: host,
    signIns: signInStore({ home: dir, keychain, userOnly }),
    accounts: () => host,
    connect: () => ({ intake: host, writer: host }),
  },
});

/** The person's sign-in, as GitHub gives it: a token for 8 hours. */
const signInAt = (at: number): SignIn => ({
  token: "ghu_16C7e42F292c6912E7710c838347Ae178B4a",
  expiresAt: at + 8 * 3_600_000,
  refreshToken: "ghr_1B4a2e77838347a7E420ce178F2E7c6912E1",
  refreshExpiresAt: at + 180 * 86_400_000,
  person: { ...OWNER },
});

test("the choice made again (the sign-in gone at a restart) drops the kept request: Continue then answers nothing", async () => {
  const dir = home();
  const keychain = memoryKeychain();
  await signInStore({ home: dir, keychain, userOnly }).write(signInAt(T0));
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({
    repo: SANDBOX,
    bot: SHARED_BOT,
    person: OWNER,
    changes: [pr1],
    clock: time,
  });
  const github = onShared(host, dir, keychain);
  const first = await start({
    home: dir,
    host,
    time,
    github,
    setup: setupOn("repos"),
    engines: fakeEngines(),
  });
  await agentAsks(host, time);
  await first.service.stop();

  rmSync(join(dir, "github", "sign-in.json"));
  const { service } = await start({
    home: dir,
    host,
    time,
    github: onShared(host, dir, memoryKeychain()),
    idsFrom: 100,
    engines: fakeEngines(),
  });
  const cookie = await openApp(service);
  expect((await post(service, cookie, { type: "connection.signIn" })).status).toBe(200);
  host.enterCode("D054-61DC");
  await time.advance(5_000);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.setup.github === "done",
  );
  expect((await post(service, cookie, { type: "setup.chooseRepos", enabled: [SANDBOX_ID] })).status).toBe(
    200,
  );
  for (let polls = 0; polls < 3; polls++) await time.advance(MIN);
  expect((await snapshot(service, cookie)).reviews[PR1_ID]?.job ?? null).toBeNull();
  expect(host.posts).toEqual([]);
});
