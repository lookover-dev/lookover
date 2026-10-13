// The keychain port (ADR 0053): the bound every real call goes through, on the fake keychain and timers moved by
// hand. The real adapter over the OS keychain is checked live only (`bun run live`), never here.
import { expect, test } from "bun:test";
import { boundedKeychain, type Keychain, KeychainUnavailable, memoryKeychain, type Timers } from "./index.ts";

/** Timers moved by hand: what is waiting, for how long, and whether it was cancelled. */
function handTimers() {
  const waits: { ms: number; fire: () => void; cancelled: boolean }[] = [];
  const timers: Timers = {
    after: (ms, fire) => {
      const wait = { ms, fire, cancelled: false };
      waits.push(wait);
      return () => {
        wait.cancelled = true;
      };
    },
    now: () => 0,
  };
  return { timers, waits };
}

test("an answer in time passes through, and its wait is cancelled", async () => {
  const { timers, waits } = handTimers();
  const keychain = boundedKeychain(memoryKeychain(), timers);
  await keychain.set("lookover-dev-1", "data key");
  expect(await keychain.get("lookover-dev-1")).toBe("data key");
  expect(await keychain.get("lookover-dev-2")).toBeNull();
  expect(await keychain.delete("lookover-dev-1")).toBe(true);
  expect(waits.map((w) => [w.ms, w.cancelled])).toEqual([
    [5_000, true],
    [5_000, true],
    [5_000, true],
    [5_000, true],
  ]);
});

test("no answer within the bound is refused as unavailable", async () => {
  const { timers, waits } = handTimers();
  const never = () => new Promise<never>(() => {});
  const silent: Keychain = { get: never, set: never, delete: never };
  const asked = boundedKeychain(silent, timers, 2_000).get("lookover-dev-1");
  expect(waits.map((w) => w.ms)).toEqual([2_000]);
  waits[0]?.fire();
  await expect(asked).rejects.toThrow(new KeychainUnavailable("no answer in 2000 ms"));
});

test("a keychain that fails is refused as unavailable", async () => {
  const { timers } = handTimers();
  const failing: Keychain = {
    get: () => Promise.reject(new Error("Credential Manager is locked")),
    set: () => Promise.reject(new Error("no Secret Service")),
    delete: () => Promise.reject(new Error("locked")),
  };
  const keychain = boundedKeychain(failing, timers);
  await expect(keychain.get("x")).rejects.toBeInstanceOf(KeychainUnavailable);
  await expect(keychain.set("x", "y")).rejects.toThrow("The keychain didn't answer: no Secret Service");
  await expect(memoryKeychain({ refuse: true }).get("x")).rejects.toBeInstanceOf(KeychainUnavailable);
});

test("a keychain that throws instead of answering is refused as unavailable, and its wait is cancelled", async () => {
  const { timers, waits } = handTimers();
  const throws = () => {
    throw new Error("no Secret Service on this bus");
  };
  const keychain = boundedKeychain({ get: throws, set: throws, delete: throws }, timers);
  await expect(keychain.get("x")).rejects.toThrow(new KeychainUnavailable("no Secret Service on this bus"));
  expect(waits.map((w) => w.cancelled)).toEqual([true]);
});

test("a secret set after its bound passed is removed when it lands: no entry is left behind", async () => {
  const { timers, waits } = handTimers();
  const held = memoryKeychain();
  const late = Promise.withResolvers<void>();
  const slow: Keychain = { ...held, set: (name, value) => late.promise.then(() => held.set(name, value)) };
  const asked = boundedKeychain(slow, timers).set("lookover-dev-1", "data key");
  waits[0]?.fire();
  await expect(asked).rejects.toBeInstanceOf(KeychainUnavailable);
  late.resolve();
  await Bun.sleep(0);
  expect(held.names()).toEqual([]);
});
