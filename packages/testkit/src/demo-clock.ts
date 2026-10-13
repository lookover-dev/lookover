// The demo clock (ADR 0046): the service's `Clock` and, structurally, its `Timers` (`after(ms, fire)` giving a
// cancel, as `apps/service/src/timers.ts` declares; it is not imported: testkit knows no service). One clock per
// engine room: every wait of the service goes through it, so moving it fires the ticks, the poll, a pause's end
// and the fakes' durations in order, and a test or the demo driver never waits on the wall clock (gotchas).
// It stands still (time moves only by `advance` and `step`: the same script gives the same events every time) or
// flows with the real time at a speed (`set(true, speed)`): one real timeout at most is armed, for the earliest
// timer, and re-armed whenever the timers or the speed change. The real time it follows is a `Wall` it is given,
// so a test of the flow moves it by hand; the process's own by default.
import type { Clock } from "@lookover/contracts";

/** The real time a flowing clock follows: a monotonic now, in milliseconds, and one real timeout. */
export interface Wall {
  now(): number;
  /** Calls `fire` once `ms` real milliseconds have passed; the function returned cancels it. */
  after(ms: number, fire: () => void): () => void;
}

const REAL_WALL: Wall = {
  now: () => performance.now(),
  after: (ms, fire) => {
    const timer = setTimeout(fire, ms);
    return () => clearTimeout(timer);
  },
};

export interface DemoClockOptions {
  /** Where the clock starts, in milliseconds since the Unix epoch. The real time when not given. */
  at?: number;
  /** Whether it flows with the real time from the start. Standing still by default. */
  running?: boolean;
  /** How many of its milliseconds pass per real one while it flows. 1 by default. */
  speed?: number;
  /** The real time it follows while flowing. The process's own by default. */
  wall?: Wall;
}

/** A timer armed on the clock: when it is due, and what to call then. */
interface Armed {
  due: number;
  fire: () => void;
}

/** What lets the work a timer started settle: every pending promise reaction runs before the next macrotask. */
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * The clock and the timers of one engine room. Standing still, `now` changes only with `advance` and `step`;
 * flowing, it follows the real time at `speed`, and the timers fire by themselves when their time comes.
 */
export class DemoClock implements Clock {
  private readonly wall: Wall;
  /** The clock's time when it was last folded, and the real time then: `now` counts on from the pair. */
  private base: number;
  private foldedAt: number;
  private flowing: boolean;
  private rate: number;
  /** While `advance` moves time by hand, the flow is held: `now` is exactly where the move put it. */
  private held = false;
  private armed: Armed[] = [];
  private cancelReal: (() => void) | null = null;

  constructor(options: DemoClockOptions = {}) {
    this.wall = options.wall ?? REAL_WALL;
    this.base = options.at ?? Date.now();
    this.foldedAt = this.wall.now();
    this.flowing = options.running ?? false;
    this.rate = options.speed ?? 1;
    this.checkSpeed(this.rate);
    this.arm();
  }

  /** Whether the clock flows with the real time. */
  get running(): boolean {
    return this.flowing;
  }

  /** How many of its milliseconds pass per real one while it flows. */
  get speed(): number {
    return this.rate;
  }

  now = (): number => {
    if (!this.flowing || this.held) return this.base;
    return Math.floor(this.base + (this.wall.now() - this.foldedAt) * this.rate);
  };

  /** Calls `fire` once `ms` have passed on this clock; the function returned cancels it. */
  after = (ms: number, fire: () => void): (() => void) => {
    const timer: Armed = { due: this.now() + ms, fire };
    this.armed.push(timer);
    this.arm();
    return () => {
      this.armed = this.armed.filter((t) => t !== timer);
      this.arm();
    };
  };

  /** Flows with the real time at `speed` (its milliseconds per real one, above zero), or stands still. */
  set(running: boolean, speed: number): void {
    this.checkSpeed(speed);
    this.fold();
    this.flowing = running;
    this.rate = speed;
    this.arm();
  }

  /**
   * Moves time on by `ms`, firing every timer that falls due, in order, each at its own time. Before each timer
   * and at the end, the in-memory work already started settles (an awaited answer from a fake, a timer armed
   * again once it came): with a poll that re-arms itself every 10 s, `advance(60_000)` fires it six times.
   * Work that waits on real I/O (a socket, a process) is not waited for. A flowing clock goes on from where the
   * move put it; a timer already past when the move starts (the real time reached it, its tick has not run yet)
   * fires at the time reached, never earlier: `now` never goes back on what a callback or a caller saw.
   */
  async advance(ms: number): Promise<void> {
    this.fold();
    this.held = true;
    this.disarm();
    const until = this.base + ms;
    try {
      for (;;) {
        await settled();
        const next = this.earliest(until);
        if (!next) break;
        this.armed = this.armed.filter((t) => t !== next);
        this.base = Math.max(this.base, next.due);
        next.fire();
      }
      this.base = until;
    } finally {
      this.foldedAt = this.wall.now();
      this.held = false;
      this.arm();
    }
  }

  /** How far the next timer is, in milliseconds on this clock (never below zero); null when none is armed. */
  next(): number | null {
    const first = this.earliest(Number.POSITIVE_INFINITY);
    return first ? Math.max(0, first.due - this.now()) : null;
  }

  /** Advances to the next timer and fires it (and every one due at the same time). False when none is armed. */
  async step(): Promise<boolean> {
    const distance = this.next();
    if (distance === null) return false;
    await this.advance(distance);
    return true;
  }

  /** Drops every armed timer: nothing fires until a new one is armed. The time, and the flow, stay. */
  stop(): void {
    this.armed = [];
    this.disarm();
  }

  /** The earliest timer due at or before `until`, when there is one. */
  private earliest(until: number): Armed | undefined {
    return this.armed.filter((t) => t.due <= until).sort((a, b) => a.due - b.due)[0];
  }

  /** Counts the time that flowed so far into `base`, so a change of speed or flow starts from now. */
  private fold(): void {
    this.base = this.now();
    this.foldedAt = this.wall.now();
  }

  /** One real timeout for the earliest timer while the clock flows; none otherwise. */
  private arm(): void {
    this.disarm();
    if (!this.flowing || this.held) return;
    const first = this.earliest(Number.POSITIVE_INFINITY);
    if (!first) return;
    const real = Math.max(0, (first.due - this.now()) / this.rate);
    this.cancelReal = this.wall.after(real, () => {
      this.cancelReal = null;
      this.fireDue();
    });
  }

  private disarm(): void {
    this.cancelReal?.();
    this.cancelReal = null;
  }

  /**
   * The real time reached a timer: fires the earliest one due, then arms the next, at once (a real timeout of
   * zero) when it is due too, so one timer fires per real tick and the work the first started settles before
   * the second, as with `advance` and with real `setTimeout`.
   */
  private fireDue(): void {
    const next = this.earliest(this.now());
    if (next) {
      this.armed = this.armed.filter((t) => t !== next);
      next.fire();
    }
    this.arm();
  }

  private checkSpeed(speed: number): void {
    if (!(speed > 0) || !Number.isFinite(speed))
      throw new Error(`A clock's speed is above zero, not ${speed}`);
  }
}
