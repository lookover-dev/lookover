// The first-run setup and the repository's switch on the service (ADR 0047), through the door the app uses, on the
// demo driver and its clock: the steps and the furthest reached, kept by the store; "Create it on GitHub" followed
// through GitHub's fake pages (the App made and kept, installed there, found by the next check, the repository
// listed, the step moved on only if the owner is still on it); "choose repositories"; the switch; and in live mode,
// a fresh data folder set up at its first start and "Create it on GitHub" refused while an App is kept.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { changeId, commitSha, DEMO_API, repositoryId, type Setup } from "@lookover/contracts";
import { openStore } from "@lookover/store";
import {
  advance,
  installApp,
  load,
  logOf,
  makeApp,
  send,
  snapshotOf,
  startScenario,
  stopAll as stopScenarios,
} from "./demo/demo.test-support.ts";
import { buildDemoRoom, type DemoRoom, type Scenario } from "./index.ts";
import {
  BOT,
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
const MINE = changeId("lookover-sandbox#1");

/** The owner on the GitHub step: their AI is ready, no bot exists yet. */
const ON_GITHUB: Setup = {
  done: false,
  step: "github",
  reached: "github",
  github: "start",
  githubRefused: null,
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
      repo: { owner: "sasensi", name: "lookover-sandbox" },
      bot: { id: 2, login: "lookover-spike-sasensi[bot]" },
      owner: OWNER,
      engines: {
        claude: { installed: true, version: "2.4.1", signedIn: true },
        codex: { installed: true, version: "0.162.1", signedIn: true },
      },
      main: { ref: "main", sha: commitSha("5a1e9c0d7b2f4e6a8c0d1e2f3a4b5c6d7e8f9a0b") },
      setup,
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
    script: [{ at: 1 * MIN, move: { kind: "open", change: 1 } }],
    seed: 2 * MIN,
  };
}

test("a new owner's start: the setup as the scenario left it, no bot, no connection, nothing listed", async () => {
  const door = await startScenario(newOwner(ON_GITHUB));
  const state = await snapshotOf(door);
  expect(state.setup).toEqual(ON_GITHUB);
  expect(state.connection).toMatchObject({ id: null, state: "not-connected", bot: null });
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
    { type: "service.changed", patch: { startsAtLogin: true } },
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
    { type: "service.changed", patch: { startsAtLogin: true } },
  ]);
  const state = await snapshotOf(door);
  expect(state.setup).toMatchObject({ done: true, step: "agent" });
  expect(state.service.agent.skills.every((s) => s.state === "none")).toBe(true);
});

/** "Create it on GitHub" followed to the end: the App made on GitHub's (fake) pages and installed on all repositories. */
async function madeAndInstalled(door: Door): Promise<void> {
  expect((await send(door, { type: "connection.createApp", organisation: null })).status).toBe(200);
  await installApp(door, await makeApp(door));
}

test("GitHub's fake pages carry the API's policy and nosniff, their referrer policy same-origin", async () => {
  const door = await startScenario(newOwner(ON_GITHUB));
  const installPage = await makeApp(door);
  const page = await fetch(new URL(installPage, door.service.origin), { headers: { cookie: door.cookie } });
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toContain("form-action 'self'");
  expect(page.headers.get("x-content-type-options")).toBe("nosniff");
  expect(page.headers.get("referrer-policy")).toBe("same-origin");
});

test("Create it on GitHub: waiting for the App, made on GitHub's page and kept, installed there, found 4 s on, the repository listed; the step stays until Continue", async () => {
  const door = await startScenario(newOwner(ON_GITHUB));
  const from = (await snapshotOf(door)).seq;
  expect((await send(door, { type: "connection.createApp", organisation: null })).status).toBe(200);
  expect((await snapshotOf(door)).setup).toMatchObject({ github: "waiting-for-app" });
  // Nothing more happens by itself: GitHub's page makes the App.
  await advance(door, MIN);
  expect((await snapshotOf(door)).setup).toMatchObject({ github: "waiting-for-app" });

  const installPage = await makeApp(door);
  const made = await snapshotOf(door);
  const slug = made.connection.app?.slug ?? "";
  expect(made.setup).toMatchObject({ github: "waiting-for-install", step: "github" });
  expect(made.connection).toMatchObject({ state: "not-connected", bot: `${slug}[bot]` });

  expect(await installApp(door, installPage)).toContain("Lookover is installed");
  await advance(door, 4_000);
  const installed = await snapshotOf(door);
  expect(installed.connection).toMatchObject({
    state: "connected",
    bot: `${slug}[bot]`,
    id: `github:${slug}[bot]`,
  });
  expect(installed.repos.map((r) => [r.id, r.enabled])).toEqual([[REPO, true]]);
  // What was open before is listed, not reviewed.
  expect(installed.changes[MINE]).toMatchObject({ number: 1, author: "you" });
  expect(installed.reviews[MINE]?.job ?? null).toBeNull();
  // Setup waits for the owner (ADR 0058): the step stays on GitHub, the way forward open.
  expect(installed.setup).toMatchObject({
    github: "done",
    step: "github",
    reached: "repos",
  });

  // In this order, each once (the clock's events are the advances'): waiting for the App, the App kept, the install
  // waited for, the install listed, and only then connected.
  const sent = logOf(door).filter((e) => e.seq > from && e.type !== "clock");
  expect(sent.map((e) => e.type)).toEqual([
    "setup.changed",
    "connection.changed",
    "setup.changed",
    "repo.added",
    "change.opened",
    "connection.changed",
    "setup.changed",
  ]);
});

test("a listing refused once the App is installed is checked again a few seconds later, and connects with no command", async () => {
  const scenario = newOwner(ON_GITHUB);
  // GitHub can't be reached for 7 s from just after the load: the install's next check, 4 s on, is refused.
  const down = {
    at: scenario.seed + 1_000,
    move: { kind: "refuse", failure: "unavailable", forMs: 7_000 },
  } as const;
  const door = await startScenario({ ...scenario, script: [...scenario.script, down] });
  await madeAndInstalled(door);
  await advance(door, 4_000);
  const refused = await snapshotOf(door);
  expect(refused.connection).toMatchObject({ state: "not-connected" });
  expect(refused.setup).toMatchObject({ github: "waiting-for-install", step: "github" });
  expect(refused.repos).toEqual([]);
  // The screen says it checks every few seconds, and the button is gone: the service checks again by itself.
  expect((await send(door, { type: "connection.createApp", organisation: null })).status).toBe(409);

  await advance(door, 8_000);
  const state = await snapshotOf(door);
  expect(state.connection).toMatchObject({ state: "connected" });
  expect(state.setup).toMatchObject({ github: "done", step: "github", reached: "repos" });
  expect(state.repos.map((r) => r.id)).toEqual([REPO]);
});

test("a listing GitHub keeps refusing is logged once, and once when it answers; the room's stop ends the checks", async () => {
  const scenario = newOwner(ON_GITHUB);
  // GitHub can't be reached for a minute from just after the load: the install's checks refused meanwhile.
  const down = {
    at: scenario.seed + 1_000,
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
  await madeAndInstalled(door);
  await advance(door, 7_000 + 5 * 4_000);
  expect(listings()).toEqual(["the pull requests could not be listed: The host could not be reached"]);
  await advance(door, MIN);
  expect(listings()).toEqual([
    "the pull requests could not be listed: The host could not be reached",
    "the pull requests are listed again",
  ]);
  expect((await snapshotOf(door)).connection.state).toBe("connected");

  // Refused again on a room loaded afresh, then the room stops (swapped out): nothing it armed is left to fire.
  expect((await send(door, { type: "connection.createApp", organisation: null })).status).toBe(409);
  expect((await load(door, own.id)).status).toBe(200);
  const second = rooms[1];
  if (second === undefined) throw new Error("The load built a room");
  await madeAndInstalled(door);
  await advance(door, 7_000);
  // Its check refused: another is armed a few seconds on.
  expect(listings()).toHaveLength(3);
  expect((await snapshotOf(door)).setup).toMatchObject({ github: "waiting-for-install" });
  expect(await load(door, own.id)).toMatchObject({ status: 200 });
  expect(second.listing().clock.nextIn).toBeNull();
});

test("the step stays where the owner went while GitHub installed the App; the furthest reached moves on", async () => {
  const door = await startScenario(newOwner(ON_GITHUB));
  expect((await send(door, { type: "connection.createApp", organisation: null })).status).toBe(200);
  expect((await send(door, { type: "setup.goto", step: "ai" })).status).toBe(200);
  await installApp(door, await makeApp(door));
  await advance(door, 4_000);
  const state = await snapshotOf(door);
  expect(state.connection.state).toBe("connected");
  expect(state.setup).toMatchObject({ step: "ai", reached: "repos", github: "done" });
  // Asked again once made: refused, the App kept already.
  const again = await send(door, { type: "connection.createApp", organisation: null });
  expect(again.status).toBe(409);
  expect(await again.json()).toMatchObject({ createApp: { kind: "already-made" } });
});

test("a world left waiting goes on from where it stood: the App made from the page, or the install checked with no command", async () => {
  // Waiting for the App: asked again, it waits again, and GitHub's page makes it.
  const waiting = await startScenario(newOwner({ ...ON_GITHUB, github: "waiting-for-app" }));
  await madeAndInstalled(waiting);
  await advance(waiting, 4_000);
  expect((await snapshotOf(waiting)).connection.state).toBe("connected");
  await stopScenarios();
  // Waiting for the install of an App made already: the install is checked every few seconds from the start.
  const made = await startScenario(newOwner({ ...ON_GITHUB, github: "waiting-for-install" }));
  expect((await send(made, { type: "connection.createApp", organisation: null })).status).toBe(409);
  await installApp(made, `${DEMO_API.github}/apps/lookover-spike-sasensi/installations/new`);
  await advance(made, 4_000);
  const state = await snapshotOf(made);
  expect(state.connection).toMatchObject({ state: "connected", bot: BOT.login });
  expect(state.setup).toMatchObject({ github: "done", step: "github", reached: "repos" });
});

test("the first review, as a preview, on the repository chosen: kept by the setup, nothing posted", async () => {
  const door = await startScenario(newOwner(ON_GITHUB));
  await madeAndInstalled(door);
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
  await madeAndInstalled(door);
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
  expect(state.connection).toMatchObject({ state: "connected", bot: BOT.login });
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

test("in live mode with an App kept, Create it on GitHub is refused: Lookover keeps one App", async () => {
  const { service } = await start({ live: true });
  const cookie = await openApp(service);
  const refused = await post(service, cookie, { type: "connection.createApp", organisation: null });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({
    error: "Lookover already keeps an App.",
    createApp: { kind: "already-made" },
  });
});
