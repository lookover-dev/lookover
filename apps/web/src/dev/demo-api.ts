// Dev only: the developer drawer's door to the service's demo driver (ADR 0046), beside `LookoverApi` and never
// in it. The dev verbs (`demo.load`, `demo.inject`, the clock's, `refresh`) are posted where a command is; the
// listing (the scenarios, the one loaded, the clock, the faults) is read from `DEMO_API.listing`. Both travel on
// the page's own origin with the session cookie, as the app's requests do. In live mode the service answers every
// verb but `refresh` 501 and the listing 404: the drawer there sends only `refresh`. A refusal rejects with
// `Refused` (its status and the service's words); a 401 ends the session first, as the app's own requests do, so
// a verb on a spent session shows the session screen (#68). The types are contracts' `demo.ts`: the only package
// this folder may import.
import { DEMO_API, type DemoClock, type DemoCommand, type DemoListing } from "@lookover/contracts";
import { type Fetch, type Lost, postCommand, refusedBy } from "../api/http.ts";
import { duration } from "../view-model/format.ts";
import { refusalLine, refusalOf, refusalText } from "../view-model/refusal.ts";

export interface DemoApiOptions {
  /** The service's origin; empty for the page's own, the normal case. */
  base?: string;
  fetch?: Fetch;
  /**
   * Called when the service answers 401, with the command it names: the app's client ends the session
   * (`HttpApi.endSession`).
   */
  lost?: Lost;
}

export class DemoApi {
  private readonly base: string;
  private readonly fetch: Fetch;
  private readonly lost: Lost;

  constructor(options: DemoApiOptions = {}) {
    this.base = options.base ?? "";
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.lost = options.lost ?? (() => undefined);
  }

  /** The scenarios, the one loaded now, the demo clock and the faults. */
  async listing(): Promise<DemoListing> {
    const res = await this.fetch(`${this.base}${DEMO_API.listing}`, { credentials: "same-origin" });
    if (!res.ok) throw await refusedBy(res, this.lost);
    const listing: DemoListing = await res.json();
    return listing;
  }

  /** Posts a dev verb. A load answers once the new scenario's world is in; the open streams are told to reload. */
  send(command: DemoCommand): Promise<void> {
    return postCommand(this.fetch, this.base, command, this.lost);
  }
}

interface Timers {
  now(): number;
  after(ms: number, fire: () => void): () => void;
}

const browserTimers: Timers = {
  now: () => Date.now(),
  after: (ms, fire) => {
    const timer = setTimeout(fire, ms);
    return () => clearTimeout(timer);
  },
};

/**
 * Keeps the drawer's listing current without a request per event: what it lists (the scenario loaded, the clock,
 * the next timer) can change with any event, and a running clock sends many a second. A move of the app's state
 * reads it at once if the last read is a second old, else once that second is over, whatever came meanwhile; a
 * verb's answer reads it at once. Only the latest read is shown: an older one answering late is stale.
 */
export class ListingFollower {
  private last = Number.NEGATIVE_INFINITY;
  private pending: (() => void) | null = null;
  private latest = 0;
  private stopped = false;
  private readonly read: () => Promise<DemoListing>;
  private readonly show: (listing: DemoListing) => void;
  private readonly timers: Timers;
  private readonly every: number;

  constructor(
    read: () => Promise<DemoListing>,
    show: (listing: DemoListing) => void,
    timers: Timers = browserTimers,
    every = 1_000,
  ) {
    this.read = read;
    this.show = show;
    this.timers = timers;
    this.every = every;
  }

  /** The app's state moved (an event, a reload, the keepalive's clock). */
  moved(): void {
    if (this.stopped || this.pending) return;
    const wait = this.last + this.every - this.timers.now();
    if (wait <= 0) {
      this.readNow();
      return;
    }
    this.pending = this.timers.after(wait, () => {
      this.pending = null;
      this.readNow();
    });
  }

  /** A verb was answered, or the drawer opened: read at once. */
  readNow(): void {
    if (this.stopped) return;
    this.pending?.();
    this.pending = null;
    this.last = this.timers.now();
    const id = ++this.latest;
    this.read().then(
      (listing) => {
        if (id === this.latest && !this.stopped) this.show(listing);
      },
      (error: unknown) => console.error("The demo listing could not be read", error),
    );
  }

  stop(): void {
    this.stopped = true;
    this.pending?.();
    this.pending = null;
  }
}

/**
 * Demo mode's listing, followed for the app as a whole (one `ListingFollower`): the drawer and the try page show
 * it, and the app's running times read from it how fast the clock flows (ADR 0058), its `ClockPace`: the speed
 * while the clock flows, 0 while it stands still, and still until the first listing (a scenario starts on a clock
 * standing still). Read only while someone listens; the app tells it each move of its state (`moved`), with or
 * without the drawer, and a verb's answer reads it at once (`readNow`).
 */
export class DemoFeed {
  private listing: DemoListing | null = null;
  private pace = 0;
  private follower: ListingFollower | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly read: () => Promise<DemoListing>;
  private readonly timers: Timers;

  constructor(read: () => Promise<DemoListing>, timers: Timers = browserTimers) {
    this.read = read;
    this.timers = timers;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (!this.follower) {
      this.follower = new ListingFollower(this.read, this.show, this.timers);
      this.follower.readNow();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size > 0) return;
      this.follower?.stop();
      this.follower = null;
    };
  };

  /** The last listing; null until the first. */
  current = (): DemoListing | null => this.listing;

  /** The clock's pace: service milliseconds per browser millisecond. */
  get = (): number => this.pace;

  /** The app's state moved: a reason to read again, at most once a second. */
  moved = (): void => this.follower?.moved();

  /** A verb was answered: read at once. */
  readNow = (): void => this.follower?.readNow();

  private readonly show = (listing: DemoListing): void => {
    this.listing = listing;
    this.pace = listing.clock.running ? listing.clock.speed : 0;
    for (const l of this.listeners) l();
  };
}

/**
 * What the drawer says of a verb the service refused: the app's line when the view model has words for it, else
 * the title and the service's own (the drawer is a developer's tool, not the app: "no pull request open" is what
 * the developer needs to know). The console keeps the JSON.
 */
export function drawerRefusalLine(error: unknown): string {
  const refusal = refusalOf(error);
  const { title, detail } = refusalText(refusal);
  return detail || !refusal.error ? refusalLine(refusal) : `${title}: ${refusal.error}.`;
}

/**
 * The drawer's line about the next timer the service has armed, said from the tab's time (`now`, which follows
 * the service's through the keepalive): the listing's `nextIn` was true at the listing's own `now`.
 */
export function nextEventLine(clock: DemoClock, now: number): string {
  if (clock.nextIn === null) return "Nothing is scheduled. Use the app, or make something happen below.";
  const left = clock.now + clock.nextIn - now;
  if (left <= 0) return "The next event is due now.";
  return `The next event is in ${duration(left)}.`;
}
