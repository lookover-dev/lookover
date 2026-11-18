// The tray's words read off the service's own snapshot (ADR 0105 §9), on fakes only: the service imports them from
// `@lookover/web/tray`, the pill's view-model, so a pause the service holds is said in the app's words.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import type { State } from "@lookover/contracts";
import { trayView } from "@lookover/web/tray";
import {
  fakeEngines,
  openApp,
  post,
  snapshot,
  start,
  stopAll,
  TEST_LIMIT_MS,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

test("the tray says the service's pause as the app does, and offers Resume", async () => {
  const engines = fakeEngines();
  engines.setHealth("codex", { installed: true, version: "0.162.1", signedIn: true });
  const { service } = await start({ engines });
  const cookie = await openApp(service);
  const before: State = await snapshot(service, cookie);
  expect(trayView(before)).toMatchObject({ state: "idle", line: "All good", paused: false });

  expect((await post(service, cookie, { type: "service.pause", for: "forever" })).status).toBe(200);
  const after: State = await snapshot(service, cookie);
  expect(trayView(after)).toEqual({
    state: "paused",
    tooltip: "Lookover: Paused until you resume",
    line: "Paused until you resume",
    paused: true,
  });
});
