// "Sign in" through the service's door (ADR 0047), on fakes and the held clock: the vendor's login opened (a
// stand-in for the terminal here), the engine shown signing in, its health asked every 5 s for up to 10 min,
// ready once signed in and the review that waited on it started, the sign-in refused while one is pending, and
// a terminal that won't open refused with why. The expected numbers are the spec's: 5 s, 10 min.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { changeId, type EngineId, type Engines, SSE } from "@lookover/contracts";
import {
  advance,
  inject,
  send,
  snapshotOf,
  startScenario,
  stopAll as stopScenarios,
} from "./demo/demo.test-support.ts";
import { scenarioOf } from "./index.ts";
import {
  api,
  fakeEngines,
  home,
  lastEvent,
  messages,
  next,
  openApp,
  PLANTED,
  post,
  review,
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

/** Engines whose health asks are counted, by engine. */
function counted(engines: Engines): { engines: Engines; asked: Record<EngineId, number> } {
  const asked: Record<EngineId, number> = { claude: 0, codex: 0 };
  return {
    asked,
    engines: {
      run: (spec, signal) => engines.run(spec, signal),
      health: (engine) => {
        asked[engine] += 1;
        return engines.health(engine);
      },
    },
  };
}

/** A terminal that opens: nothing happens in it until the test signs the engine in by hand. */
const OPENS = { open: () => Promise.resolve({ opened: true as const }) };

const signIn = (service: Parameters<typeof post>[0], cookie: string, id: EngineId = "claude") =>
  post(service, cookie, { type: "engine.signIn", id });

test("Sign in on a signed-out engine opens the login and shows the engine signing in", async () => {
  const { service } = await start({ engines: fakeEngines({ signedIn: false }), signIn: OPENS });
  const cookie = await openApp(service);
  expect((await snapshot(service, cookie)).engines.claude).toMatchObject({
    state: "signed-out",
    signingIn: false,
  });

  expect((await signIn(service, cookie)).status).toBe(200);
  expect((await snapshot(service, cookie)).engines.claude).toMatchObject({
    state: "signed-out",
    signingIn: true,
  });
});

test("while the sign-in is pending the engine's health is asked every 5 s; signed in, it shows ready and the review that waited on it starts", async () => {
  const fake = fakeEngines({ signedIn: false, reviews: 1 });
  const { engines, asked } = counted(fake);
  const { service, time } = await start({ engines, signIn: OPENS });
  const cookie = await openApp(service);
  // The review waits on Claude, signed out.
  expect((await review(service, cookie)).status).toBe(200);
  await time.advance(0);
  expect((await snapshot(service, cookie)).reviews[PLANTED]?.job).toMatchObject({
    state: "deferred",
    deferral: { reason: "engine-signed-out", engine: "claude" },
  });
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

  expect((await signIn(service, cookie)).status).toBe(200);
  expect(await until(stream, "engine.changed")).toEqual([
    { type: "engine.changed", seq: 7, at: T0, id: "claude", patch: { signingIn: true } },
  ]);
  const before = asked.claude;
  await time.advance(4_999);
  expect(asked.claude).toBe(before);
  await time.advance(1);
  expect(asked.claude).toBe(before + 1);
  await time.advance(10_000);
  expect(asked.claude).toBe(before + 3);
  expect((await snapshot(service, cookie)).engines.claude).toMatchObject({
    state: "signed-out",
    signingIn: true,
  });

  // Signed in at the terminal: the next look sees it, the engine is ready, and the review starts by itself.
  fake.setHealth("claude", { installed: true, version: "2.4.1", signedIn: true });
  await time.advance(5_000);
  const seen = await until(stream, "run.started");
  expect(seen.map((e) => e.type)).toEqual(["engine.changed", "engine.changed", "run.started"]);
  expect(seen[0]).toMatchObject({
    at: T0 + 20_000,
    id: "claude",
    patch: { state: "ready", version: "2.4.1", since: T0 + 20_000 },
  });
  expect(seen[1]).toMatchObject({ at: T0 + 20_000, id: "claude", patch: { signingIn: false } });
  expect((await snapshot(service, cookie)).engines.claude).toMatchObject({
    state: "ready",
    signingIn: false,
  });
  // The watch is over: nothing asks Claude's health every 5 s any more.
  const after = asked.claude;
  await time.advance(10_000);
  expect(asked.claude).toBe(after);
});

test("nothing happening for ten minutes ends the watch: the engine stays signed out and no longer shows signing in", async () => {
  const { engines, asked } = counted(fakeEngines({ signedIn: false }));
  const { service, time } = await start({ engines, signIn: OPENS });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await signIn(service, cookie)).status).toBe(200);
  await until(stream, "engine.changed");
  const before = asked.claude;

  await time.advance(10 * 60_000 - 1);
  expect((await snapshot(service, cookie)).engines.claude).toMatchObject({
    state: "signed-out",
    signingIn: true,
  });
  await time.advance(1);
  expect(await until(stream, "engine.changed")).toEqual([
    { type: "engine.changed", seq: 6, at: T0 + 10 * 60_000, id: "claude", patch: { signingIn: false } },
  ]);
  // 120 looks, one every 5 s, the last at the end; then none.
  expect(asked.claude).toBe(before + 120);
  await time.advance(60_000);
  expect(asked.claude).toBe(before + 120);
  expect((await snapshot(service, cookie)).engines.claude).toMatchObject({
    state: "signed-out",
    signingIn: false,
  });
});

test("a second sign-in of the same engine while one is pending is refused; once the watch is over, it is taken again", async () => {
  const fake = fakeEngines({ signedIn: false });
  fake.setHealth("codex", { installed: true, version: "0.162.1", signedIn: false });
  const { service, time } = await start({ engines: fake, signIn: OPENS });
  const cookie = await openApp(service);
  expect((await signIn(service, cookie)).status).toBe(200);

  const again = await signIn(service, cookie);
  expect(again.status).toBe(409);
  expect(await again.json()).toEqual({ error: "the sign-in of claude is already running" });
  // The other engine's sign-in is its own.
  expect((await signIn(service, cookie, "codex")).status).toBe(200);
  const { engines } = await snapshot(service, cookie);
  expect([engines.claude.signingIn, engines.codex.signingIn]).toEqual([true, true]);

  await time.advance(10 * 60_000);
  expect((await snapshot(service, cookie)).engines.claude.signingIn).toBe(false);
  expect((await signIn(service, cookie)).status).toBe(200);
  expect((await snapshot(service, cookie)).engines.claude.signingIn).toBe(true);
});

test("a login that won't open is refused with why, and the engine never shows signing in", async () => {
  const { service, time } = await start({
    engines: fakeEngines({ signedIn: false }),
    signIn: { open: () => Promise.resolve({ opened: false, reason: "x-terminal-emulator: ENOENT" }) },
  });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

  const refused = await signIn(service, cookie);
  expect(refused.status).toBe(500);
  expect(await refused.json()).toEqual({
    error: "the sign-in of claude didn't open: x-terminal-emulator: ENOENT",
  });
  expect((await snapshot(service, cookie)).engines.claude).toMatchObject({
    state: "signed-out",
    signingIn: false,
  });
  // Nothing was sent, and nothing watches: the stream only says it is alive.
  await time.advance(15_000);
  expect((await next(stream)).event).toBe(SSE.keepalive);
  // The sign-in can be tried again at once: nothing is pending.
  expect((await signIn(service, cookie)).status).toBe(500);
});

test("a sign-in pending when the service stops is over at the next start: the engine no longer shows signing in, and nothing watches it", async () => {
  const dir = home();
  const first = await start({ home: dir, engines: fakeEngines({ signedIn: false }), signIn: OPENS });
  const cookie = await openApp(first.service);
  expect((await signIn(first.service, cookie)).status).toBe(200);
  await first.time.advance(5_000);
  expect((await snapshot(first.service, cookie)).engines.claude.signingIn).toBe(true);
  await first.service.stop();
  const last = lastEvent(dir);

  const { engines, asked } = counted(fakeEngines({ signedIn: false }));
  const again = await start({ home: dir, engines, signIn: OPENS, time: first.time, idsFrom: 1 });
  // Right after the start's own first event: the second clears the sign-in.
  const stream = await sinceStart(again.service, cookie, last);
  expect(await until(stream, "engine.changed")).toEqual([
    { type: "engine.changed", seq: last + 2, at: T0 + 5_000, id: "claude", patch: { signingIn: false } },
  ]);
  expect((await snapshot(again.service, cookie)).engines.claude).toMatchObject({
    state: "signed-out",
    signingIn: false,
  });
  // The start read both healths once; nothing looks every 5 s.
  expect(asked.claude).toBe(1);
  await again.time.advance(10_000);
  expect(asked.claude).toBe(1);
});

test("in demo mode the scripted engine signs itself in: five seconds on, Claude is ready and the review that waited starts; a missing engine has no login to open", async () => {
  const door = await startScenario(scenarioOf("S10"));
  expect(await inject(door, "claude-signed-out")).toBe(200);
  const change = changeId("lookover-sandbox#141");
  expect((await send(door, { type: "review.request", changeId: change })).status).toBe(200);
  expect((await snapshotOf(door)).reviews[change]?.job).toMatchObject({
    state: "deferred",
    deferral: { reason: "engine-signed-out", engine: "claude" },
  });

  expect((await send(door, { type: "engine.signIn", id: "claude" })).status).toBe(200);
  expect((await snapshotOf(door)).engines.claude).toMatchObject({ state: "signed-out", signingIn: true });
  await advance(door, 4_999);
  expect((await snapshotOf(door)).engines.claude).toMatchObject({ state: "signed-out", signingIn: true });
  await advance(door, 1);
  const signedIn = await snapshotOf(door);
  expect(signedIn.engines.claude).toMatchObject({ state: "ready", signingIn: false, since: T0 + 5_000 });
  expect(signedIn.reviews[change]?.run).toMatchObject({ reviewer: "claude", step: "finding" });

  expect(await inject(door, "engines-missing")).toBe(200);
  const refused = await send(door, { type: "engine.signIn", id: "codex" });
  expect(refused.status).toBe(500);
  expect(await refused.json()).toEqual({
    error: "the sign-in of codex didn't open: codex is not installed: nothing to sign in to",
  });
  await stopScenarios();
});

test("a run that found Claude signed out while its health said ready keeps it signed out for the hold's minute: the watch looks on, and ends ready once the hold is over", async () => {
  const fake = fakeEngines();
  fake.answer({ outcome: "auth_required", text: "" });
  fake.answer({ outcome: "ok", text: "No findings." });
  const { service, time } = await start({ engines: fake, signIn: OPENS });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "run.started");
  await time.advance(0);
  expect((await snapshot(service, cookie)).engines.claude.state).toBe("signed-out");

  expect((await signIn(service, cookie)).status).toBe(200);
  // The health says ready, but the run said otherwise: the hold stands, and nothing starts on it.
  await time.advance(55_000);
  const held = await snapshot(service, cookie);
  expect(held.engines.claude).toMatchObject({ state: "signed-out", signingIn: true });
  expect(held.reviews[PLANTED]?.job).toMatchObject({ state: "deferred" });

  await time.advance(5_000);
  const over = await snapshot(service, cookie);
  expect(over.engines.claude).toMatchObject({ state: "ready", signingIn: false });
  expect(over.reviews[PLANTED]?.job?.state).not.toBe("deferred");
});

test("a sign-in of an engine at its limit leaves the limit standing, and the watch ends at the first look", async () => {
  const fake = fakeEngines();
  fake.answer({ outcome: "quota_exhausted", text: "" });
  const { service, time } = await start({ engines: fake, signIn: OPENS });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "run.started");
  await time.advance(0);
  expect((await snapshot(service, cookie)).engines.claude.state).toBe("limit");

  expect((await signIn(service, cookie)).status).toBe(200);
  await time.advance(5_000);
  const after = await snapshot(service, cookie);
  expect(after.engines.claude).toMatchObject({ state: "limit", signingIn: false });
  expect(after.reviews[PLANTED]?.job).toMatchObject({
    state: "deferred",
    deferral: { reason: "engine-limit" },
  });
});

test("a look that finds the engine gone ends the watch: it shows missing and no longer signing in", async () => {
  const fake = fakeEngines({ signedIn: false });
  const { engines, asked } = counted(fake);
  const { service, time } = await start({ engines, signIn: OPENS });
  const cookie = await openApp(service);
  expect((await signIn(service, cookie)).status).toBe(200);

  fake.setHealth("claude", { installed: false, version: null, signedIn: false });
  await time.advance(5_000);
  expect((await snapshot(service, cookie)).engines.claude).toMatchObject({
    state: "missing",
    signingIn: false,
  });
  const after = asked.claude;
  await time.advance(10_000);
  expect(asked.claude).toBe(after);
});
