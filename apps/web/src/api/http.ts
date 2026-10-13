// `LookoverApi` over HTTP (ADR 0028, ADR 0038): the snapshot from `GET /api/v1/snapshot`, events from
// `GET /api/v1/events` as server-sent events, commands as `POST /api/v1/commands`. The app is served from the
// service's origin (or a dev server proxying `/api` to it), so every request is same-origin and carries the
// session cookie; the service refuses anything else (ADR 0010). It imports only `contracts`.
// One live connection serves every listener; it opens with the first and closes with the last. The client
// remembers the last number it saw (the snapshot's, then each event's) and asks for what comes after it
// whenever it opens a connection, so nothing between the snapshot and the stream, or while the tab was
// hidden, is lost; on the browser's own reconnect, `Last-Event-ID` says the same. A `reload` message (the
// service can't replay what this tab missed: it restarted, or the tab was away too long) fetches the snapshot
// again and hands it to the listeners as a `state.replaced` event, which `apply` takes like any other; what
// arrives meanwhile waits until the snapshot is in, then follows it, and the connection is opened again after the
// snapshot's number (the old one may follow a room a scenario load swapped out). Only a visible tab holds a connection:
// a hidden one closes it and catches up when shown again (ADR 0038). A connection silent for too long (the
// service says it is alive every 15 s; a dev proxy or a sleeping laptop keeps a dead one open without a word)
// is closed and reopened with the last number, which the service answers with a replay or a reload. The
// keepalive carries the service's `now` (ADR 0046): the listeners get it as a `clock` event at the last number
// seen, which `apply` takes as the time alone and nothing stores. A refused request rejects with `Refused`: the
// status and the service's words, for the console; the UI's words come from the status. A 401 ends the session
// (`onSessionLost`, #68): the service restarted, or the link was used, and nothing is asked again; the listeners get
// the command the 401 named (`NoSession.open`, ADR 0058), or null when its body didn't say.
// The log file (ADR 0055) travels beside the events: its tail from `GET /api/v1/logs`, and each new line as a `log`
// message on the same connection, which goes to the log listeners alone, never to the event listeners or `apply`;
// the connection opens with the first listener of either kind and closes with the last. Each time it opens, the log
// listeners hear `connected`: a line written while it was closed is never sent again, so the tail is read again.
import {
  API,
  type Command,
  type Event,
  type LogMessage,
  type LookoverApi,
  SSE,
  type State,
} from "@lookover/contracts";

/**
 * What the client needs of the browser's `EventSource`, so a test can stand in for it. Besides the stream's
 * own names, `error` is listened to: the browser fires it when the connection fails, whether it will retry a
 * drop by itself or gave up on a refused response; the client closes it either way and tries again itself.
 */
export interface LiveSource {
  addEventListener(type: string, handler: (event: { data: string }) => void): void;
  close(): void;
}

/** Whether the tab is hidden, and when that changes: the browser's `document`, or a stand-in in tests. */
export interface Visibility {
  hidden(): boolean;
  onChange(listener: () => void): () => void;
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
type SourceFactory = new (url: string) => LiveSource;

/**
 * The service refused a request: the status it answered and what it said. The words are the service's own, for
 * the developer's console (coding standards); what the person reads comes from the status, in the view model.
 */
export class Refused extends Error {
  readonly status: number;
  /** The JSON the service answered, as it was; `{}` when it gave none. */
  readonly answer: unknown;
  /** The service's `error` line, when it gave one. */
  readonly reason: string | null;

  constructor(status: number, answer: unknown) {
    const reason =
      typeof answer === "object" && answer !== null && "error" in answer && typeof answer.error === "string"
        ? answer.error
        : null;
    super(`The service answered ${status}: ${reason ?? "no reason"}`);
    this.name = "Refused";
    this.status = status;
    this.answer = answer;
    this.reason = reason;
  }
}

export interface HttpApiOptions {
  /** The service's origin; empty for the page's own, the normal case. */
  base?: string;
  fetch?: Fetch;
  source?: SourceFactory;
  visibility?: Visibility;
  /** Milliseconds without a word from the service before the connection is taken for dead. Default 45 s. */
  silence?: number;
  /** Milliseconds before a connection that failed, or a reload whose snapshot failed, is tried again. Default 3 s. */
  retry?: number;
  /** The waits for `silence` and `retry`: the browser's timers, or a test's moved by hand. */
  timers?: Timers;
}

/** Calls `fire` once `ms` have passed; the function returned cancels it. */
interface Timers {
  after(ms: number, fire: () => void): () => void;
}

const browserTimers: Timers = {
  after: (ms, fire) => {
    const timer = setTimeout(fire, ms);
    return () => clearTimeout(timer);
  },
};

const documentVisibility: Visibility = {
  hidden: () => document.visibilityState === "hidden",
  onChange: (listener) => {
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
};

export class HttpApi implements LookoverApi {
  private readonly base: string;
  private readonly fetch: Fetch;
  private readonly Source: SourceFactory;
  private readonly visibility: Visibility;
  private readonly silence: number;
  private readonly retry: number;
  private readonly timers: Timers;
  private live: LiveSource | null = null;
  /** Cancels the pending new connection after one failed, or after a reload's snapshot did. */
  private retrying: (() => void) | null = null;
  /** Cancels the wait that fires when the live connection has said nothing for `silence`. */
  private quiet: (() => void) | null = null;
  /** Whether the live connection asked after a number: one opened before any is replaced once there is one. */
  private liveNumbered = false;
  /** Stops following the tab's visibility, while someone listens. */
  private watching: (() => void) | null = null;
  /** The last event number seen; null before any snapshot or event. */
  private seq: number | null = null;
  /** The events that arrive while the snapshot is fetched again; null when no reload is under way. */
  private held: Event[] | null = null;
  private listeners = new Set<(event: Event) => void>();
  private logListeners = new Set<(message: LogMessage) => void>();
  /** Whether the service answered 401: the session this tab holds is gone, and nothing is tried again. */
  private sessionLost = false;
  private lostListeners = new Set<(open: string | null) => void>();

  constructor(options: HttpApiOptions = {}) {
    this.base = options.base ?? "";
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.Source = options.source ?? EventSource;
    this.visibility = options.visibility ?? documentVisibility;
    this.silence = options.silence ?? 45_000;
    this.retry = options.retry ?? 3_000;
    this.timers = options.timers ?? browserTimers;
  }

  async snapshot(): Promise<State> {
    const state = await this.fetchSnapshot();
    // The stream may have delivered a later event while the snapshot was on its way.
    if (this.seq === null || state.seq > this.seq) this.seq = state.seq;
    // A connection opened before any number can't say where it was if the browser reconnects it by itself:
    // one that can takes its place, and the replay covers the moment between the two.
    if (this.live && !this.liveNumbered) {
      this.close();
      this.live = this.open();
    }
    return state;
  }

  subscribe(listener: (event: Event) => void): () => void {
    return this.listen(this.listeners, listener);
  }

  send(command: Command): Promise<void> {
    return this.post(command);
  }

  async logs(): Promise<string[]> {
    const res = await this.fetch(`${this.base}${API.logs}`, { credentials: "same-origin" });
    if (!res.ok) throw await this.refused(res);
    const lines: string[] = await res.json();
    return lines;
  }

  subscribeLogs(listener: (message: LogMessage) => void): () => void {
    return this.listen(this.logListeners, listener);
  }

  /** Whether anyone listens, to events or to the log: the connection is held while someone does. */
  private get listened(): boolean {
    return this.listeners.size + this.logListeners.size > 0;
  }

  /** Adds `listener` to `set`; the first listener of either kind opens the connection, the last one closes it. */
  private listen<L>(set: Set<L>, listener: L): () => void {
    const first = !this.listened;
    set.add(listener);
    if (first) {
      this.watching = this.visibility.onChange(() => this.follow());
      this.follow();
    }
    return () => {
      set.delete(listener);
      if (!this.listened) {
        this.watching?.();
        this.watching = null;
        this.retrying?.();
        this.retrying = null;
        this.close();
        this.held = null;
      }
    };
  }

  /**
   * Called once when the service answers 401: it restarted, or the cookie is gone, and the link this tab was
   * opened with no longer works (#68). From then on nothing is asked again; a new link is a new tab. The listener
   * gets the command that opens Lookover, as the 401 named it (ADR 0058), or null.
   */
  onSessionLost(listener: (open: string | null) => void): () => void {
    this.lostListeners.add(listener);
    return () => this.lostListeners.delete(listener);
  }

  /** A connection while the tab is shown, none while it is hidden, none once the session is lost. */
  private follow(): void {
    if (this.visibility.hidden() || this.sessionLost) this.close();
    else if (!this.live) this.live = this.open();
  }

  private open(): LiveSource {
    this.liveNumbered = this.seq !== null;
    const after = this.seq === null ? "" : `?${API.after}=${this.seq}`;
    const source = new this.Source(`${this.base}${API.events}${after}`);
    source.addEventListener(SSE.event, (e) => {
      this.heard();
      const event: Event = JSON.parse(e.data);
      this.receive(event);
    });
    source.addEventListener(SSE.reload, () => {
      this.heard();
      this.reload();
    });
    source.addEventListener(SSE.keepalive, (e) => {
      this.heard();
      this.tick(e.data);
    });
    source.addEventListener(SSE.log, (e) => {
      this.heard();
      this.logged(e.data);
    });
    // The browser's own word that the stream is open: whatever the log gained before it was never sent here.
    source.addEventListener("open", () => {
      for (const l of this.logListeners) l({ type: "connected" });
    });
    source.addEventListener("error", () => this.again());
    this.heard();
    return source;
  }

  /**
   * The keepalive carries the service's `now` (ADR 0046): the listeners get it as a `clock` event at the last
   * number seen, which `apply` takes as the time alone and nothing stores. Nothing before a snapshot (no number
   * to say it at), nothing while a reload is under way (the snapshot on its way carries the service's time).
   */
  private tick(data: string): void {
    if (this.seq === null || this.held) return;
    let said: unknown;
    try {
      said = JSON.parse(data || "{}");
    } catch {
      // Not the service's keepalive (a proxy's words, say): no time to follow.
      return;
    }
    if (typeof said !== "object" || said === null || !("at" in said) || typeof said.at !== "number") return;
    this.deliver({ type: "clock", at: said.at, seq: this.seq });
  }

  /** A line the log file gained, to the log listeners alone (ADR 0055); anything else (a proxy's words) dropped. */
  private logged(data: string): void {
    let said: unknown;
    try {
      said = JSON.parse(data);
    } catch {
      // Not the service's line: nothing to show.
      return;
    }
    if (typeof said !== "object" || said === null || !("line" in said) || typeof said.line !== "string")
      return;
    for (const l of this.logListeners) l({ type: "line", line: said.line });
  }

  /**
   * The connection failed, or the reload's snapshot did: it is closed, and a new one asks after the last number
   * once the pause is over (the service replays, or says reload again). One pause at a time, so a service that
   * keeps refusing is asked once per `retry`, not in a tight loop. Before the new connection, the snapshot is
   * asked for once and dropped: the browser's `EventSource` can't say why a connection was refused, and this
   * says whether the session still opens the service (a 401 ends it) or whether to pause again.
   */
  private again(): void {
    this.close();
    if (this.retrying || this.sessionLost) return;
    this.retrying = this.timers.after(this.retry, () => {
      this.retrying = null;
      if (this.listened) void this.probe();
    });
  }

  private async probe(): Promise<void> {
    try {
      await this.fetchSnapshot();
    } catch {
      // A 401 ended the session on the way; anything else is a service still out of reach.
      this.again();
      return;
    }
    // The last listener may have left while the service was asked: nobody would close a stream opened now.
    if (!this.listened) return;
    this.follow();
  }

  /**
   * The service answered 401, here or at another door on the same session (the drawer's): the session is gone.
   * Said once, with the command the first 401 named; the connection and every retry stop.
   */
  endSession(open: string | null): void {
    if (this.sessionLost) return;
    this.sessionLost = true;
    this.retrying?.();
    this.retrying = null;
    this.close();
    for (const l of this.lostListeners) l(open);
  }

  /** The service spoke: the connection is alive for another `silence`. */
  private heard(): void {
    this.quiet?.();
    this.quiet = this.timers.after(this.silence, () => {
      // Nothing for too long: the connection is dead, whatever the browser thinks. The new one asks after
      // the last number, so nothing is lost either way.
      this.quiet = null;
      if (!this.live) return;
      this.close();
      this.live = this.open();
    });
  }

  private close(): void {
    this.quiet?.();
    this.quiet = null;
    this.live?.close();
    this.live = null;
  }

  private receive(event: Event): void {
    if (this.held) {
      this.held.push(event);
      return;
    }
    // Already seen: a replay that overlaps, or an event older than the snapshot that just replaced the state.
    if (this.seq !== null && event.seq <= this.seq) return;
    this.seq = event.seq;
    this.deliver(event);
  }

  private reload(): void {
    if (this.held) return;
    this.held = [];
    void this.fetchSnapshot().then(
      (state) => {
        const arrived = this.held ?? [];
        this.held = null;
        this.seq = state.seq;
        this.deliver({ type: "state.replaced", at: state.now, seq: state.seq, state });
        for (const event of arrived) this.receive(event);
        // The stream that said reload may follow a room the service swapped out (a scenario loaded, ADR 0046),
        // whose log says nothing more while its keepalives go on: a new one follows the room the snapshot is
        // from, asking after its number.
        if (this.live) {
          this.close();
          this.follow();
        }
      },
      () => {
        // The snapshot is out of reach: what arrived meanwhile can't be applied on a state that is stale, so
        // the connection is dropped too, and the next one asks the service again.
        this.held = null;
        this.again();
      },
    );
  }

  private deliver(event: Event): void {
    for (const l of this.listeners) l(event);
  }

  private async fetchSnapshot(): Promise<State> {
    const res = await this.fetch(`${this.base}${API.snapshot}`, { credentials: "same-origin" });
    if (!res.ok) throw await this.refused(res);
    const state: State = await res.json();
    return state;
  }

  private post(body: unknown): Promise<void> {
    return postCommand(this.fetch, this.base, body, (open) => this.endSession(open));
  }

  private refused(res: Response): Promise<Refused> {
    return refusedBy(res, (open) => this.endSession(open));
  }
}

/**
 * Posts a command, or a dev verb (the drawer's `DemoApi`), on the page's session. A refusal rejects with
 * `Refused`; a 401 calls `lost` on the way, so every door to the service ends the session the same way.
 */
export async function postCommand(fetch: Fetch, base: string, body: unknown, lost: Lost): Promise<void> {
  const res = await fetch(`${base}${API.commands}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await refusedBy(res, lost);
}

/** What a door calls when the service answers 401: the session is gone; `open` the command the 401 named, or null. */
export type Lost = (open: string | null) => void;

/**
 * The command a 401's body names to open Lookover (`NoSession.open`, ADR 0058): the program's; null in development,
 * or for a body that doesn't say.
 */
export function openOf(answer: unknown): string | null {
  if (typeof answer !== "object" || answer === null || !("open" in answer)) return null;
  const { open } = answer;
  return typeof open === "string" && open !== "" ? open : null;
}

/**
 * The refusal to throw for a response that isn't ok; a 401 calls `lost` on the way, with the command it names: the
 * session is gone.
 */
export async function refusedBy(res: Response, lost: Lost): Promise<Refused> {
  const answer: unknown = await res.json().catch(() => ({}));
  if (res.status === 401) lost(openOf(answer));
  return new Refused(res.status, answer);
}
