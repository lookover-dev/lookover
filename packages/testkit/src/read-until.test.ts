import { describe, expect, test } from "bun:test";
import { holds, LIVE_SHOWN_MS, readUntil } from "./index.ts";

/** The test's own time: `sleep` moves `now` and records each pause; nothing really waits. */
function heldTime() {
  let at = 0;
  const pauses: number[] = [];
  const lines: string[] = [];
  return {
    pauses,
    lines,
    now: () => at,
    sleep: (ms: number) => {
      pauses.push(ms);
      at += ms;
      return Promise.resolve();
    },
    log: (line: string) => {
      lines.push(line);
    },
  };
}

/** A read that answers each of `answers` in turn, then the last one again, counting its calls. */
function reads<T>(first: T, ...later: T[]) {
  const answers = [first, ...later];
  let calls = 0;
  return {
    calls: () => calls,
    read: () => Promise.resolve(answers[Math.min(calls++, answers.length - 1)] ?? first),
  };
}

describe("readUntil: reads until GitHub shows a write", () => {
  test("a read that shows the write at the third read returns it, after two pauses, saying nothing", async () => {
    const time = heldTime();
    const read = reads(["stale"], ["stale"], ["stale", "new"]);
    const shown = await readUntil(read.read, (r) => r.includes("new"), "the new check", {
      boundMs: 30_000,
      ...time,
    });
    expect(shown).toEqual(["stale", "new"]);
    expect(read.calls()).toBe(3);
    expect(time.pauses).toEqual([1_000, 1_000]);
    expect(time.lines).toEqual([]);
  });

  test("a read that never shows it returns the last read once the bound runs out, and says so once", async () => {
    const time = heldTime();
    const read = reads(["stale"]);
    const last = await readUntil(read.read, (r) => r.includes("new"), "the new check", {
      boundMs: 3_000,
      pauseMs: 1_000,
      ...time,
    });
    expect(last).toEqual(["stale"]);
    expect(read.calls()).toBe(4);
    expect(time.now()).toBe(3_000);
    expect(time.lines).toEqual(["GitHub didn't show the new check within 3 s"]);
  });

  test("the last pause stops at the bound: no read comes after it", async () => {
    const time = heldTime();
    const read = reads(0);
    await readUntil(read.read, (n) => n > 0, "a count", { boundMs: 2_500, pauseMs: 1_000, ...time });
    expect(time.pauses).toEqual([1_000, 1_000, 500]);
    expect(read.calls()).toBe(4);
  });

  test("bound 0 reads once, never pauses and says nothing: a fake shows a write on the next read", async () => {
    const time = heldTime();
    const read = reads("stale", "new");
    expect(await readUntil(read.read, (r) => r === "new", "the new check", { boundMs: 0, ...time })).toBe(
      "stale",
    );
    expect(read.calls()).toBe(1);
    expect(time.pauses).toEqual([]);
    expect(time.lines).toEqual([]);
  });

  test("a read that throws is not read again: its error goes up", async () => {
    const time = heldTime();
    let calls = 0;
    const failing = () => {
      calls++;
      return Promise.reject(new Error("GitHub refused"));
    };
    await expect(
      readUntil(failing, () => true, "the new check", { boundMs: 30_000, ...time }),
    ).rejects.toThrow("GitHub refused");
    expect(calls).toBe(1);
    expect(time.lines).toEqual([]);
  });

  test("the live bound is the push wait's 30 s (spike 03)", () => {
    expect(LIVE_SHOWN_MS).toBe(30_000);
  });
});

describe("holds: the checks that follow a wait, as its predicate", () => {
  const even = (n: number) => {
    if (n % 2 !== 0) throw new RangeError(`${n} is odd`);
  };

  test("true when the checks pass, false when one throws", () => {
    expect(holds(even)(2)).toBe(true);
    expect(holds(even)(3)).toBe(false);
  });

  test("an error that is no failed check goes up", () => {
    const failed = (error: unknown) => error instanceof RangeError;
    expect(holds(even, failed)(3)).toBe(false);
    const broken = () => {
      throw new TypeError("no result");
    };
    expect(() => holds(broken, failed)(2)).toThrow("no result");
  });
});
