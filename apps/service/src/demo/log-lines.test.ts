// The log file's lines on the scripted fakes (ADR 0055, "The log file says what the service did"): S3, S8 and S14
// played through the drawer's door, and the room's log read for what each review did. Written by hand from the stories.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { scenarioOf } from "../index.ts";
import { TEST_LIMIT_MS } from "../service.test-support.ts";
import { advance, inject, load, send, startScenario, stopAll } from "./demo.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);

const MIN = 60_000;

let door: Awaited<ReturnType<typeof startScenario>>;
beforeAll(async () => {
  door = await startScenario(scenarioOf("S10"));
});
afterAll(stopAll);

/** Loads `scenario`, the room's log emptied first: what its seed and what follows write. */
async function loaded(scenario: string): Promise<void> {
  door.logged.length = 0;
  expect((await load(door, scenario)).status).toBe(200);
}

/** The lines about a change or an engine, in order. */
const about = (subject: string) => door.logged.filter((line) => line.startsWith(subject));

test("S3: #151 queued and started, waits on Claude signed out, starts again once signed in, round 1 posted", async () => {
  await loaded("S3");
  await advance(door, 30_000);
  await advance(door, MIN + 30_000);
  expect((await send(door, { type: "engine.signIn", id: "claude" })).status).toBe(200);
  await advance(door, 35_000);
  await advance(door, 4 * MIN);
  expect(about("ledger-api#151")).toEqual([
    "ledger-api#151 opened by sasensi: Export invoices as CSV",
    "ledger-api#151 review queued (on opening) for f6a7b8c",
    "ledger-api#151 round 1 started on f6a7b8c, standard: Claude finds, Codex double-checks",
    "ledger-api#151 review waits: Claude is signed out",
    // Taken from its wait straight to its run: the run's line says it.
    "ledger-api#151 round 1 started on f6a7b8c, standard: Claude finds, Codex double-checks",
    "ledger-api#151 round 1 posted: 1 open finding",
  ]);
  expect(about("Claude")).toEqual(["Claude is signed out", "Claude is ready"]);
});

test("S8: paused, two pull requests wait for the resume, then run one after the other and post", async () => {
  await loaded("S8");
  await advance(door, 4 * MIN);
  expect((await send(door, { type: "service.resume" })).status).toBe(200);
  await advance(door, 0);
  await advance(door, 2 * MIN);
  await advance(door, 2 * MIN);
  // Until an hour after the seed's end, in the machine's own time.
  const [paused, resumed, ...more] = about("reviews");
  expect(paused).toMatch(/^reviews paused until \d{2}:\d{2}$/);
  expect([resumed, ...more]).toEqual(["reviews resumed"]);
  expect(about("lookover-sandbox#162")).toEqual([
    "lookover-sandbox#162 opened by sasensi: Rename the sum module to totals",
    "lookover-sandbox#162 review queued (on opening) for 2e3f4a5",
    "lookover-sandbox#162 review waits: reviews are paused",
    // Resumed, it waits its turn behind #161, which holds both AIs.
    "lookover-sandbox#162 review back in the queue",
    "lookover-sandbox#162 round 1 started on 2e3f4a5, standard: Claude finds, Codex double-checks",
    "lookover-sandbox#162 round 1 posted: no open findings",
  ]);
});

test("S14: #1 left running by two restarts runs again once, then fails; the log says each", async () => {
  await loaded("S14");
  await advance(door, 5_000);
  expect(await inject(door, "login-refused")).toBe(200);
  await advance(door, 5_000);
  expect(await inject(door, "key-lost")).toBe(200);
  expect(about("lookover-sandbox#1 ")).toEqual([
    "lookover-sandbox#1 opened by sasensi: Add unpaid filter and rewrite total",
    "lookover-sandbox#1 review queued (on opening) for 703205d",
    "lookover-sandbox#1 round 1 started on 703205d, standard: Claude finds, Codex double-checks",
    "lookover-sandbox#1 review runs again: the service stopped while it ran",
    "lookover-sandbox#1 round 1 started on 703205d, standard: Claude finds, Codex double-checks",
    "lookover-sandbox#1 review failed: the service stopped before the review finished",
  ]);
});
