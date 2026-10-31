// The developer drawer's faults through the service's door (ADR 0046): each `demo.inject` on S10's quiet day,
// and what the snapshot and the events show of it, on the real service's rules. One that has nothing left to do
// answers 409 with why. The expected values are the story's, written by hand. A fault that opens, pushes or
// closes a pull request is played on the whole day; one that touches only an engine or GitHub's answers, on the
// day's first five minutes (`brief`), the same world in a tenth of the time.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { changeId, DEMO_API, type Event, findingId, repositoryId } from "@lookover/contracts";
import { scenarioOf } from "../index.ts";
import { eventually, TEST_LIMIT_MS } from "../service.test-support.ts";
import {
  advance,
  BRIEF_SEEDED,
  brief,
  inject,
  installApp,
  makeApp,
  onGitHub,
  send,
  snapshotOf,
  startScenario,
  stopAll,
  stream,
  T0,
} from "./demo.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const id = (n: number) => changeId(`sasensi/lookover-sandbox#${n}`);
/** The whole day, for a fault that opens, pushes or closes a pull request. */
const quiet = () => startScenario(scenarioOf("S10"));
/** Its first five minutes, for a fault that touches only an engine or GitHub's answers. */
const morning = () => startScenario(brief());

/** Reads events until an engine shows `state`; the events read. */
async function untilEngine(events: AsyncGenerator<{ event: string | null; data: string }>, state: string) {
  const seen: Event[] = [];
  for (;;) {
    const { value, done } = await events.next();
    if (done) throw new Error("The event stream ended");
    if (value.event !== "event") continue;
    const event: Event = JSON.parse(value.data);
    seen.push(event);
    if (event.type === "engine.changed" && event.patch.state === state) return seen;
  }
}

test("claude-signed-out and codex-signed-out: the engine shows signed out at once", async () => {
  const door = await morning();
  expect(await inject(door, "claude-signed-out")).toBe(200);
  expect((await snapshotOf(door)).engines.claude).toMatchObject({ state: "signed-out", since: T0 });
  expect(await inject(door, "codex-signed-out")).toBe(200);
  const { engines } = await snapshotOf(door);
  expect(engines.codex).toMatchObject({ state: "signed-out", since: T0 });
  expect(engines.claude.state).toBe("signed-out");
});

test("engines-missing: both AIs show missing", async () => {
  const door = await morning();
  expect(await inject(door, "engines-missing")).toBe(200);
  const { engines } = await snapshotOf(door);
  expect(engines.claude).toMatchObject({ state: "missing", version: null });
  expect(engines.codex).toMatchObject({ state: "missing", version: null });
});

test("codex-limit with no run going: the queue is told, Codex shows at its limit until its scripted reset, then ready with no end left", async () => {
  const door = await morning();
  expect(await inject(door, "codex-limit")).toBe(200);
  // The scripted reset: two days on, as a weekly limit would (ADR 0055).
  const reset = T0 + 2 * DAY;
  expect((await snapshotOf(door)).engines.codex).toMatchObject({
    state: "limit",
    since: T0,
    limitUntil: reset,
  });
  // Still held a minute before it, as the health says ready.
  await advance(door, 2 * DAY - MIN);
  expect((await snapshotOf(door)).engines.codex).toMatchObject({ state: "limit", limitUntil: reset });
  // The hold is over: "Check again" believes the health that says ready, and the end once shown goes with it.
  await advance(door, MIN);
  expect((await send(door, { type: "engine.check" })).status).toBe(200);
  expect((await snapshotOf(door)).engines.codex).toMatchObject({ state: "ready", limitUntil: null });
});

test("codex-failed-self-test, then codex-updated: a newer Codex fails Lookover's safety check, the one after passes", async () => {
  const door = await morning();
  const events = await stream(door, BRIEF_SEEDED);
  expect(await inject(door, "codex-failed-self-test")).toBe(200);
  await untilEngine(events, "failed-self-test");
  expect((await snapshotOf(door)).engines.codex).toMatchObject({
    state: "failed-self-test",
    version: "0.163.0",
  });
  expect(await inject(door, "codex-updated")).toBe(200);
  await untilEngine(events, "ready");
  expect((await snapshotOf(door)).engines.codex).toMatchObject({ state: "ready", version: "0.164.0" });
});

test("codex-too-old, then codex-updated: a Codex too old for its model can't be used and says why; updated, it is ready", async () => {
  const door = await morning();
  const events = await stream(door, BRIEF_SEEDED);
  expect(await inject(door, "codex-too-old")).toBe(200);
  await untilEngine(events, "missing");
  expect((await snapshotOf(door)).engines.codex).toMatchObject({
    state: "missing",
    version: "0.161.0",
    detail:
      "gpt-6.1-sol needs Codex 0.162.0 or later; this one is 0.161.0. Update it, then check again: npm install -g @openai/codex@latest",
    unusable: { kind: "too-old", version: "0.161.0", model: "gpt-6.1-sol", needs: "0.162.0" },
  });
  expect(await inject(door, "codex-updated")).toBe(200);
  await untilEngine(events, "ready");
  expect((await snapshotOf(door)).engines.codex).toMatchObject({
    state: "ready",
    version: "0.162.0",
    detail: "",
    unusable: null,
  });
});

test("connection-lost: the host refuses, so the connection shows disconnected and a listing fails; twenty seconds on, it answers again", async () => {
  const door = await morning();
  expect(await inject(door, "connection-lost")).toBe(200);
  expect((await snapshotOf(door)).connection).toMatchObject({ state: "disconnected", since: T0 });
  const refused = await send(door, { type: "refresh" });
  expect(refused.status).toBe(502);
  expect(await refused.json()).toEqual({ error: "unavailable" });
  await advance(door, 20_000);
  expect((await send(door, { type: "refresh" })).status).toBe(200);
  expect((await snapshotOf(door)).connection.state).toBe("connected");
});

test("github-limit: GitHub asks to wait twenty minutes; the connection says until when, and lists again after", async () => {
  const door = await morning();
  expect(await inject(door, "github-limit")).toBe(200);
  expect((await snapshotOf(door)).connection.limitUntil).toBe(T0 + 20 * MIN);
  const refused = await send(door, { type: "refresh" });
  expect(refused.status).toBe(502);
  expect(await refused.json()).toEqual({ error: "rate_limited" });
  await advance(door, 20 * MIN + 10_000);
  expect((await snapshotOf(door)).connection.limitUntil).toBeNull();
  expect((await send(door, { type: "refresh" })).status).toBe(200);
});

test("github-limit at publishing: the round's outbox waits until GitHub's time, says so, then posts (ADR 0055)", async () => {
  const door = await quiet();
  expect(await inject(door, "agent-opens-change")).toBe(200);
  expect(await inject(door, "github-limit")).toBe(200);
  // Codex finds and Claude confirms with GitHub out of the way; the job's check was made as the run started.
  await advance(door, 200_000);
  expect((await snapshotOf(door)).reviews[id(149)]?.run).toMatchObject({
    step: "publishing",
    posting: { sent: 1, owed: 4, wait: { until: T0 + 20 * MIN, refusal: "rate_limited" } },
  });
  await advance(door, 20 * MIN);
  const posted = (await snapshotOf(door)).reviews[id(149)];
  expect(posted?.run).toBeNull();
  expect(posted?.job?.state).toBe("done");
  expect(posted?.rounds.map((r) => r.n)).toEqual([1]);
});

test("github-limit on S2 (the review-posting-wait proof shot's world): four minutes on, #148 posts round 1 and waits on GitHub", async () => {
  // The shot: S2, one minute on, github-limit, then three more minutes before it shoots (scripts/proof-shots.ts).
  const door = await startScenario(scenarioOf("S2"));
  await advance(door, MIN);
  expect(await inject(door, "github-limit")).toBe(200);
  await advance(door, 3 * MIN);
  expect((await snapshotOf(door)).reviews[changeId("sasensi/ledger-api#148")]?.run).toMatchObject({
    step: "publishing",
    posting: { wait: { refusal: "rate_limited" } },
  });
});

test("agent-opens-change: the agent's #149 opens, Codex finds and Claude confirms; nothing left, the fault says so", async () => {
  const door = await quiet();
  expect(await inject(door, "agent-opens-change")).toBe(200);
  const opened = await snapshotOf(door);
  expect(opened.changes[id(149)]).toMatchObject({ author: "you", writtenBy: "claude", openedAt: T0 });
  expect(opened.reviews[id(149)]?.run).toMatchObject({
    reviewer: "codex",
    confirmer: "claude",
    step: "finding",
  });
  await advance(door, 200_000);
  const reviewed = (await snapshotOf(door)).reviews[id(149)];
  expect(reviewed?.rounds.map((r) => [r.n, r.reviewer, r.confirmer, r.raised])).toEqual([
    [1, "codex", "claude", 1],
  ]);
  expect(reviewed?.findings.map((f) => [f.id, f.severity, f.status, f.confirmation.verdict])).toEqual([
    [findingId("F1"), "should_fix", "open", "confirmed"],
  ]);
  const again = await send(door, { type: "demo.inject", fault: "agent-opens-change" });
  expect(again.status).toBe(409);
  expect(await again.json()).toEqual({ error: "no pull request left to open in this scenario" });
});

test("other-opens-change: a colleague's #150 opens and is skipped; nothing left, the fault says so", async () => {
  const door = await quiet();
  expect(await inject(door, "other-opens-change")).toBe(200);
  const state = await snapshotOf(door);
  expect(state.changes[id(150)]).toMatchObject({ author: "other", openedBy: "mira" });
  expect(state.reviews[id(150)]?.job).toMatchObject({ state: "skipped", skip: "not-yours" });
  expect(await inject(door, "other-opens-change")).toBe(409);
});

test("you-push: a commit lands on the reviewed #141, counted and not reviewed with the switch off; nothing left, the fault says so", async () => {
  const door = await quiet();
  expect(await inject(door, "you-push")).toBe(200);
  const state = await snapshotOf(door);
  expect(state.changes[id(141)]).toMatchObject({
    newCommits: 1,
    headSha: "c2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5",
  });
  expect(state.reviews[id(141)]?.job?.state).toBe("done");
  expect(state.reviews[id(141)]?.timeline.at(-1)).toMatchObject({ kind: "pushed", by: "you", commits: 1 });
  const again = await send(door, { type: "demo.inject", fault: "you-push" });
  expect(again.status).toBe(409);
  expect(await again.json()).toEqual({
    error: "no reviewed pull request of yours with a commit left to push",
  });
});

test("close-change: the oldest open pull request closes and leaves the list, its review kept", async () => {
  const door = await quiet();
  expect(await inject(door, "close-change")).toBe(200);
  const state = await snapshotOf(door);
  expect(Object.keys(state.changes).sort()).toEqual([137, 139, 141, 144, 146].map(id));
  expect(state.reviews[id(135)]?.rounds).toHaveLength(1);
  for (let left = 5; left > 0; left--) expect(await inject(door, "close-change")).toBe(200);
  const closed = await send(door, { type: "demo.inject", fault: "close-change" });
  expect(closed.status).toBe(409);
  expect(await closed.json()).toEqual({ error: "no pull request open" });
});

test("settings-unwritable: every settings save is refused, its file held open; no file is written and no event sent", async () => {
  // The morning, its repository with one value of its own, so a reset has a file to change.
  const story = brief();
  const door = await startScenario({
    ...story,
    world: { ...story.world, settings: { repository: [["onPush", true]] } },
  });
  const [room = ""] = readdirSync(join(door.home, "rooms"));
  const folder = join(door.home, "rooms", room);
  const repoText = () => readFileSync(join(folder, "sasensi", "lookover-sandbox", "settings.yaml"), "utf8");
  const planted = repoText();
  const { seq } = await snapshotOf(door);
  const repoId = repositoryId("sasensi/lookover-sandbox");
  expect(await inject(door, "settings-unwritable")).toBe(200);
  const saves = [
    { type: "settings.set", key: "depth", value: "deep" },
    { type: "repo.setSetting", repoId, key: "strictness", value: "blocking" },
    { type: "repo.resetSetting", repoId, key: "onPush" },
  ];
  const held = (file: string) => ({
    error: `${file} was not written`,
    unwritten: { file, why: "held-open" },
  });
  const answers = [];
  for (const save of saves) {
    const res = await send(door, save);
    answers.push({ status: res.status, body: await res.json() });
  }
  const repoFile = "sasensi/lookover-sandbox/settings.yaml";
  expect(answers).toEqual([
    { status: 500, body: held("settings.yaml") },
    { status: 500, body: held(repoFile) },
    { status: 500, body: held(repoFile) },
  ]);
  expect(existsSync(join(folder, "settings.yaml"))).toBe(false);
  expect(repoText()).toBe(planted);
  expect((await snapshotOf(door)).seq).toBe(seq);
});

/** The App's page and its installation's on GitHub's fake pages, as the connection names them. */
async function pagesOf(door: Awaited<ReturnType<typeof morning>>) {
  const { connection } = await snapshotOf(door);
  return {
    app: `/settings/apps/${connection.app?.slug}`,
    installation: `/settings/installations/${connection.accounts[0]?.installationId}`,
    install: `/apps/${connection.app?.slug}/installations/new`,
  };
}

/** "Add a new key": one generated on the App's page, then given under "Use an existing App". The status it answered. */
async function newKey(door: Awaited<ReturnType<typeof morning>>): Promise<number> {
  const { app } = await pagesOf(door);
  const key = await onGitHub(door, app, [["action", "generate-key"]]);
  const appId = (await snapshotOf(door)).connection.app?.id ?? 0;
  return (await send(door, { type: "connection.useApp", appId, key })).status;
}

test("app-uninstalled: the connection shows the App uninstalled; installed again on GitHub, it comes back on its new installation", async () => {
  const door = await morning();
  const was = (await snapshotOf(door)).connection.accounts[0]?.installationId;
  const { install } = await pagesOf(door);
  expect(await inject(door, "app-uninstalled")).toBe(200);
  expect((await snapshotOf(door)).connection).toMatchObject({
    state: "disconnected",
    cause: { kind: "uninstalled", suspended: false },
  });
  await installApp(door, `${DEMO_API.github}${install}`);
  await advance(door, MIN);
  const back = (await snapshotOf(door)).connection;
  expect(back).toMatchObject({ state: "connected", cause: null });
  expect(back.accounts[0]?.installationId).not.toBe(was);
});

test("app-suspended: the connection shows the App suspended; unsuspended on GitHub, it comes back", async () => {
  const door = await morning();
  const { installation } = await pagesOf(door);
  expect(await inject(door, "app-suspended")).toBe(200);
  expect((await snapshotOf(door)).connection).toMatchObject({
    state: "disconnected",
    cause: { kind: "uninstalled", suspended: true },
  });
  await onGitHub(door, installation, [["action", "unsuspend"]]);
  await advance(door, MIN);
  expect((await snapshotOf(door)).connection).toMatchObject({ state: "connected", cause: null });
});

test("key-refused: GitHub refuses the App's key as revoked; a new key from the App's page heals it", async () => {
  const door = await morning();
  expect(await inject(door, "key-refused")).toBe(200);
  expect((await snapshotOf(door)).connection).toMatchObject({
    state: "disconnected",
    cause: { kind: "key-refused", why: "revoked" },
  });
  expect(await newKey(door)).toBe(200);
  expect((await snapshotOf(door)).connection).toMatchObject({ state: "connected", cause: null });
});

test("key-lost: Lookover restarts and finds its key gone, open tabs told to reload; a new key from the App's page heals it", async () => {
  const door = await morning();
  const events = await stream(door, BRIEF_SEEDED);
  expect(await inject(door, "key-lost")).toBe(200);
  for (;;) {
    const { value, done } = await events.next();
    if (done) throw new Error("The event stream ended");
    if (value.event === "reload") break;
  }
  const lost = await snapshotOf(door);
  expect(lost.connection).toMatchObject({
    state: "disconnected",
    cause: { kind: "key-lost" },
    app: { id: 1, slug: "lookover-spike-sasensi" },
  });
  // The story goes on: what the room watched is still there.
  expect(lost.changes[id(135)]).toBeDefined();
  expect(await newKey(door)).toBe(200);
  expect((await snapshotOf(door)).connection).toMatchObject({ state: "connected", cause: null });
});

/** Demo mode's Lookover off the PATH: the program, downloaded to a folder with a space in its path (ADR 0058). */
const DEMO_BINARY = String.raw`& 'C:\Users\Your Name\Downloads\lookover.exe'`;

test("demo mode plays the program's command: the binary's path off the PATH, `lookover` once on it (ADR 0058)", async () => {
  const door = await morning();
  expect((await snapshotOf(door)).service).toMatchObject({
    command: DEMO_BINARY,
    agent: { path: { reach: "no" } },
  });
  expect((await send(door, { type: "agent.path", on: true })).status).toBe(200);
  expect((await snapshotOf(door)).service).toMatchObject({
    command: "lookover",
    agent: { path: { reach: "yes" } },
  });
  expect((await send(door, { type: "agent.path", on: false })).status).toBe(200);
  expect((await snapshotOf(door)).service.command).toBe(DEMO_BINARY);
});

test("path-refused: the computer refuses to put lookover on the PATH, or take it off; the state kept, why said (ADR 0058)", async () => {
  const door = await morning();
  expect((await snapshotOf(door)).service.agent).toMatchObject({ path: { reach: "no" }, offer: "binary" });
  expect(await inject(door, "path-refused")).toBe(200);
  const on = await send(door, { type: "agent.path", on: true });
  expect([on.status, await on.json()]).toEqual([500, { error: "The PATH didn't change: Access is denied." }]);
  expect((await snapshotOf(door)).service).toMatchObject({
    command: DEMO_BINARY,
    agent: { path: { reach: "no" } },
  });
  // The skill still installs: only the PATH is refused.
  expect((await send(door, { type: "agent.skill", agent: "claude", on: true })).status).toBe(200);
});

test("launcher-stale: Lookover's launcher on the PATH runs an earlier copy; Add points it at this one (ADR 0058)", async () => {
  const door = await morning();
  expect(await inject(door, "launcher-stale")).toBe(200);
  expect((await snapshotOf(door)).service).toMatchObject({
    command: DEMO_BINARY,
    agent: {
      path: { reach: "stale", other: String.raw`C:\Users\Your Name\Downloads\Lookover 0.0.9\lookover.exe` },
    },
  });
  expect((await send(door, { type: "agent.path", on: true })).status).toBe(200);
  expect((await snapshotOf(door)).service).toMatchObject({
    command: "lookover",
    agent: { path: { reach: "yes" } },
  });
});

test("npm-install: Lookover restarts as an npm install: named lookover, npm's shim on the PATH, nothing offered (ADR 0061)", async () => {
  const door = await morning();
  expect(await inject(door, "npm-install")).toBe(200);
  expect((await snapshotOf(door)).service).toMatchObject({
    command: "lookover",
    agent: {
      offer: "npm",
      path: { reach: "yes", folder: String.raw`C:\Users\Your Name\AppData\Roaming\npm` },
    },
  });
  const add = await send(door, { type: "agent.path", on: true });
  expect([add.status, await add.json()]).toMatchObject([409, { agent: "not_offered" }]);
  // The skill goes in the same home's folders, and calls npm's executable (driver.ts).
  expect((await send(door, { type: "agent.skill", agent: "claude", on: true })).status).toBe(200);
  expect((await snapshotOf(door)).service.agent.skills).toContainEqual(
    expect.objectContaining({
      agent: "claude",
      state: "ours",
      folder: String.raw`C:\Users\Your Name\.claude\skills\lookover-review-loop`,
    }),
  );
});

test("npm-off-path: Lookover restarts as an npm install whose folder isn't on the PATH: said, nothing offered (ADR 0061)", async () => {
  const door = await morning();
  expect(await inject(door, "npm-off-path")).toBe(200);
  expect((await snapshotOf(door)).service).toMatchObject({
    command: "lookover",
    agent: {
      offer: "npm",
      path: { reach: "no", folder: String.raw`C:\Users\Your Name\AppData\Roaming\npm` },
    },
  });
  const add = await send(door, { type: "agent.path", on: true });
  expect([add.status, await add.json()]).toMatchObject([409, { agent: "not_offered" }]);
});

test("skill-refused: the computer refuses to write the skill, or remove it; the state kept, why said (ADR 0058)", async () => {
  const door = await morning();
  expect((await snapshotOf(door)).service.agent.skills).toMatchObject([
    { agent: "claude", state: "none" },
    { agent: "codex", state: "none" },
  ]);
  expect(await inject(door, "skill-refused")).toBe(200);
  const skill = await send(door, { type: "agent.skill", agent: "codex", on: true });
  expect([skill.status, await skill.json()]).toEqual([
    500,
    { error: "The skill didn't change: Access is denied." },
  ]);
  expect((await snapshotOf(door)).service.agent.skills).toMatchObject([
    { agent: "claude", state: "none" },
    { agent: "codex", state: "none" },
  ]);
  expect((await send(door, { type: "agent.path", on: true })).status).toBe(200);
});

test("login-refused: Lookover restarts and the computer refuses its start at login: chosen, not registered; off is kept, on again refused with why (ADR 0054)", async () => {
  const door = await morning();
  // Demo mode plays the program: its start at login is said as the machine's, though kept in memory.
  expect((await snapshotOf(door)).service).toMatchObject({
    startAtLogin: true,
    startsAtLogin: true,
    loginItem: "os",
  });
  expect(await inject(door, "login-refused")).toBe(200);
  expect((await snapshotOf(door)).service).toMatchObject({ startAtLogin: true, startsAtLogin: false });
  // Nothing registered to remove: turning it off is kept; turning it on asks the computer, which refuses.
  const off = await send(door, { type: "service.startAtLogin", on: false });
  expect(off.status).toBe(200);
  const on = await send(door, { type: "service.startAtLogin", on: true });
  expect([on.status, await on.json()]).toEqual([
    500,
    { error: "Start at login didn't change: Access is denied." },
  ]);
  expect((await snapshotOf(door)).service).toMatchObject({ startAtLogin: false, startsAtLogin: false });
});

test("key-lost with no App kept (S1): nothing to lose, the fault says so", async () => {
  const door = await startScenario(scenarioOf("S1"));
  const none = await send(door, { type: "demo.inject", fault: "key-lost" });
  expect([none.status, await none.json()]).toEqual([409, { error: "no App kept yet" }]);
});

test("key-lost mid-round (S3): the round is cut with the room, nothing of it recorded; the new room takes the job again, and S3's story goes on to round 1 posted", async () => {
  const door = await startScenario(scenarioOf("S3"));
  const csv = changeId("sasensi/ledger-api#151");
  expect((await snapshotOf(door)).reviews[csv]?.run).toMatchObject({ reviewer: "claude", step: "finding" });
  // A command under way when the fault comes answers from the room it reached, before that room stops.
  const [checked, lost] = await Promise.all([send(door, { type: "engine.check" }), inject(door, "key-lost")]);
  expect([checked.status, lost]).toEqual([200, 200]);
  const restarted = await snapshotOf(door);
  expect(restarted.connection).toMatchObject({ cause: { kind: "key-lost" } });
  expect(restarted.reviews[csv]?.rounds).toEqual([]);
  expect(restarted.reviews[csv]?.job?.failure ?? null).toBeNull();
  expect(await newKey(door)).toBe(200);
  // The run taken again from the restart ends asking for a sign-in (Claude signs out as S3 says): the job waits
  // for Claude; signed in, the review runs to its end.
  await advance(door, 3 * MIN);
  expect((await snapshotOf(door)).reviews[csv]?.job).toMatchObject({
    state: "deferred",
    deferral: { reason: "engine-signed-out", engine: "claude" },
  });
  expect((await send(door, { type: "engine.signIn", id: "claude" })).status).toBe(200);
  await advance(door, 40_000);
  await advance(door, 4 * MIN);
  const posted = (await snapshotOf(door)).reviews[csv];
  expect(posted?.job?.failure ?? null).toBeNull();
  expect(posted?.rounds.map((r) => [r.n, r.reviewer, r.confirmer])).toEqual([[1, "claude", "codex"]]);
});

test("repository-added, repository-removed: one added to the App is watched at once; removed, it goes; none left, the fault says so", async () => {
  const door = await morning();
  const repoIds = async () => (await snapshotOf(door)).repos.map((r) => [r.id, r.enabled]);
  expect(await inject(door, "repository-added")).toBe(200);
  expect(await repoIds()).toEqual([
    [repositoryId("sasensi/lookover-sandbox"), true],
    [repositoryId("sasensi/docs-site"), true],
  ]);
  expect(await inject(door, "repository-removed")).toBe(200);
  expect(await repoIds()).toEqual([[repositoryId("sasensi/lookover-sandbox"), true]]);
  expect(await inject(door, "repository-removed")).toBe(200);
  expect(await repoIds()).toEqual([]);
  const none = await send(door, { type: "demo.inject", fault: "repository-removed" });
  expect([none.status, await none.json()]).toEqual([
    409,
    { error: "no repository left on the App's installation" },
  ]);
});

test("repository-removed, repository-back: the one removed is said departed; added back, it is watched again and no longer said; none departed, the fault says so", async () => {
  const door = await morning();
  const none = await send(door, { type: "demo.inject", fault: "repository-back" });
  expect([none.status, await none.json()]).toEqual([
    409,
    { error: "no repository left the App's installation" },
  ]);

  expect(await inject(door, "repository-removed")).toBe(200);
  const sandbox = repositoryId("sasensi/lookover-sandbox");
  const removed = await snapshotOf(door);
  expect(removed.repos).toEqual([]);
  expect(removed.departed.map((d) => [d.id, d.name])).toEqual([[sandbox, "lookover-sandbox"]]);

  expect(await inject(door, "repository-back")).toBe(200);
  const back = await snapshotOf(door);
  expect(back.repos.map((r) => r.id)).toEqual([sandbox]);
  expect(back.departed).toEqual([]);
});

test("nothing-granted: S1's new App installed on no repository, the setup says so; granted all on GitHub, it goes on", async () => {
  const door = await startScenario(scenarioOf("S1"));
  expect((await send(door, { type: "setup.goto", step: "github" })).status).toBe(200);
  const installPage = await makeApp(door);
  expect(await inject(door, "nothing-granted")).toBe(200);
  await advance(door, 4_000);
  expect((await snapshotOf(door)).setup).toMatchObject({ github: "nothing-granted" });
  await installApp(door, installPage);
  await advance(door, 4_000);
  const granted = await snapshotOf(door);
  expect(granted.setup).toMatchObject({ github: "done", step: "github", reached: "repos" });
  expect(granted.repos).toHaveLength(3);
});

test("sign-in-entered: S1 signed in to the shared App from the setup, the code on GitHub's fake page; then the person and their repositories", async () => {
  const door = await startScenario(scenarioOf("S1"));
  expect((await send(door, { type: "setup.goto", step: "github" })).status).toBe(200);
  const none = await send(door, { type: "demo.inject", fault: "sign-in-entered" });
  expect([none.status, await none.json()]).toEqual([409, { error: "no sign-in waits for its code" }]);

  expect((await send(door, { type: "connection.signIn" })).status).toBe(200);
  const waiting = await snapshotOf(door);
  // The page is GitHub's fake, under demo mode's web address: nothing demo mode shows opens github.com.
  expect(waiting.connection).toMatchObject({
    way: null,
    signIn: {
      userCode: "FAKE-0001",
      verificationUri: `${DEMO_API.github}/login/device`,
      expiresAt: T0 + 15 * MIN,
    },
  });

  expect(await inject(door, "sign-in-entered")).toBe(200);
  await advance(door, 5_000);
  // The sign-in is kept on disk before the code goes; then the install's next check (4 s) finds the accounts.
  await eventually(
    () => snapshotOf(door),
    (s) => s.connection.way === "shared",
  );
  await advance(door, 4_000);
  const signedIn = await eventually(
    () => snapshotOf(door),
    (s) => s.setup.github === "done",
  );
  expect(signedIn.connection).toMatchObject({
    way: "shared",
    id: "github:sasensi",
    state: "connected",
    signIn: null,
    bot: null,
    app: null,
  });
  expect(signedIn.setup).toMatchObject({ github: "done", reached: "repos" });
  expect(signedIn.repos.map((r) => r.id)).toEqual([
    repositoryId("sasensi/ledger-api"),
    repositoryId("sasensi/ledger-web"),
    repositoryId("sasensi/invoice-pdf"),
  ]);
});

test("github-signed-out before the install: the setup's connection says signed out; a new sign-in mends it", async () => {
  const door = await startScenario(scenarioOf("S1"));
  expect((await send(door, { type: "setup.goto", step: "github" })).status).toBe(200);
  expect((await send(door, { type: "connection.signIn" })).status).toBe(200);
  expect(await inject(door, "app-uninstalled")).toBe(200);
  expect(await inject(door, "sign-in-entered")).toBe(200);
  await advance(door, 5_000);
  await eventually(
    () => snapshotOf(door),
    (s) => s.connection.way === "shared" && s.connection.signIn === null,
  );
  expect(await inject(door, "github-signed-out")).toBe(200);
  await advance(door, 4_000);
  const out = await eventually(
    () => snapshotOf(door),
    (s) => s.connection.cause !== null,
  );
  expect(out.connection).toMatchObject({ way: "shared", cause: { kind: "signed-out" } });
  expect(out.setup.github).toBe("waiting-for-install");

  expect((await send(door, { type: "connection.signIn" })).status).toBe(200);
  expect(await inject(door, "sign-in-entered")).toBe(200);
  await advance(door, 5_000);
  const back = await eventually(
    () => snapshotOf(door),
    (s) => s.connection.signIn === null && s.connection.cause === null,
  );
  expect(back.connection).toMatchObject({ way: "shared", person: { login: "sasensi" } });
});

test("sign-in-denied: the person cancels on GitHub, the code goes and nothing is signed in; the code also entered on the fake's page", async () => {
  const door = await startScenario(scenarioOf("S1"));
  expect((await send(door, { type: "setup.goto", step: "github" })).status).toBe(200);
  expect((await send(door, { type: "connection.signIn" })).status).toBe(200);
  expect(await inject(door, "sign-in-denied")).toBe(200);
  await advance(door, 5_000);
  expect((await snapshotOf(door)).connection).toMatchObject({
    way: null,
    signIn: null,
    state: "not-connected",
  });

  // Started again, the next code entered on GitHub's fake page, as the browser does there.
  expect((await send(door, { type: "connection.signIn" })).status).toBe(200);
  const code = (await snapshotOf(door)).connection.signIn?.userCode ?? "";
  expect(code).toBe("FAKE-0002");
  expect(
    await onGitHub(door, "/login/device", [
      ["user_code", code],
      ["action", "authorize"],
    ]),
  ).toContain("You're signed in");
  await advance(door, 5_000);
  const signedIn = await eventually(
    () => snapshotOf(door),
    (s) => s.connection.way !== null,
  );
  expect(signedIn.connection).toMatchObject({ way: "shared", signIn: null });
});

test("a fault that isn't one is refused at the door", async () => {
  const door = await morning();
  expect((await send(door, { type: "demo.inject", fault: "service-stopped" })).status).toBe(400);
});
