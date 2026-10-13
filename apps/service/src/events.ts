// The live events (ADR 0038): who listens now, and the last `limit` events kept for a UI that reconnects with
// the number it saw last. The numbers themselves come from the store's sequence; this holds only the copies.
import type { Event } from "@lookover/contracts";

export class EventLog {
  private readonly limit: number;
  private kept: Event[] = [];
  private reached: number;
  /** The last number before this service started: a UI holding it or less saw another start's snapshot. */
  private readonly start: number;
  private listeners = new Set<(event: Event) => void>();
  /** Swapped out: no listener is added or told again. */
  private silenced = false;

  /** `last`: the number of the last event ever emitted, before this service started (0 for a fresh store). */
  constructor(limit: number, last: number) {
    this.limit = limit;
    this.reached = last;
    this.start = last;
  }

  /** The number of the last event, this service's or an earlier start's: where the next room numbers on from. */
  last(): number {
    return this.reached;
  }

  publish(event: Event): void {
    this.reached = event.seq;
    this.kept.push(event);
    if (this.kept.length > this.limit) this.kept = this.kept.slice(-this.limit);
    for (const l of this.listeners) l(event);
  }

  /**
   * No listener hears another event: a room swapped out (ADR 0046), whose last words as it stops would carry
   * numbers the next room gives again. Its streams are told to reload instead.
   */
  silence(): void {
    this.silenced = true;
    this.listeners.clear();
  }

  /**
   * The events after `seq`, for a UI that saw `seq` last; empty when it missed nothing. Null when the UI
   * reloads the snapshot instead: `seq` is from before this service started (what a start fixes is in no
   * event), some later events are gone from the buffer (too long away), or `seq` is past the last number
   * given (a tab left open across a data reset).
   */
  since(seq: number): Event[] | null {
    if (seq <= this.start) return null;
    if (seq === this.reached) return [];
    if (seq > this.reached) return null;
    const first = this.kept[0];
    if (!first || first.seq > seq + 1) return null;
    return this.kept.filter((e) => e.seq > seq);
  }

  subscribe(listener: (event: Event) => void): () => void {
    if (!this.silenced) this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
