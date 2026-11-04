// A service started in-process (`bun run live`'s) held on its data folder as the program holds one: the instance lock
// taken, `instance.json` announcing it, both let go at its stop, so `lookover open --home` and `status --home` reach it.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type HeldServiceOptions,
  heldLines,
  heldService,
  probeInstance,
  type RunningService,
  servingOf,
  takeInstance,
} from "./index.ts";

const homes: string[] = [];
const newHome = () => {
  const made = mkdtempSync(join(realpathSync.native(tmpdir()), "lookover-held-"));
  homes.push(made);
  return made;
};

afterEach(() => {
  for (const home of homes.splice(0)) {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EBUSY")) throw error;
    }
  }
});

/** A stand-in for `startService`: an origin on `port`, a link, and a stop it counts. */
const standIn = (port: number, stops: { count: number }) => async (): Promise<RunningService> => ({
  origin: `http://127.0.0.1:${port}`,
  port,
  openUrl: `http://127.0.0.1:${port}/?t=once`,
  stop: async () => {
    stops.count += 1;
  },
});

/** `heldService` on `home` with the stand-in on `port`, whatever `more` sets in place of the rest. */
const held = (home: string, port: number, stops: { count: number }, more: Partial<HeldServiceOptions> = {}) =>
  heldService({
    home,
    pid: 4242,
    clock: { now: () => 1_000 },
    userOnly: async () => {},
    start: standIn(port, stops),
    ...more,
  });

test("a held service holds its folder and announces its address; its stop lets both go, and a second start announces again", async () => {
  const home = newHome();
  const stops = { count: 0 };
  const first = await held(home, 5001, stops);
  expect(probeInstance(home)).toBe("held");
  expect(servingOf(home)).toEqual({
    pid: 4242,
    port: 5001,
    address: "http://127.0.0.1:5001",
    version: expect.any(String),
    since: 1_000,
  });

  await first.stop();
  expect(stops.count).toBe(1);
  expect(probeInstance(home)).toBe("free");

  const second = await held(home, 5002, stops);
  expect(probeInstance(home)).toBe("held");
  expect(servingOf(home)?.address).toBe("http://127.0.0.1:5002");
  await second.stop();
  expect(probeInstance(home)).toBe("free");
});

test("a folder another service holds starts nothing", async () => {
  const home = newHome();
  const other = takeInstance(home, async () => {});
  let started = false;
  await expect(
    held(
      home,
      5001,
      { count: 0 },
      {
        start: async () => {
          started = true;
          throw new Error("never");
        },
      },
    ),
  ).rejects.toThrow("Another Lookover runs on this data folder");
  expect(started).toBe(false);
  other.release();
});

test("a start that fails leaves the folder free", async () => {
  const home = newHome();
  await expect(
    held(
      home,
      5001,
      { count: 0 },
      {
        start: async () => {
          throw new Error("no claude");
        },
      },
    ),
  ).rejects.toThrow("no claude");
  expect(probeInstance(home)).toBe("free");
});

test("an announce that fails, then a stop that throws, still leaves the folder free", async () => {
  const home = newHome();
  await expect(
    held(
      home,
      5001,
      { count: 0 },
      {
        userOnly: async () => {
          throw new Error("no user-only");
        },
        start: async () => ({
          ...(await standIn(5001, { count: 0 })()),
          stop: async () => {
            throw new Error("stuck");
          },
        }),
      },
    ),
  ).rejects.toThrow("no user-only");
  expect(probeInstance(home)).toBe("free");
});

test("a stop asked through the service (`lookover stop`) stops it once, lets the folder go and says so", async () => {
  const home = newHome();
  const stops = { count: 0 };
  let asked: (() => void) | undefined;
  const told: Promise<void>[] = [];
  const service = await held(home, 5001, stops, {
    start: async (stopAsked) => {
      asked = stopAsked;
      return standIn(5001, stops)();
    },
    stopAsked: (stopped) => {
      told.push(stopped);
    },
  });
  expect(probeInstance(home)).toBe("held");

  asked?.();
  expect(told).toHaveLength(1);
  await told[0];
  expect(stops.count).toBe(1);
  expect(probeInstance(home)).toBe("free");

  // The run's own cleanup stops it again: nothing more is stopped.
  await service.stop();
  expect(stops.count).toBe(1);
});

test("instance.json is made user-only before it is put in place", async () => {
  const home = newHome();
  const madeUserOnly: string[] = [];
  const service = await held(
    home,
    5001,
    { count: 0 },
    {
      userOnly: async (path) => {
        madeUserOnly.push(path);
      },
    },
  );
  expect(madeUserOnly).toEqual([`${join(home, "instance.json")}.${process.pid}.tmp`]);
  await service.stop();
});

test("its lines name the address, the folder and the one-time link", () => {
  const lines = heldLines(
    { origin: "http://127.0.0.1:5001", openUrl: "http://127.0.0.1:5001/?t=once" },
    "/runs/1",
  );
  expect(lines).toEqual([
    "service: http://127.0.0.1:5001 on /runs/1",
    "Open the app: http://127.0.0.1:5001/?t=once",
  ]);
});
