import { describe, expect, test } from "bun:test";
import { DemoClock, type Wall } from "./index.ts";

/** 2026-10-06 08:52 UTC: where the clock starts. */
const T0 = Date.UTC(2026, 9, 6, 8, 52);

/** The real time, moved by hand: what a flowing demo clock follows, under the test's control. */
class HeldWall implements Wall {
  private at = 1_000;
  private armed: { due: number; fire: () => void }[] = [];
  now = () => this.at;
  after = (ms: number, fire: () => void) => {
    const timer = { due: this.at + ms, fire };
    this.armed.push(timer);
    return () => {
      this.armed = this.armed.filter((t) => t !== timer);
    };
  };
  /** The real time passes: every real timeout that falls due fires, in order; one already past, now (never earlier). */
  passes(ms: number): void {
    const until = this.at + ms;
    for (;;) {
      const next = this.armed.filter((t) => t.due <= until).sort((a, b) => a.due - b.due)[0];
      if (!next) break;
      this.armed = this.armed.filter((t) => t !== next);
      this.at = Math.max(this.at, next.due);
      next.fire();
    }
    this.at = until;
  }
  /** The real time passes while the event loop is busy: a real timeout that fell due does not fire yet. */
  slips(ms: number): void {
    this.at += ms;
  }
  /** How many real timeouts are pending. */
  pending(): number {
    return this.armed.length;
  }
}

describe("DemoClock flowing with real time", () => {
  test("running at a speed, now follows the real time multiplied, and set(false) holds it", () => {
    const wall = new HeldWall();
    const clock = new DemoClock({ at: T0, wall, running: true, speed: 60 });
    expect(clock.running).toBe(true);
    expect(clock.speed).toBe(60);

    wall.passes(1_000);
    expect(clock.now()).toBe(T0 + 60_000);

    clock.set(false, 60);
    wall.passes(1_000);
    expect(clock.now()).toBe(T0 + 60_000);

    clock.set(true, 1);
    wall.passes(1_000);
    expect(clock.now()).toBe(T0 + 61_000);
  });

  test("a timer fires by itself once the real time reaches its due at the speed, in order; cancelled, never", () => {
    const wall = new HeldWall();
    const clock = new DemoClock({ at: T0, wall, running: true, speed: 10 });
    const fired: string[] = [];
    clock.after(30_000, () => fired.push(`b at ${clock.now() - T0}`));
    clock.after(10_000, () => fired.push(`a at ${clock.now() - T0}`));
    const cancel = clock.after(20_000, () => fired.push("never"));
    cancel();

    wall.passes(999);
    expect(fired).toEqual([]);
    wall.passes(1);
    expect(fired).toEqual(["a at 10000"]);
    wall.passes(5_000);
    expect(fired).toEqual(["a at 10000", "b at 30000"]);
    // One real timeout at most, for the earliest timer; none once every timer fired.
    expect(wall.pending()).toBe(0);
  });

  test("a timer armed while standing still waits; set running, it fires when the real time reaches it; stopped, it never does", () => {
    const wall = new HeldWall();
    const clock = new DemoClock({ at: T0, wall });
    let fired = 0;
    clock.after(2_000, () => {
      fired += 1;
    });
    wall.passes(10_000);
    expect(fired).toBe(0);
    expect(wall.pending()).toBe(0);

    clock.set(true, 1);
    wall.passes(1_999);
    expect(fired).toBe(0);
    wall.passes(1);
    expect(fired).toBe(1);

    clock.after(1_000, () => {
      fired += 1;
    });
    clock.stop();
    wall.passes(5_000);
    expect(fired).toBe(1);
    expect(wall.pending()).toBe(0);
  });

  test("two timers due at the same instant fire on two real ticks: the work the first started settles before the second", async () => {
    // On the process's own wall: a thousand of the clock's milliseconds per real one, so the whole test is a few
    // real ticks, and it ends on a timer of the clock's, never on a fixed wait.
    const clock = new DemoClock({ at: T0, running: true, speed: 1_000 });
    const seen: string[] = [];
    clock.after(1_000, () => {
      void Promise.resolve().then(() => seen.push("first's work"));
    });
    clock.after(1_000, () => seen.push("second"));

    await new Promise<void>((resolve) => clock.after(2_000, resolve));

    expect(seen).toEqual(["first's work", "second"]);
  });

  test("advance while running jumps ahead of the real time and fires what fell due; the flow goes on from there", async () => {
    const wall = new HeldWall();
    const clock = new DemoClock({ at: T0, wall, running: true, speed: 1 });
    const fired: number[] = [];
    clock.after(5_000, () => fired.push(clock.now() - T0));
    clock.after(8_000, () => fired.push(clock.now() - T0));

    await clock.advance(6_000);

    expect(fired).toEqual([5_000]);
    expect(clock.now()).toBe(T0 + 6_000);
    wall.passes(2_000);
    expect(fired).toEqual([5_000, 8_000]);
    expect(clock.now()).toBe(T0 + 8_000);
  });

  test("advance with a timer already past (its real tick came late) fires it at the time reached, never earlier, in order", async () => {
    const wall = new HeldWall();
    const clock = new DemoClock({ at: T0, wall, running: true, speed: 1 });
    const fired: string[] = [];
    clock.after(10_000, () => fired.push(`a at ${clock.now() - T0}`));
    clock.after(15_000, () => fired.push(`b at ${clock.now() - T0}`));
    clock.after(25_000, () => fired.push(`c at ${clock.now() - T0}`));

    // The event loop was busy: 20 s passed and the real tick for `a` has not run; 20 s is already observed.
    wall.slips(20_000);
    expect(clock.now()).toBe(T0 + 20_000);

    await clock.advance(3_000);

    expect(fired).toEqual(["a at 20000", "b at 20000"]);
    expect(clock.now()).toBe(T0 + 23_000);
    wall.passes(2_000);
    expect(fired).toEqual(["a at 20000", "b at 20000", "c at 25000"]);
  });

  test("a real tick that comes late fires the timers past, each at the time reached, in order, one per tick", () => {
    const wall = new HeldWall();
    const clock = new DemoClock({ at: T0, wall, running: true, speed: 1 });
    const fired: string[] = [];
    clock.after(10_000, () => fired.push(`a at ${clock.now() - T0}`));
    clock.after(15_000, () => fired.push(`b at ${clock.now() - T0}`));

    wall.slips(20_000);
    wall.passes(0);

    expect(fired).toEqual(["a at 20000", "b at 20000"]);
    expect(wall.pending()).toBe(0);
  });
});

describe("DemoClock standing still", () => {
  test("starts at the given instant and stays there until advanced", async () => {
    const clock = new DemoClock({ at: T0 });
    expect(clock.now()).toBe(T0);
    await clock.advance(60_000);
    expect(clock.now()).toBe(T0 + 60_000);
  });

  test("advance fires every timer that falls due, in order, each at its own time, and a cancelled one never", async () => {
    const clock = new DemoClock({ at: T0 });
    const fired: string[] = [];
    clock.after(3_000, () => fired.push(`c at ${clock.now() - T0}`));
    clock.after(1_000, () => fired.push(`a at ${clock.now() - T0}`));
    const cancel = clock.after(2_000, () => fired.push("b"));
    clock.after(10_000, () => fired.push("late"));
    cancel();

    await clock.advance(5_000);

    expect(fired).toEqual(["a at 1000", "c at 3000"]);
    expect(clock.now()).toBe(T0 + 5_000);
  });

  test("a timer that re-arms itself fires again within the same advance: a 10 s poll fires six times over a minute", async () => {
    const clock = new DemoClock({ at: T0 });
    let polls = 0;
    const poll = () => {
      polls += 1;
      clock.after(10_000, poll);
    };
    clock.after(10_000, poll);

    await clock.advance(60_000);

    expect(polls).toBe(6);
  });

  test("a timer that re-arms itself only after awaited work (the poll awaiting its listing) still fires six times over a minute", async () => {
    const clock = new DemoClock({ at: T0 });
    let polls = 0;
    const poll = async () => {
      polls += 1;
      await Promise.resolve();
      await Promise.resolve();
      clock.after(10_000, () => void poll());
    };
    clock.after(10_000, () => void poll());

    await clock.advance(60_000);

    expect(polls).toBe(6);
  });

  test("next is the distance to the earliest timer, null when none is armed; step jumps to it and fires it", async () => {
    const clock = new DemoClock({ at: T0 });
    expect(clock.next()).toBeNull();
    const fired: string[] = [];
    clock.after(5_000, () => fired.push("later"));
    clock.after(2_000, () => fired.push("soon"));
    expect(clock.next()).toBe(2_000);

    expect(await clock.step()).toBe(true);

    expect(fired).toEqual(["soon"]);
    expect(clock.now()).toBe(T0 + 2_000);
    expect(clock.next()).toBe(3_000);
    expect(await clock.step()).toBe(true);
    expect(fired).toEqual(["soon", "later"]);
    expect(await clock.step()).toBe(false);
    expect(clock.now()).toBe(T0 + 5_000);
  });

  test("stop drops every armed timer: nothing fires, and time still moves", async () => {
    const clock = new DemoClock({ at: T0 });
    let fired = 0;
    clock.after(1_000, () => {
      fired += 1;
    });
    clock.stop();

    await clock.advance(10_000);

    expect(fired).toBe(0);
    expect(clock.next()).toBeNull();
    expect(clock.now()).toBe(T0 + 10_000);
  });

  test("work a timer started settles before the next one fires", async () => {
    const clock = new DemoClock({ at: T0 });
    const seen: string[] = [];
    clock.after(1_000, () => {
      void Promise.resolve().then(() => seen.push("first's work"));
    });
    clock.after(2_000, () => seen.push("second"));

    await clock.advance(2_000);

    expect(seen).toEqual(["first's work", "second"]);
  });
});
