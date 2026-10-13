// The `lookover` program (`main.ts`): `--version`, and `serve` as `bun run proof` runs it: demo mode on a scenario with `--frozen=<ms>`, so two runs
// serve the same facts and the shots of the app on the service are the same pixels every time (ADR 0046).
import { afterAll, afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, changeId as asChangeId, jobId, type State } from "@lookover/contracts";

const MAIN = join(import.meta.dir, "main.ts");
// Tuesday 6 October 2026, 08:52 UTC.
const FROZEN_AT = Date.UTC(2026, 9, 6, 8, 52);
const MIN = 60_000;
// How long the program may take to start, or to refuse its arguments, before it is a failure: it loads and
// plays the scenario's seed on the fakes, under a second on an idle machine. Each test is given longer than the
// start it waits for, or Bun's 5 s would cut a slow start short.
const START_LIMIT_MS = 10_000;
setDefaultTimeout(START_LIMIT_MS + 5_000);

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  // In reverse: the data folder goes once the service in it has stopped (Windows says EBUSY otherwise).
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const newHome = () => mkdtempSync(join(realpathSync.native(tmpdir()), "lookover-main-"));

function home(): string {
  const made = newHome();
  cleanups.push(() => rmSync(made, { recursive: true, force: true }));
  return made;
}

/** The program, started with `args` in a fresh data folder; its exit code and what it printed on stderr. */
async function refused(...args: string[]): Promise<{ code: number | null; stderr: string }> {
  const proc = Bun.spawn([process.execPath, MAIN, "serve", ...args, `--home=${home()}`], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const code = await proc.exited;
  return { code, stderr: await new Response(proc.stderr).text() };
}

/**
 * The program in demo mode on S10 with `--frozen`, as `bun run proof` starts it, in a data folder watched from
 * before it starts: `written` holds what the file system said of the announce file. One start serves the file;
 * `afterAll` stops it and removes its folder.
 */
async function start() {
  const dir = newHome();
  const announce = join(dir, "service.json");
  const written: string[] = [];
  const watcher = watch(dir, (event, name) => {
    if (name === "service.json") written.push(event);
  });
  const proc = Bun.spawn(
    [
      process.execPath,
      MAIN,
      "serve",
      "--demo",
      "--scenario=S10",
      `--frozen=${FROZEN_AT}`,
      `--home=${dir}`,
      `--announce=${announce}`,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const stop = async () => {
    watcher.close();
    proc.kill();
    await proc.exited;
    rmSync(dir, { recursive: true, force: true });
  };
  for (let i = 0; i < START_LIMIT_MS / 20 && !existsSync(announce) && proc.exitCode === null; i++)
    await Bun.sleep(20);
  if (!existsSync(announce)) {
    await stop();
    throw new Error(`The service did not start: ${await new Response(proc.stderr).text()}`);
  }
  const { origin, openUrl } = JSON.parse(readFileSync(announce, "utf8"));
  const opened = await fetch(openUrl, { redirect: "manual" });
  const cookie = opened.headers.get("set-cookie")?.split(";")[0] ?? "";
  const call = (path: string, init?: RequestInit) =>
    fetch(`${origin}${path}`, { ...init, headers: { ...init?.headers, cookie, origin } });
  const snapshot = async (): Promise<State> => (await call(API.snapshot)).json();
  const send = (body: unknown) =>
    call(API.commands, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { call, send, snapshot, dir, announce, written, stop };
}

let started: ReturnType<typeof start> | undefined;
const frozenDemo = () => {
  started ??= start();
  return started;
};
afterAll(async () => {
  await (await started)?.stop();
});

test("the announce file appears whole: whoever waits for it never reads it empty or half written", async () => {
  // `bun dev`, `bun run proof` and these tests read the file once it exists. Written in place, it would exist
  // empty a moment, then change; put in place whole, it never changes under its own name.
  const { announce, written: events } = await frozenDemo();
  expect(JSON.parse(readFileSync(announce, "utf8"))).toMatchObject({ openUrl: expect.any(String) });
  // The watcher's events arrive a moment after the file system's, later on a busy machine: wait for the
  // first, then a moment more, so that a "change" right behind it would be seen too.
  for (let i = 0; i < START_LIMIT_MS / 20 && events.length === 0; i++) await Bun.sleep(20);
  expect(events.length).toBeGreaterThan(0);
  await Bun.sleep(200);
  expect(events).not.toContain("change");
});

test("--frozen stands the demo service's clock at that instant once S10's seed is played, with its ids counted from 1; the drawer's faults and clock move it from there", async () => {
  const { send, snapshot } = await frozenDemo();
  const started = await snapshot();
  // The seed is two and a half hours long: the service has run since then, and now stands at the frozen instant.
  expect(started.now).toBe(FROZEN_AT);
  expect(started.service.since).toBe(FROZEN_AT - 150 * MIN);
  expect(started.engines.claude.state).toBe("ready");
  expect(started.engines.codex).toMatchObject({ state: "ready", version: "0.162.1" });
  // The first id made is the first review's job; the seed's stamps are on the clock, so every run gives the same.
  const clean = started.reviews[asChangeId("lookover-sandbox#135")];
  expect(clean?.job?.id).toBe(jobId("1"));
  expect(clean?.rounds.map((r) => [r.startedAt, r.endedAt])).toEqual([
    [FROZEN_AT - 149 * MIN, FROZEN_AT - 149 * MIN + 75_000],
  ]);
  const settled = started.reviews[asChangeId("lookover-sandbox#146")];
  expect(settled?.rounds).toHaveLength(2);
  expect(settled?.loop).toBe("settled");

  // The developer drawer's "Codex fails Lookover's safety check": a newer codex whose self-test crosses the
  // wall. The engines are checked at once, the new version is self-tested, and Codex shows it failed (ADR 0044).
  expect((await send({ type: "demo.inject", fault: "codex-failed-self-test" })).status).toBe(200);
  let state = await snapshot();
  for (let i = 0; i < 300 && state.engines.codex.state !== "failed-self-test"; i++) {
    await Bun.sleep(100);
    state = await snapshot();
  }
  expect(state.engines.codex).toMatchObject({ state: "failed-self-test", version: "0.163.0" });
  // "Codex is updated": the version after it passes.
  expect((await send({ type: "demo.inject", fault: "codex-updated" })).status).toBe(200);
  for (let i = 0; i < 300 && state.engines.codex.state !== "ready"; i++) {
    await Bun.sleep(100);
    state = await snapshot();
  }
  expect(state.engines.codex).toMatchObject({ state: "ready", version: "0.164.0" });

  // The frozen clock is the demo clock standing still (ADR 0046): the drawer's `demo.advance` moves it, and the
  // service's `now` with it; nothing else moved it meanwhile.
  expect(state.now).toBe(FROZEN_AT);
  expect((await send({ type: "demo.advance", ms: 60_000 })).status).toBe(200);
  expect((await snapshot()).now).toBe(FROZEN_AT + 60_000);
}, 60_000);

test("--frozen and --scenario are for demo mode only, and a scenario must exist", async () => {
  const frozen = await refused("--live", `--frozen=${FROZEN_AT}`);
  expect(frozen.code).not.toBe(0);
  expect(frozen.stderr).toContain("--frozen is for demo mode");
  const scenario = await refused("--live", "--scenario=S10");
  expect(scenario.code).not.toBe(0);
  expect(scenario.stderr).toContain("--scenario is for demo mode");
  const unknown = await refused("--demo", "--scenario=S99");
  expect(unknown.code).not.toBe(0);
  expect(unknown.stderr).toContain("No scenario S99");
});

// A live config with no App is taken (ADR 0053): the data folder's App, or the setup, gives it.
test("live mode refuses, before taking the lock or calling GitHub, a live config with two of one name, and never for its `watch`", async () => {
  const folder = home();
  const key = join(folder, "app.pem");
  writeFileSync(key, "-----BEGIN RSA PRIVATE KEY-----\nnot a key\n-----END RSA PRIVATE KEY-----\n");
  const app = { id: 5202093, keyPath: key };
  const live = async (config: unknown) => {
    const path = join(folder, "live.json");
    writeFileSync(path, JSON.stringify(config));
    const run = await refused("--live", `--live-config=${path}`);
    expect(run.code).not.toBe(0);
    // The sentence alone, not a stack trace around it.
    expect(run.stderr).not.toContain("readLiveConfig");
    return run.stderr;
  };
  const sandbox = "sasensi/lookover-sandbox";
  const twins = await live({
    app,
    repositories: ["lookover-dev/lookover-private", "someone/lookover-private"],
    watch: sandbox,
  });
  expect(twins).toContain(
    `"repositories" lists two repositories named lookover-private, lookover-dev/lookover-private and someone/lookover-private`,
  );
  // `watch` is ignored (the owner's own file keeps it): never a refusal, its one line printed once a config is taken.
  expect(twins).not.toMatch(/"watch"|`watch`/);
});

test("`lookover --version` prints the root package.json's version and exits 0, starting nothing", async () => {
  // Read off the disk: release-please moves it, so a literal here would fail the next release's pull request.
  const version = JSON.parse(readFileSync(join(import.meta.dir, "../../../package.json"), "utf8")).version;
  const proc = Bun.spawn([process.execPath, MAIN, "--version"], { stdout: "pipe", stderr: "pipe" });
  expect(await proc.exited).toBe(0);
  expect(await new Response(proc.stdout).text()).toBe(`${version}\n`);
});
