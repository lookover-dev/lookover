// Setup's two lists follow the host (ADR 0068, #407): while setup shows Repositories or First review, every watched
// repository is polled at the hot cadence, so a pull request opened then is sent as `change.opened` within one hot
// interval, and one closed as `change.closed`, with no reload. On the shared App signed in on one account, and on two
// accounts, the organisation's repository included. Through the service's door, on the fakes and the held clock.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  type ChangeId,
  changeId,
  commitSha,
  type Event,
  type HostAccount,
  type RepositoryRef,
  type SignIn,
  type State,
} from "@lookover/contracts";
import { DemoClock, type FakeChange, FakeGitHost } from "@lookover/testkit";
import { type GitHubSide, memoryKeychain, type RunningService, signInStore } from "./index.ts";
import {
  api,
  fakeEngines,
  home,
  messages,
  OWNER,
  openApp,
  PLANTED,
  post,
  pr1,
  SANDBOX,
  setupOn,
  snapshot,
  start,
  stopAll,
  T0,
  TEST_LIMIT_MS,
  until,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

/** The hot cadence: a new pull request shows within it. */
const HOT = 10_000;

/** Another pull request of the owner's on `repo`, on commits of its own. */
const another = (repo: RepositoryRef, number: number): FakeChange => ({
  ...pr1,
  repo,
  number,
  title: `Pull request ${number}`,
  url: `https://github.com/${repo.owner}/${repo.name}/pull/${number}`,
  head: { ref: `branch-${number}`, sha: commitSha(`${number}`.padStart(7, "e").padEnd(40, "0")) },
});
const idOf = (repo: RepositoryRef, number: number): ChangeId =>
  changeId(`${repo.owner}/${repo.name}#${number}`);

/** What setup's two lists read: the open changes of each repository, by id. */
const openIn = (state: State, repo: RepositoryRef): string[] =>
  Object.values(state.changes)
    .filter((c) => c.repoId === `${repo.owner}/${repo.name}`)
    .map((c) => String(c.id))
    .sort();

const named = (e: Event) => {
  if (e.type === "change.opened") return `${e.type} ${e.change.id}`;
  return "changeId" in e ? `${e.type} ${e.changeId}` : e.type;
};

/**
 * On Repositories, a pull request opened on `repo` is sent within one hot interval; then on First review, it is sent
 * closed within one more.
 */
async function followsTheHost(
  service: RunningService,
  host: FakeGitHost,
  time: DemoClock,
  repo: RepositoryRef,
) {
  const cookie = await openApp(service);
  const before = await snapshot(service, cookie);
  expect(before.setup).toMatchObject({ done: false, step: "repos" });
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

  host.open(another(repo, 7));
  await time.advance(HOT);
  expect((await until(stream, "change.opened")).map(named)).toEqual([`change.opened ${idOf(repo, 7)}`]);
  expect(openIn(await snapshot(service, cookie), repo)).toEqual(
    [...openIn(before, repo), idOf(repo, 7)].sort(),
  );

  expect((await post(service, cookie, { type: "setup.goto", step: "first-review" })).status).toBe(200);
  await until(stream, "setup.changed");
  host.close({ repo, number: 7 });
  await time.advance(HOT);
  expect((await until(stream, "change.closed")).map(named)).toEqual([`change.closed ${idOf(repo, 7)}`]);
  expect(openIn(await snapshot(service, cookie), repo)).toEqual(openIn(before, repo));
}

test("on the shared App on one account, setup's lists get a pull request opened, then closed, within one hot interval", async () => {
  const { service, host, time } = await start({ changes: [pr1], setup: setupOn("repos") });
  await followsTheHost(service, host, time, SANDBOX);
});

test("once setup is done, a quiet repository is polled every minute again", async () => {
  const { service, host, time } = await start({ changes: [pr1], setup: setupOn("first-review") });
  const cookie = await openApp(service);
  expect((await post(service, cookie, { type: "setup.finish" })).status).toBe(200);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  host.open(another(SANDBOX, 7));
  await time.advance(HOT);
  expect(Object.keys((await snapshot(service, cookie)).changes)).toEqual([PLANTED]);
  await time.advance(60_000 - HOT);
  expect((await until(stream, "change.opened")).map(named)).toEqual([`change.opened ${idOf(SANDBOX, 7)}`]);
});

/** The shared App's bot on the fake: on `shared` it never posts, the person does. */
const SHARED_BOT = { id: 2020, login: "lookover-dev[bot]" };
/** An organisation the person reaches, its sandbox named as the person's own. */
const ORG: HostAccount = { id: 9001, login: "lookover-dev", type: "Organization" };
const ORG_SANDBOX = { owner: ORG.login, name: SANDBOX.name };

/** The person's sign-in, as GitHub gives it: a token for 8 hours. */
const signInAt = (at: number): SignIn => ({
  token: "ghu_16C7e42F292c6912E7710c838347Ae178B4a",
  expiresAt: at + 8 * 3_600_000,
  refreshToken: "ghr_1B4a2e77838347a7E420ce178F2E7c6912E1",
  refreshExpiresAt: at + 180 * 86_400_000,
  person: { ...OWNER },
});

/** A data folder signed in to the shared App, on the fake: its accounts and its ports the fake's. */
async function signedIn(host: FakeGitHost, dir: string): Promise<GitHubSide> {
  const signIns = signInStore({ home: dir, keychain: memoryKeychain(), userOnly: async () => {} });
  await signIns.write(signInAt(T0));
  return {
    shared: {
      signIn: host,
      signIns,
      accounts: () => host,
      connect: () => ({ intake: host, writer: host }),
    },
  };
}

/** Setup on Repositories, signed in to the shared App on the person's account and on the organisation. */
async function onTwoAccounts() {
  const dir = home();
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({
    repo: SANDBOX,
    bot: SHARED_BOT,
    person: OWNER,
    changes: [pr1],
    clock: time,
    reaches: [{ account: ORG, repositories: [ORG_SANDBOX] }],
  });
  const { service } = await start({
    home: dir,
    host,
    time,
    engines: fakeEngines({ time }),
    github: await signedIn(host, dir),
    setup: setupOn("repos"),
  });
  return { service, host, time };
}

test("on the shared App on two accounts, setup's lists get a pull request opened, then closed, on the person's repository", async () => {
  const { service, host, time } = await onTwoAccounts();
  await followsTheHost(service, host, time, SANDBOX);
});

test("on the shared App on two accounts, setup's lists get a pull request opened, then closed, on the organisation's repository", async () => {
  const { service, host, time } = await onTwoAccounts();
  await followsTheHost(service, host, time, ORG_SANDBOX);
});
