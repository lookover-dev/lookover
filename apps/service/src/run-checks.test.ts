// "Run all checks" and "Unlock", through the service's entry, on fakes only (ADR 0047): the checks read both
// engines' health again and report each check as data (the UI words them); the unlock marks the session unlocked.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import type { CheckItem, Event } from "@lookover/contracts";
import {
  api,
  BOT,
  fakeEngines,
  home,
  messages,
  openApp,
  post,
  review,
  slowHealth,
  snapshot,
  start,
  stopAll,
  T0,
  TEST_LIMIT_MS,
  until,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

test("Run all checks reads both engines again and reports each engine, the connection, the service, the disk and the version", async () => {
  const engines = fakeEngines();
  const { service } = await start({ engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

  // Codex was installed and signed in since the start: the checks find it, as "Check again" would.
  engines.setHealth("codex", { installed: true, version: "0.162.1", signedIn: true });
  expect((await post(service, cookie, { type: "service.runChecks" })).status).toBe(200);
  const running = await until(stream, "service.changed");
  expect(running).toEqual([
    { type: "service.changed", seq: 5, at: T0, patch: { checks: { at: T0, running: true, items: [] } } },
  ]);
  // Up to the checks' end: Codex found and, read again with it (ADR 0058), your coding agent offering its skill.
  const changed = (e: Event, key: "checks" | "agent") =>
    e.type === "service.changed" && e.patch[key] !== undefined;
  const done = [...(await until(stream, "service.changed"))];
  while (!done.some((e) => changed(e, "checks")) || !done.some((e) => changed(e, "agent")))
    done.push(...(await until(stream, "service.changed")));
  expect(done.map((e) => e.type)).toEqual(["engine.changed", "service.changed", "service.changed"]);
  expect(done[0]).toMatchObject({ id: "codex", patch: { state: "ready", version: "0.162.1" } });
  const agent = done.find((e) => changed(e, "agent"));
  expect(agent).toMatchObject({ patch: { agent: { skills: [{ agent: "claude" }, { agent: "codex" }] } } });
  const expected: CheckItem[] = [
    { check: "engine", engine: "claude", state: "ready", cli: "claude", version: "2.4.1", unusable: null },
    { check: "engine", engine: "codex", state: "ready", cli: "codex", version: "0.162.1", unusable: null },
    { check: "connection", state: "connected", cause: null, bot: BOT.login, key: null },
    // On by default, and registered once the setup is done (ADR 0054): the fake's registration, in memory.
    { check: "service", state: "running", startAtLogin: true, startsAtLogin: true, loginItem: "memory" },
    { check: "settings", invalid: [] },
    // The data folder's free space, as the machine has it: whole gigabytes.
    { check: "disk", freeGb: expect.any(Number) },
    // Never checked against a newer version before publication: no verdict.
    { check: "version", version: "0.1.0", upToDate: null },
  ];
  expect(done.find((e) => changed(e, "checks"))).toMatchObject({
    at: T0,
    patch: { checks: { at: T0, running: false, items: expected } },
  });
  const shown = await snapshot(service, cookie);
  expect(shown.service.checks).toEqual({ at: T0, running: false, items: expected });
  const disk = shown.service.checks.items.find((item: CheckItem) => item.check === "disk");
  expect(Number.isInteger(disk.freeGb) && disk.freeGb >= 0).toBe(true);
});

test("a Codex too old for its model is not usable: its state and Run checks name why, and a review runs without it", async () => {
  const engines = fakeEngines({ reviews: 1 });
  const { service } = await start({ engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

  const tooOld = { kind: "too-old", version: "0.154.0", model: "gpt-6.1-sol", needs: "0.162.0" } as const;
  engines.setHealth("codex", { installed: false, version: "0.154.0", signedIn: true, why: tooOld });
  expect((await post(service, cookie, { type: "service.runChecks" })).status).toBe(200);
  await until(stream, "service.changed");
  const done = await until(stream, "service.changed");
  const detail =
    "gpt-6.1-sol needs Codex 0.162.0 or later; this one is 0.154.0. Update it, then check again: npm install -g @openai/codex@latest";
  expect(done[0]).toMatchObject({
    id: "codex",
    patch: { state: "missing", version: "0.154.0", detail, unusable: tooOld },
  });
  expect(done[1]).toMatchObject({
    patch: {
      checks: {
        items: expect.arrayContaining([
          {
            check: "engine",
            engine: "codex",
            state: "missing",
            cli: "codex",
            version: "0.154.0",
            unusable: tooOld,
          },
        ]),
      },
    },
  });
  expect((await snapshot(service, cookie)).engines.codex).toMatchObject({
    state: "missing",
    detail,
    unusable: tooOld,
  });

  // A review now runs on Claude alone: nothing starts on the old Codex.
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "round.finished");
  expect(engines.runs.map((r) => r.engine)).not.toContain("codex");
});

test("Unlock marks the session unlocked, once: a second unlock changes nothing", async () => {
  const { service } = await start();
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await snapshot(service, cookie)).service).toMatchObject({ remote: false, unlocked: false });

  expect((await post(service, cookie, { type: "service.unlock" })).status).toBe(200);
  expect(await until(stream, "service.changed")).toEqual([
    { type: "service.changed", seq: 5, at: T0, patch: { unlocked: true } },
  ]);
  expect((await post(service, cookie, { type: "service.unlock" })).status).toBe(200);
  expect(await snapshot(service, cookie)).toMatchObject({ seq: 5, service: { unlocked: true } });
});

test("a service stopped mid-check ends the checks before it closes; started again on the same folder, it runs them afresh", async () => {
  const dir = home();
  const slow = slowHealth(fakeEngines());
  const first = await start({ home: dir, engines: slow.engines });
  const cookie = await openApp(first.service);
  const held = slow.hold();
  // The checks run; the engine's health never answers; the service stops. The answer is lost with the server.
  const asked = post(first.service, cookie, { type: "service.runChecks" }).catch(() => null);
  await held.asked;
  await first.service.stop();
  await asked;

  // Restarted: the log holds the checks ended, not running, so nothing stale is replayed, and "Run all checks"
  // answers.
  const second = await start({
    home: dir,
    engines: fakeEngines(),
    host: first.host,
    time: first.time,
    idsFrom: 100,
  });
  const again = await openApp(second.service);
  expect((await snapshot(second.service, again)).service.checks).toMatchObject({ running: false });
  expect((await post(second.service, again, { type: "service.runChecks" })).status).toBe(200);
  const shown = await snapshot(second.service, again);
  expect(shown.service.checks.running).toBe(false);
  expect(shown.service.checks.items.map((item: CheckItem) => item.check)).toEqual([
    "engine",
    "engine",
    "connection",
    "service",
    "settings",
    "disk",
    "version",
  ]);
});

test("Run all checks while the checks run is refused: one run at a time", async () => {
  const slow = slowHealth(fakeEngines());
  const { service } = await start({ engines: slow.engines });
  const cookie = await openApp(service);
  const held = slow.hold();
  const first = post(service, cookie, { type: "service.runChecks" });
  await held.asked;
  const second = await post(service, cookie, { type: "service.runChecks" });
  expect(second.status).toBe(409);
  expect(await second.json()).toEqual({ error: "the checks are already running" });
  held.release();
  expect((await first).status).toBe(200);
  expect((await snapshot(service, cookie)).service.checks).toMatchObject({ running: false });
});
