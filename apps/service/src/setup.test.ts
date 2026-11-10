// The first-run setup and the repository's switch on the service (ADR 0047), through the door the app uses, on the
// demo driver and its clock: the steps and the furthest reached, kept by the store; "Sign in with GitHub" followed
// through GitHub's fake pages (the code entered, the shared App installed there, found by the next check, the
// repository listed, the step moved on only if the owner is still on it); "choose repositories"; the switch; and in
// live mode, a fresh data folder set up at its first start.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  changeId,
  commitSha,
  DEMO_API,
  githubLinks,
  repositoryId,
  type Setup,
  SHARED_APP,
  type State,
} from "@lookover/contracts";
import { openStore } from "@lookover/store";
import {
  advance,
  inject,
  installApp,
  load,
  logOf,
  send,
  snapshotOf,
  startScenario,
  stopAll as stopScenarios,
} from "./demo/demo.test-support.ts";
import { buildDemoRoom, type DemoRoom, type Scenario } from "./index.ts";
import {
  eventually,
  home,
  openApp,
  post,
  SANDBOX,
  snapshot,
  start,
  stopAll,
  TEST_LIMIT_MS,
} from "./service.test-support.ts";

type Door = Awaited<ReturnType<typeof startScenario>>;

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(async () => {
  await stopScenarios();
  await stopAll();
});

const MIN = 60_000;
const OWNER = { id: 1, login: "sasensi" };
const REPO = repositoryId("sasensi/lookover-sandbox");
const MINE = changeId("sasensi/lookover-sandbox#1");

/** The owner on the GitHub step: their AI is ready, nobody signed in yet. */
const ON_GITHUB: Setup = {
  done: false,
  step: "github",
  reached: "github",
  github: "start",
  firstReviewChange: null,
};

/** A new owner on the step `setup` says, the owner's #1 opened on GitHub before Lookover could see it. */
function newOwner(setup: Setup): Scenario {
  return {
    id: "T117",
    title: "A new owner",
    what: "The first run: the AI, GitHub, the repositories.",
    steps: [],
    later: "",
    path: "/setup",
    world: {
      repo: SANDBOX,
      bot: { id: 2020, login: "lookover-dev[bot]" },
      owner: OWNER,
      engines: {
        claude: { installed: true, version: "2.4.1", signedIn: true },
        codex: { installed: true, version: "0.162.1", signedIn: true },
      },
      main: { ref: "main", sha: commitSha("5a1e9c0d7b2f4e6a8c0d1e2f3a4b5c6d7e8f9a0b") },
      setup,
      // Nobody signed in before the GitHub step, the shared App not installed on the owner's account yet.
      shared: { ownAccountInstalled: false, reaches: [] },
    },
    changes: [
      {
        number: 1,
        title: "Add b",
        branch: "add-b",
        author: OWNER,
        commits: [
          {
            sha: commitSha("b1f2a3c4d5e6f708192a3b4c5d6e7f8091a2b3c4"),
            message: "Add b",
            diff: [
              "diff --git a/src/a.ts b/src/a.ts",
              "--- a/src/a.ts",
              "+++ b/src/a.ts",
              "@@ -1,1 +1,2 @@",
              " export const a = 1;",
              "+export const b = 2;",
              "",
            ].join("\n"),
            find: { findings: [], emptyReason: "One constant added." },
          },
        ],
      },
    ],
    script: [{ at: 1 * MIN, move: { kind: "open", change: { repo: SANDBOX, number: 1 } } }],
    seed: 2 * MIN,
  };
}

test("a new owner's start: the setup as the scenario left it, no bot, no connection, nothing listed", async () => {
  const door = await startScenario(newOwner(ON_GITHUB));
  const state = await snapshotOf(door);
  expect(state.setup).toEqual(ON_GITHUB);
  expect(state.connection).toMatchObject({ id: null, state: "not-connected" });
  expect(state.repos).toEqual([]);
  expect(state.changes).toEqual({});
});

test("each step is kept, going back keeps the furthest reached, and finishing says done", async () => {
  const door = await startScenario(newOwner({ ...ON_GITHUB, step: "ai", reached: "ai" }));
  const from = (await snapshotOf(door)).seq;
  expect((await send(door, { type: "setup.goto", step: "github" })).status).toBe(200);
  expect((await snapshotOf(door)).setup).toMatchObject({ step: "github", reached: "github" });
  expect((await send(door, { type: "setup.goto", step: "ai" })).status).toBe(200);
  expect((await snapshotOf(door)).setup).toMatchObject({ step: "ai", reached: "github", done: false });
  // Leaving the AI step sets nothing else: the reviewers stay Lookover's default.
  expect((await snapshotOf(door)).settings.reviewers).toMatchObject({
    value: "both",
    origin: "lookover-default",
  });
  expect((await send(door, { type: "setup.finish" })).status).toBe(200);
  // One `setup.changed` per command, each the whole setup as it then was; and, done, start at login registered as
  // the owner chose (on by default, ADR 0054); nothing else.
  const whole = { ...ON_GITHUB, step: "ai", reached: "ai" };
  expect(logOf(door).filter((e) => e.seq > from)).toMatchObject([
    { type: "setup.changed", setup: { ...whole, step: "github", reached: "github" } },
    { type: "setup.changed", setup: { ...whole, step: "ai", reached: "github" } },
    { type: "setup.changed", setup: { ...whole, step: "ai", reached: "github", done: true } },
    { type: "service.changed", patch: { atLogin: "this" } },
  ]);
  expect(logOf(door).filter((e) => e.seq > from)).toHaveLength(4);
  const state = await snapshotOf(door);
  expect(state.setup).toMatchObject({ done: true, step: "ai", reached: "github" });
});

test("after the first review the owner goes to Your coding agent, and finishes from there with nothing done on it", async () => {
  const door = await startScenario(newOwner({ ...ON_GITHUB, step: "first-review", reached: "first-review" }));
  expect((await send(door, { type: "setup.goto", step: "agent" })).status).toBe(200);
  expect((await snapshotOf(door)).setup).toMatchObject({ step: "agent", reached: "agent", done: false });
  // Back to the first review keeps the way forward; the steps before it still open.
  expect((await send(door, { type: "setup.goto", step: "first-review" })).status).toBe(200);
  expect((await snapshotOf(door)).setup).toMatchObject({ step: "first-review", reached: "agent" });
  expect((await send(door, { type: "setup.goto", step: "agent" })).status).toBe(200);

  const from = (await snapshotOf(door)).seq;
  expect((await send(door, { type: "setup.finish" })).status).toBe(200);
  expect(logOf(door).filter((e) => e.seq > from)).toMatchObject([
    { type: "setup.changed", setup: { step: "agent", reached: "agent", done: true } },
    { type: "service.changed", patch: { atLogin: "this" } },
  ]);
  const state = await snapshotOf(door);
  expect(state.setup).toMatchObject({ done: true, step: "agent" });
  expect(state.service.agent.skills.every((s) => s.state === "none")).toBe(true);
});

/** The shared App's install page on GitHub's fake (ADR 0066): where the owner installs it on their account. */
const INSTALL_PAGE = githubLinks.install(DEMO_API.github, SHARED_APP.slug);

/**
 * "Sign in with GitHub" followed: the code asked for, entered on GitHub's (fake) device page, the next poll taking it;
 * the setup as it is once the sign-in is kept (on disk: a moment after the poll).
 */
async function signedIn(door: Door): Promise<State> {
  expect((await send(door, { type: "connection.signIn" })).status).toBe(200);
  expect(await inject(door, "sign-in-entered")).toBe(200);
  await advance(door, 5_000);
  return eventually(
    () => snapshotOf(door),
    (s) => s.setup.github !== "start",
  );
}

/** Signed in, then the shared App installed on all the owner's repositories from its install page. */
async function signedInAndInstalled(door: Door): Promise<void> {
  await signedIn(door);
  await installApp(door, INSTALL_PAGE);
}

test("GitHub's fake pages carry the API's policy and nosniff, their referrer policy same-origin", async () => {
  const door = await startScenario(newOwner(ON_GITHUB));
  const page = await fetch(new URL(INSTALL_PAGE, door.service.origin), { headers: { cookie: door.cookie } });
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toContain("form-action 'self'");
  expect(page.headers.get("x-content-type-options")).toBe("nosniff");
  expect(page.headers.get("referrer-policy")).toBe("same-origin");
});

test("Sign in with GitHub: the code shown, entered on GitHub, the install waited for, found 4 s on, the repository listed; the step stays until Continue", async () => {
  const door = await startScenario(newOwner(ON_GITHUB));
  const from = (await snapshotOf(door)).seq;
  expect((await send(door, { type: "connection.signIn" })).status).toBe(200);
  expect((await snapshotOf(door)).connection.signIn).toMatchObject({ userCode: "D054-61DC" });
  // Nothing more happens by itself: the code waits to be entered.
  await advance(door, MIN);
  expect((await snapshotOf(door)).setup).toMatchObject({ github: "start" });

  expect(await inject(door, "sign-in-entered")).toBe(200);
  await advance(door, 5_000);
  const signedInState = await eventually(
    () => snapshotOf(door),
    (s) => s.setup.github !== "start",
  );
  expect(signedInState.setup).toMatchObject({ github: "waiting-for-install", step: "github" });
  expect(signedInState.connection).toMatchObject({ state: "not-connected", signIn: null, person: OWNER });

  await installApp(door, INSTALL_PAGE);
  await advance(door, 4_000);
  const installed = await snapshotOf(door);
  expect(installed.connection).toMatchObject({ state: "connected", id: `github:${OWNER.login}` });
  expect(installed.repos.map((r) => [r.id, r.enabled])).toEqual([[REPO, true]]);
  // What was open before is listed, not reviewed.
  expect(installed.changes[MINE]).toMatchObject({ number: 1, author: "you" });
  expect(installed.reviews[MINE]?.job ?? null).toBeNull();
  // Setup waits for the owner (ADR 0058): the step stays on GitHub, the way forward open.
  expect(installed.setup).toMatchObject({ github: "done", step: "github", reached: "repos" });

  // In this order, each once (the clock's events are the advances'): the code shown, the person signed in, the
  // install waited for, the code gone, the first check listing no installation, the install's accounts sent before
  // its repository's first poll (ADR 0086), the repository listed, and only then connected and the step done.
  const sent = logOf(door).filter((e) => e.seq > from && e.type !== "clock");
  expect(sent.map((e) => e.type)).toEqual([
    "connection.changed",
    "connection.changed",
    "setup.changed",
    "connection.changed",
    "connection.changed",
    "connection.changed",
    "repo.added",
    "change.opened",
    "connection.changed",
    "setup.changed",
  ]);
  expect(sent[1]).toMatchObject({ patch: { person: OWNER, listed: false } });
  expect(sent[4]).toMatchObject({ patch: { listed: true } });
  expect(sent[5]).toMatchObject({ patch: { accounts: [{ account: { login: OWNER.login } }] } });
  expect(sent[8]).toMatchObject({ patch: { state: "connected" } });
  expect(sent[9]).toMatchObject({ setup: { github: "done" } });
});

test("a listing refused once the App is installed is checked again a few seconds later, and connects with no command", async () => {
  const scenario = newOwner(ON_GITHUB);
  // GitHub can't be reached for 7 s from just after the load: the install's next check, 4 s on, is refused.
  const down = {
    at: scenario.seed + 7_000,
    move: { kind: "refuse", failure: "unavailable", forMs: 7_000 },
  } as const;
  const door = await startScenario({ ...scenario, script: [...scenario.script, down] });
  await signedInAndInstalled(door);
  await advance(door, 4_000);
  const refused = await snapshotOf(door);
  expect(refused.connection).toMatchObject({ state: "not-connected" });
  expect(refused.setup).toMatchObject({ github: "waiting-for-install", step: "github" });
  expect(refused.repos).toEqual([]);

  await advance(door, 8_000);
  const state = await snapshotOf(door);
  expect(state.connection).toMatchObject({ state: "connected" });
  expect(state.setup).toMatchObject({ github: "done", step: "github", reached: "repos" });
  expect(state.repos.map((r) => r.id)).toEqual([REPO]);
});

test("a listing GitHub keeps refusing is logged once, and once when it answers; the room's stop ends the checks", async () => {
  const scenario = newOwner(ON_GITHUB);
  // GitHub can't be reached for a minute from once the owner signed in: the install's checks refused meanwhile.
  const down = {
    at: scenario.seed + 7_000,
    move: { kind: "refuse", failure: "unavailable", forMs: MIN },
  } as const;
  const own = { ...scenario, script: [...scenario.script, down] };
  const rooms: DemoRoom[] = [];
  const door = await startScenario(own, {
    scenarios: [own],
    driver: async (o) => {
      const room = await buildDemoRoom(o);
      rooms.push(room);
      return room;
    },
  });
  const listings = () => door.logged.filter((line) => line.includes("pull requests"));
  await signedInAndInstalled(door);
  await advance(door, 2_000 + 5 * 4_000);
  expect(listings()).toEqual(["the pull requests could not be listed: The host could not be reached"]);
  await advance(door, MIN);
  expect(listings()).toEqual([
    "the pull requests could not be listed: The host could not be reached",
    "the pull requests are listed again",
  ]);
  expect((await snapshotOf(door)).connection.state).toBe("connected");

  // Refused again on a room loaded afresh, then the room stops (swapped out): nothing it armed is left to fire.
  expect((await load(door, own.id)).status).toBe(200);
  const second = rooms[1];
  if (second === undefined) throw new Error("The load built a room");
  await signedInAndInstalled(door);
  await advance(door, 4_000);
  // Its check refused: another is armed a few seconds on.
  expect(listings()).toHaveLength(3);
  expect((await snapshotOf(door)).setup).toMatchObject({ github: "waiting-for-install" });
  expect(await load(door, own.id)).toMatchObject({ status: 200 });
  expect(second.listing().clock.nextIn).toBeNull();
});

test("the step stays where the owner went while GitHub installed the App; the furthest reached moves on", async () => {
  const door = await startScenario(newOwner(ON_GITHUB));
  await signedIn(door);
  expect((await send(door, { type: "setup.goto", step: "ai" })).status).toBe(200);
  await installApp(door, INSTALL_PAGE);
  await advance(door, 4_000);
  const state = await snapshotOf(door);
  expect(state.connection.state).toBe("connected");
  expect(state.setup).toMatchObject({ step: "ai", reached: "repos", github: "done" });
});

test("a world left waiting for the install goes on from where it stood: the install checked with no command", async () => {
  // Signed in, the install of the shared App waited for: checked every few seconds from the start.
  const made = await startScenario(newOwner({ ...ON_GITHUB, github: "waiting-for-install" }));
  await installApp(made, INSTALL_PAGE);
  await advance(made, 4_000);
  const state = await snapshotOf(made);
  expect(state.connection).toMatchObject({ state: "connected", person: OWNER });
  expect(state.setup).toMatchObject({ github: "done", step: "github", reached: "repos" });
});

test("the first review, as a preview, on the repository chosen: kept by the setup, nothing posted", async () => {
  const door = await startScenario(newOwner(ON_GITHUB));
  await signedInAndInstalled(door);
  await advance(door, 4_000);
  await send(door, { type: "setup.chooseRepos", enabled: [REPO] });
  const asked = await send(door, { type: "setup.firstReview", changeId: MINE, preview: true });
  expect(asked.status).toBe(200);
  await advance(door, 60_000);
  const state = await snapshotOf(door);
  expect(state.setup).toMatchObject({ step: "first-review", firstReviewChange: MINE });
  expect(state.reviews[MINE]).toMatchObject({
    preview: true,
    job: { trigger: "first-review", state: "done" },
    rounds: [{ n: 1 }],
  });
  expect(logOf(door).find((e) => e.type === "round.finished")).toMatchObject({ preview: true });
});

test("choosing the repositories sets every switch, then goes to the first review; the switch is kept", async () => {
  const door = await startScenario(newOwner(ON_GITHUB));
  await signedInAndInstalled(door);
  await advance(door, 4_000);

  expect((await send(door, { type: "setup.chooseRepos", enabled: [] })).status).toBe(200);
  const off = await snapshotOf(door);
  expect(off.repos.map((r) => [r.id, r.enabled])).toEqual([[REPO, false]]);
  expect(off.setup).toMatchObject({ step: "first-review", reached: "first-review" });

  expect((await send(door, { type: "setup.chooseRepos", enabled: [REPO] })).status).toBe(200);
  expect((await snapshotOf(door)).repos.map((r) => r.enabled)).toEqual([true]);

  expect((await send(door, { type: "repo.setEnabled", repoId: REPO, enabled: false })).status).toBe(200);
  expect((await snapshotOf(door)).repos.map((r) => r.enabled)).toEqual([false]);
  const unknown = await send(door, { type: "repo.setEnabled", repoId: "sam/app", enabled: false });
  expect(unknown.status).toBe(404);
});

test("in live mode, a fresh data folder is set up at its first start, and a switch turned off stays off after a restart", async () => {
  const dir = home();
  const first = await start({ home: dir, live: true });
  const cookie = await openApp(first.service);
  const state = await snapshot(first.service, cookie);
  expect(state.setup).toMatchObject({ done: true, step: "background", github: "done" });
  expect(state.connection).toMatchObject({ state: "connected" });
  const repo = repositoryId(`${SANDBOX.owner}/${SANDBOX.name}`);
  expect(
    (await post(first.service, cookie, { type: "repo.setEnabled", repoId: repo, enabled: false })).status,
  ).toBe(200);
  await first.service.stop();

  const again = await start({ home: dir, live: true, time: first.time, idsFrom: 100 });
  const after = await snapshot(again.service, await openApp(again.service));
  expect(after.repos.map((r: { enabled: boolean }) => r.enabled)).toEqual([false]);
  expect(after.setup.done).toBe(true);
});

test("in live mode, a data folder whose tables were made but whose setup nobody wrote starts set up", async () => {
  const dir = home();
  // An earlier Lookover made the tables (every migration ran) and never wrote the setup.
  openStore({ home: dir, durable: false }).close();
  const { service } = await start({ home: dir, live: true });
  const state = await snapshot(service, await openApp(service));
  expect(state.setup).toMatchObject({ done: true, step: "background", github: "done" });
  expect(state.connection.state).toBe("connected");
});

test("a setup kept in the data folder is what the next start shows, never written over", async () => {
  const dir = home();
  const kept = openStore({ home: dir, durable: false });
  const onRepos = kept.setup.write({ step: "repos", github: "done" });
  kept.close();
  const { service } = await start({ home: dir, live: true });
  const state = await snapshot(service, await openApp(service));
  expect(state.setup).toEqual(onRepos);
  expect(state.setup.done).toBe(false);
});
