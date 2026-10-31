// Start at login through the service, on the fake `LoginItem` (ADR 0054, ADR 0068): the choice on by default, the
// registration made to match it once the setup is done (at start, at the setup's finish, on each
// `service.startAtLogin`), never before, and a registration the machine refuses refusing the command with its reason,
// the choice kept as it was. Another install's registration is never removed, and replaced only by `takeOver`.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Setup } from "@lookover/contracts";
import { memoryLoginItem, xdgLoginItem } from "./index.ts";
import {
  api,
  home,
  messages,
  openApp,
  post,
  snapshot,
  start,
  stopAll,
  TEST_LIMIT_MS,
  until,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

/** The owner on the setup's last step, everything before it done. */
const LAST_STEP: Setup = {
  done: false,
  step: "background",
  reached: "background",
  github: "done",
  githubRefused: null,
  firstReviewChange: null,
};

test("on by default: a data folder set up starts registered, and the snapshot says both", async () => {
  const loginItem = memoryLoginItem();
  const { service } = await start({ loginItem });
  const state = await snapshot(service, await openApp(service));
  expect(state.service).toMatchObject({ startAtLogin: true, atLogin: "this" });
  expect(await loginItem.held()).toBe("this");
});

test("never registered before the setup is done; registered once it is, as the choice says", async () => {
  const loginItem = memoryLoginItem();
  const { service } = await start({ loginItem, setup: LAST_STEP });
  const cookie = await openApp(service);
  expect((await snapshot(service, cookie)).service).toMatchObject({
    startAtLogin: true,
    atLogin: "none",
  });
  expect(await loginItem.held()).toBe("none");
  // Chosen during the setup: kept, still nothing registered.
  expect((await post(service, cookie, { type: "service.startAtLogin", on: false })).status).toBe(200);
  expect((await post(service, cookie, { type: "service.startAtLogin", on: true })).status).toBe(200);
  expect(await loginItem.held()).toBe("none");

  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await post(service, cookie, { type: "setup.finish" })).status).toBe(200);
  expect(await until(stream, "service.changed")).toContainEqual(
    expect.objectContaining({ type: "service.changed", patch: { atLogin: "this" } }),
  );
  expect(await loginItem.held()).toBe("this");
});

test("a setup finished with start at login turned off registers nothing", async () => {
  const loginItem = memoryLoginItem();
  const { service } = await start({ loginItem, setup: LAST_STEP });
  const cookie = await openApp(service);
  expect((await post(service, cookie, { type: "service.startAtLogin", on: false })).status).toBe(200);
  expect((await post(service, cookie, { type: "setup.finish" })).status).toBe(200);
  expect((await snapshot(service, cookie)).setup.done).toBe(true);
  expect(await loginItem.held()).toBe("none");
  expect((await snapshot(service, cookie)).service.atLogin).toBe("none");
});

test("turned off, the registration is removed and both are sent; turned on again, it is back", async () => {
  const loginItem = memoryLoginItem();
  const { service } = await start({ loginItem });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await post(service, cookie, { type: "service.startAtLogin", on: false })).status).toBe(200);
  expect(await loginItem.held()).toBe("none");
  const sent = await until(stream, "service.changed");
  expect(sent).toContainEqual(
    expect.objectContaining({ type: "service.changed", patch: { startAtLogin: false } }),
  );
  expect((await snapshot(service, cookie)).service).toMatchObject({
    startAtLogin: false,
    atLogin: "none",
  });

  expect((await post(service, cookie, { type: "service.startAtLogin", on: true })).status).toBe(200);
  expect(await loginItem.held()).toBe("this");
  expect((await snapshot(service, cookie)).service).toMatchObject({
    startAtLogin: true,
    atLogin: "this",
  });
});

test("a registration the machine refuses refuses the command with its reason, and the choice stays as it was", async () => {
  const loginItem = memoryLoginItem();
  const dir = home();
  const first = await start({ home: dir, loginItem });
  const cookie = await openApp(first.service);
  loginItem.refuse("Access is denied.");
  const refused = await post(first.service, cookie, { type: "service.startAtLogin", on: false });
  expect(refused.status).toBe(500);
  expect(await refused.json()).toEqual({ error: "Start at login didn't change: Access is denied." });
  expect((await snapshot(first.service, cookie)).service).toMatchObject({
    startAtLogin: true,
    atLogin: "this",
  });
  await first.service.stop();
  // The choice kept is the one before: the next start keeps it, and registers it.
  loginItem.refuse(null);
  await loginItem.unregister();
  const second = await start({ home: dir, host: first.host, loginItem });
  expect((await snapshot(second.service, await openApp(second.service))).service).toMatchObject({
    startAtLogin: true,
    atLogin: "this",
  });
  expect(await loginItem.held()).toBe("this");
});

test("a start the machine refuses to register starts all the same, says it isn't registered and logs why", async () => {
  const loginItem = memoryLoginItem();
  loginItem.refuse("Access is denied.");
  const logged: string[] = [];
  const { service } = await start({ loginItem, log: (line) => logged.push(line) });
  expect((await snapshot(service, await openApp(service))).service).toMatchObject({
    startAtLogin: true,
    atLogin: "none",
  });
  expect(logged).toContain("Lookover couldn't register its start at login: Access is denied.");
});

/** Another install's command, as its registration holds it. */
const THEIRS = "C:\\Users\\Your Name\\AppData\\Local\\Programs\\Lookover\\lookover.exe start --no-open";

test("a start never takes another install's start at login over: it is left, logged, and the snapshot names it (ADR 0068)", async () => {
  const loginItem = memoryLoginItem();
  loginItem.holdOther(THEIRS);
  const logged: string[] = [];
  const { service } = await start({ loginItem, log: (line) => logged.push(line) });
  expect((await snapshot(service, await openApp(service))).service).toMatchObject({
    startAtLogin: true,
    atLogin: { other: THEIRS },
  });
  expect(await loginItem.held()).toEqual({ other: THEIRS });
  expect(logged).toContain(`Another Lookover starts at login: ${THEIRS}`);
});

test("the setup's end never takes another install's start at login over (ADR 0068)", async () => {
  const loginItem = memoryLoginItem();
  const { service } = await start({ loginItem, setup: LAST_STEP });
  const cookie = await openApp(service);
  loginItem.holdOther(THEIRS);
  expect((await post(service, cookie, { type: "setup.finish" })).status).toBe(200);
  expect(await loginItem.held()).toEqual({ other: THEIRS });
  expect((await snapshot(service, cookie)).service.atLogin).toEqual({ other: THEIRS });
});

test("turned off, another install's start at login is left; turned on, still left; on with take over, this one's (ADR 0068)", async () => {
  const loginItem = memoryLoginItem();
  loginItem.holdOther(THEIRS);
  const { service } = await start({ loginItem });
  const cookie = await openApp(service);
  expect((await post(service, cookie, { type: "service.startAtLogin", on: false })).status).toBe(200);
  expect(await loginItem.held()).toEqual({ other: THEIRS });
  expect((await snapshot(service, cookie)).service).toMatchObject({
    startAtLogin: false,
    atLogin: { other: THEIRS },
  });
  expect((await post(service, cookie, { type: "service.startAtLogin", on: true })).status).toBe(200);
  expect(await loginItem.held()).toEqual({ other: THEIRS });
  expect((await snapshot(service, cookie)).service).toMatchObject({
    startAtLogin: true,
    atLogin: { other: THEIRS },
  });
  const taken = await post(service, cookie, { type: "service.startAtLogin", on: true, takeOver: true });
  expect(taken.status).toBe(200);
  expect(await loginItem.held()).toBe("this");
  expect((await snapshot(service, cookie)).service).toMatchObject({ startAtLogin: true, atLogin: "this" });
});

test("another install taking start at login over while the service was stopped is said at the next start", async () => {
  const loginItem = memoryLoginItem();
  const dir = home();
  const first = await start({ home: dir, loginItem });
  await first.service.stop();
  loginItem.holdOther(THEIRS);
  const second = await start({ home: dir, host: first.host, loginItem });
  expect((await snapshot(second.service, await openApp(second.service))).service.atLogin).toEqual({
    other: THEIRS,
  });
});

test("a registration removed while the service was stopped is made again at the next start", async () => {
  const loginItem = memoryLoginItem();
  const dir = home();
  const first = await start({ home: dir, loginItem });
  await first.service.stop();
  await loginItem.unregister();
  const second = await start({ home: dir, host: first.host, loginItem });
  expect((await snapshot(second.service, await openApp(second.service))).service.atLogin).toBe("this");
  expect(await loginItem.held()).toBe("this");
});

test("this install's registration written by an older template is this one's, and a start writes it again (ADR 0068)", async () => {
  const dir = home();
  const config = join(dir, "xdg");
  mkdirSync(join(config, "autostart"), { recursive: true });
  const file = join(config, "autostart", "lookover.desktop");
  writeFileSync(file, '[Desktop Entry]\r\nName=Old Lookover\r\nExec="/usr/bin/lookover" "start"\r\n');
  const loginItem = xdgLoginItem(["/usr/bin/lookover", "start"], {
    home: dir,
    env: { XDG_CONFIG_HOME: config },
  });
  const { service } = await start({ loginItem });
  expect((await snapshot(service, await openApp(service))).service.atLogin).toBe("this");
  expect(readFileSync(file, "utf8")).toContain("Name=Lookover\nExec=");
});
