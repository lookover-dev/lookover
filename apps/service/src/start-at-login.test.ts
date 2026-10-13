// Start at login through the service, on the fake `LoginItem` (ADR 0054): the choice on by default, the registration
// made to match it once the setup is done (at start, at the setup's finish, on each `service.startAtLogin`), never
// before, and a registration the machine refuses refusing the command with its reason, the choice kept as it was.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import type { Setup } from "@lookover/contracts";
import { memoryLoginItem } from "./index.ts";
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
  expect(state.service).toMatchObject({ startAtLogin: true, startsAtLogin: true });
  expect(await loginItem.registered()).toBe(true);
});

test("never registered before the setup is done; registered once it is, as the choice says", async () => {
  const loginItem = memoryLoginItem();
  const { service } = await start({ loginItem, setup: LAST_STEP });
  const cookie = await openApp(service);
  expect((await snapshot(service, cookie)).service).toMatchObject({
    startAtLogin: true,
    startsAtLogin: false,
  });
  expect(await loginItem.registered()).toBe(false);
  // Chosen during the setup: kept, still nothing registered.
  expect((await post(service, cookie, { type: "service.startAtLogin", on: false })).status).toBe(200);
  expect((await post(service, cookie, { type: "service.startAtLogin", on: true })).status).toBe(200);
  expect(await loginItem.registered()).toBe(false);

  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await post(service, cookie, { type: "setup.finish" })).status).toBe(200);
  expect(await until(stream, "service.changed")).toContainEqual(
    expect.objectContaining({ type: "service.changed", patch: { startsAtLogin: true } }),
  );
  expect(await loginItem.registered()).toBe(true);
});

test("a setup finished with start at login turned off registers nothing", async () => {
  const loginItem = memoryLoginItem();
  const { service } = await start({ loginItem, setup: LAST_STEP });
  const cookie = await openApp(service);
  expect((await post(service, cookie, { type: "service.startAtLogin", on: false })).status).toBe(200);
  expect((await post(service, cookie, { type: "setup.finish" })).status).toBe(200);
  expect((await snapshot(service, cookie)).setup.done).toBe(true);
  expect(await loginItem.registered()).toBe(false);
  expect((await snapshot(service, cookie)).service.startsAtLogin).toBe(false);
});

test("turned off, the registration is removed and both are sent; turned on again, it is back", async () => {
  const loginItem = memoryLoginItem();
  const { service } = await start({ loginItem });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await post(service, cookie, { type: "service.startAtLogin", on: false })).status).toBe(200);
  expect(await loginItem.registered()).toBe(false);
  const sent = await until(stream, "service.changed");
  expect(sent).toContainEqual(
    expect.objectContaining({ type: "service.changed", patch: { startAtLogin: false } }),
  );
  expect((await snapshot(service, cookie)).service).toMatchObject({
    startAtLogin: false,
    startsAtLogin: false,
  });

  expect((await post(service, cookie, { type: "service.startAtLogin", on: true })).status).toBe(200);
  expect(await loginItem.registered()).toBe(true);
  expect((await snapshot(service, cookie)).service).toMatchObject({
    startAtLogin: true,
    startsAtLogin: true,
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
    startsAtLogin: true,
  });
  await first.service.stop();
  // The choice kept is the one before: the next start keeps it, and registers it.
  loginItem.refuse(null);
  await loginItem.unregister();
  const second = await start({ home: dir, host: first.host, loginItem });
  expect((await snapshot(second.service, await openApp(second.service))).service).toMatchObject({
    startAtLogin: true,
    startsAtLogin: true,
  });
  expect(await loginItem.registered()).toBe(true);
});

test("a start the machine refuses to register starts all the same, says it isn't registered and logs why", async () => {
  const loginItem = memoryLoginItem();
  loginItem.refuse("Access is denied.");
  const logged: string[] = [];
  const { service } = await start({ loginItem, log: (line) => logged.push(line) });
  expect((await snapshot(service, await openApp(service))).service).toMatchObject({
    startAtLogin: true,
    startsAtLogin: false,
  });
  expect(logged).toContain("Lookover couldn't register its start at login: Access is denied.");
});

test("a registration removed while the service was stopped is made again at the next start", async () => {
  const loginItem = memoryLoginItem();
  const dir = home();
  const first = await start({ home: dir, loginItem });
  await first.service.stop();
  await loginItem.unregister();
  const second = await start({ home: dir, host: first.host, loginItem });
  expect((await snapshot(second.service, await openApp(second.service))).service.startsAtLogin).toBe(true);
  expect(await loginItem.registered()).toBe(true);
});
