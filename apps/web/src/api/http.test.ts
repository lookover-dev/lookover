// The HTTP client: against a small server with the service's routes (what the client sends and does with the
// answers), then against the real service in demo mode, started as `bun dev` starts it (the two
// sides read the same names from contracts, and here they are checked against each other). The browser's
// EventSource and document do not exist in Bun: stand-ins record what the client opened and say whether the
// tab is hidden, and the real source below reads the stream as the browser would, from the URL the client
// built.
import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  API,
  type Command,
  changeId,
  type Event,
  FAULTS,
  type LogMessage,
  repositoryId,
  SSE,
  type State,
} from "@lookover/contracts";
import { DemoApi } from "../dev/demo-api.ts";
import { HttpApi, type LiveSource, Refused, type Visibility } from "./http.ts";

const T0 = Date.UTC(2026, 9, 6, 8, 52);
type Handler = (event: { data: string }) => void;

class FakeSource implements LiveSource {
  static opened: FakeSource[] = [];
  readonly url: string;
  closed = false;
  private handlers = new Map<string, Handler>();
  constructor(url: string) {
    this.url = url;
    FakeSource.opened.push(this);
  }
  addEventListener(type: string, handler: Handler): void {
    this.handlers.set(type, handler);
  }
  close(): void {
    this.closed = true;
  }
  deliver(type: string, data: unknown): void {
    this.handlers.get(type)?.({ data: JSON.stringify(data) });
  }
}

/** The tab's visibility, driven by the test. */
class FakeVisibility implements Visibility {
  private hiddenNow = false;
  private listeners = new Set<() => void>();
  hidden = () => this.hiddenNow;
  onChange = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  get watched() {
    return this.listeners.size;
  }
  set(hidden: boolean) {
    this.hiddenNow = hidden;
    for (const l of this.listeners) l();
  }
}

/** The client's timers, moved by hand: a test never waits on the wall clock for a pause or a silence. */
class HeldTimers {
  private at = 0;
  private pending: { due: number; fire: () => void }[] = [];
  after = (ms: number, fire: () => void) => {
    const timer = { due: this.at + ms, fire };
    this.pending.push(timer);
    return () => {
      this.pending = this.pending.filter((t) => t !== timer);
    };
  };
  /** Moves time on by `ms`, firing every timer that falls due, in order, each at its own time. */
  advance(ms: number): void {
    const until = this.at + ms;
    for (;;) {
      const next = this.pending.filter((t) => t.due <= until).sort((a, b) => a.due - b.due)[0];
      if (!next) break;
      this.pending = this.pending.filter((t) => t !== next);
      this.at = next.due;
      next.fire();
    }
    this.at = until;
  }
}

/** The log's tail the small server answers. */
const TAIL = [
  "2026-10-06T08:51:00.000+00:00 Lookover service (demo mode, S1) · http://127.0.0.1:4000",
  "2026-10-06T08:52:00.000+00:00 sasensi/lookover-sandbox#1 opened by sasensi: Add unpaid filter",
];

/** What the small server answers a command: two refused, as the service would, the others taken. */
function commandAnswer(body: { type: string }): Response {
  if (body.type === "service.pause") return Response.json({ error: "not available yet" }, { status: 501 });
  if (body.type === "review.request") return Response.json({ error: "no such change" }, { status: 404 });
  return Response.json({ ok: true });
}

/**
 * A server with the service's routes, remembering what it was sent. `hold` keeps the snapshot until `release`;
 * `failNext` makes the next snapshot answer 500.
 */
function serve(snapshot: State) {
  const commands: unknown[] = [];
  let release: () => void = () => undefined;
  let gate: Promise<void> | null = null;
  let failures = 0;
  let lockedOut: (() => Response) | null = null;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const { pathname } = new URL(req.url);
      // The service restarted: the cookie this tab holds opens nothing any more.
      if (lockedOut) return lockedOut();
      if (pathname === API.snapshot) {
        await gate;
        if (failures > 0) {
          failures -= 1;
          return new Response("not now", { status: 500 });
        }
        return Response.json(snapshot);
      }
      if (pathname === API.logs) return Response.json(TAIL);
      if (pathname === API.commands) {
        const body = await req.json();
        commands.push(body);
        return commandAnswer(body);
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    base: `http://127.0.0.1:${server.port}`,
    commands,
    hold: () => {
      gate = new Promise<void>((r) => {
        release = r;
      });
    },
    release: () => release(),
    failNext: () => {
      failures += 1;
    },
    /** The service restarts: every door answers 401, with `answer` as its body (the program's names `open`). */
    lockOut: (answer: () => Response = () => Response.json({ error: "no session" }, { status: 401 })) => {
      lockedOut = answer;
    },
    stop: () => server.stop(true),
  };
}

/** What the program's 401 names: Lookover's command, a binary's path with a space in it, then `open` (ADR 0058). */
const BINARY_OPEN = String.raw`& 'C:\Users\Your Name\Downloads\lookover.exe' open`;
const noSession = (open: string) => Response.json({ error: "no session", open }, { status: 401 });

const partial = { seq: 7, now: T0, changes: {}, reviews: {}, repos: [] };
// Only the parts the test reads: the client passes the snapshot through, whatever it holds.
const snapshot: State = JSON.parse(JSON.stringify(partial));
const events = (seen: Event[]) => seen.map((e) => [e.seq, e.type]);
const until = async (done: () => boolean) => {
  for (let i = 0; i < 200 && !done(); i++) await Bun.sleep(10);
};

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  FakeSource.opened = [];
});

test("the snapshot comes from the service, and commands go to it", async () => {
  const server = serve(snapshot);
  cleanups.push(server.stop);
  const api = new HttpApi({ base: server.base, source: FakeSource, visibility: new FakeVisibility() });
  expect(await api.snapshot()).toEqual(snapshot);
  await api.send({ type: "engine.check" });
  // The drawer's verbs go to the same route through `DemoApi` (src/dev), tested beside it.
  expect(server.commands).toEqual([{ type: "engine.check" }]);
  await expect(api.send({ type: "service.pause", for: "hour" })).rejects.toThrow("not available yet");
});

test("a refused command rejects with the status and the service's words, for the notice and the console", async () => {
  const server = serve(snapshot);
  cleanups.push(server.stop);
  const api = new HttpApi({ base: server.base, source: FakeSource, visibility: new FakeVisibility() });
  const refused = (command: Command) =>
    api.send(command).then(
      () => null,
      (error: unknown) => error,
    );
  expect(await refused({ type: "service.pause", for: "hour" })).toMatchObject({
    status: 501,
    reason: "not available yet",
    answer: { error: "not available yet" },
  });
  const noSuch = await refused({ type: "review.request", changeId: changeId("sam/app#9") });
  expect(noSuch).toBeInstanceOf(Refused);
  expect(noSuch).toMatchObject({ status: 404, reason: "no such change" });
});

test("one live connection serves every listener, carries the events, and closes with the last one", async () => {
  const server = serve(snapshot);
  cleanups.push(server.stop);
  const api = new HttpApi({ base: server.base, source: FakeSource, visibility: new FakeVisibility() });
  const seen: Event[][] = [[], []];
  const off0 = api.subscribe((e) => seen[0]?.push(e));
  const off1 = api.subscribe((e) => seen[1]?.push(e));
  // Before any snapshot there is no number to ask after: the stream starts live.
  expect(FakeSource.opened.map((s) => s.url)).toEqual([`${server.base}${API.events}`]);

  const source = FakeSource.opened[0];
  if (!source) throw new Error("No live connection");
  const event: Event = { type: "clock", at: T0 + 1000, seq: 8 };
  source.deliver(SSE.event, event);
  expect(seen).toEqual([[event], [event]]);

  off0();
  expect(source.closed).toBe(false);
  off1();
  expect(source.closed).toBe(true);
});

test("a hidden tab closes its connection; shown again, it asks for what came after the last number it saw", async () => {
  const server = serve(snapshot);
  cleanups.push(server.stop);
  const tab = new FakeVisibility();
  const api = new HttpApi({ base: server.base, source: FakeSource, visibility: tab });
  const seen: Event[] = [];
  await api.snapshot();
  const off = api.subscribe((e) => seen.push(e));
  expect(tab.watched).toBe(1);
  FakeSource.opened[0]?.deliver(SSE.event, { type: "clock", at: T0 + 1000, seq: 8 });

  tab.set(true);
  expect(FakeSource.opened[0]?.closed).toBe(true);
  expect(FakeSource.opened).toHaveLength(1);

  tab.set(false);
  expect(FakeSource.opened.map((s) => s.url)).toEqual([
    `${server.base}${API.events}?after=7`,
    `${server.base}${API.events}?after=8`,
  ]);
  // The replay may overlap with what was seen: nothing is applied twice.
  FakeSource.opened[1]?.deliver(SSE.event, { type: "clock", at: T0 + 1000, seq: 8 });
  FakeSource.opened[1]?.deliver(SSE.event, { type: "clock", at: T0 + 2000, seq: 9 });
  expect(events(seen)).toEqual([
    [8, "clock"],
    [9, "clock"],
  ]);

  off();
  expect(FakeSource.opened[1]?.closed).toBe(true);
  expect(tab.watched).toBe(0);
});

test("a connection opened before any number is replaced by one that asks after the snapshot's, so the browser's own reconnect always says where it was", async () => {
  const server = serve(snapshot);
  cleanups.push(server.stop);
  const api = new HttpApi({ base: server.base, source: FakeSource, visibility: new FakeVisibility() });
  const seen: Event[] = [];
  api.subscribe((e) => seen.push(e));
  // An event comes on the first connection while the snapshot is on its way: the replacement asks after it.
  FakeSource.opened[0]?.deliver(SSE.event, { type: "clock", at: T0 + 1000, seq: 8 });
  await api.snapshot();
  expect(FakeSource.opened.map((s) => [s.url, s.closed])).toEqual([
    [`${server.base}${API.events}`, true],
    [`${server.base}${API.events}?after=8`, false],
  ]);
  // A later snapshot changes nothing: the connection already says where it is.
  await api.snapshot();
  expect(FakeSource.opened).toHaveLength(2);
});

test("a connection silent for too long is reopened, asking after the last number; a keepalive keeps it", async () => {
  const server = serve(snapshot);
  cleanups.push(server.stop);
  const timers = new HeldTimers();
  const api = new HttpApi({
    base: server.base,
    source: FakeSource,
    visibility: new FakeVisibility(),
    silence: 60_000,
    timers,
  });
  await api.snapshot();
  const seen: Event[] = [];
  const off = api.subscribe((e) => seen.push(e));
  // Alive: a keepalive, then an event, each within the budget.
  timers.advance(40_000);
  FakeSource.opened[0]?.deliver(SSE.keepalive, {});
  timers.advance(40_000);
  FakeSource.opened[0]?.deliver(SSE.event, { type: "clock", at: T0 + 1000, seq: 8 });
  timers.advance(59_999);
  expect(FakeSource.opened).toHaveLength(1);
  // Silent: the proxy or the network kept a dead connection open, and the browser can't tell.
  timers.advance(1);
  expect(FakeSource.opened.map((s) => [s.url, s.closed])).toEqual([
    [`${server.base}${API.events}?after=7`, true],
    [`${server.base}${API.events}?after=8`, false],
  ]);
  expect(events(seen)).toEqual([[8, "clock"]]);
  off();
  // Nothing watches a closed connection.
  timers.advance(10 * 60_000);
  expect(FakeSource.opened).toHaveLength(2);
});

test("a keepalive carries the service's clock: a clock event at the last number seen, never before a snapshot nor during a reload", async () => {
  const server = serve(snapshot);
  cleanups.push(server.stop);
  const tab = new FakeVisibility();
  const api = new HttpApi({ base: server.base, source: FakeSource, visibility: tab });
  const seen: Event[] = [];
  api.subscribe((e) => seen.push(e));
  // No snapshot yet: there is no number to say it at, and nothing to apply it on.
  FakeSource.opened[0]?.deliver(SSE.keepalive, { at: T0 + 15_000 });
  await api.snapshot();
  FakeSource.opened[1]?.deliver(SSE.keepalive, { at: T0 + 30_000 });
  FakeSource.opened[1]?.deliver(SSE.event, { type: "clock", at: T0 + 40_000, seq: 8 });
  FakeSource.opened[1]?.deliver(SSE.keepalive, { at: T0 + 45_000 });
  expect(seen).toEqual([
    { type: "clock", at: T0 + 30_000, seq: 7 },
    { type: "clock", at: T0 + 40_000, seq: 8 },
    { type: "clock", at: T0 + 45_000, seq: 8 },
  ]);
  // Never stored: the next connection asks after the last event, as if no keepalive had come.
  tab.set(true);
  tab.set(false);
  expect(FakeSource.opened[2]?.url).toBe(`${server.base}${API.events}?after=8`);
  // A reload under way: the snapshot on its way carries the service's now; nothing is said meanwhile.
  server.hold();
  FakeSource.opened[2]?.deliver(SSE.reload, {});
  FakeSource.opened[2]?.deliver(SSE.keepalive, { at: T0 + 60_000 });
  await Bun.sleep(20);
  expect(seen).toHaveLength(3);
  server.release();
  await until(() => seen.length === 4);
  expect(seen[3]).toMatchObject({ type: "state.replaced", seq: 7 });
});

test("when the reload's snapshot fails, the connection is opened again after a pause, and the service says reload once more", async () => {
  const server = serve(snapshot);
  cleanups.push(server.stop);
  const timers = new HeldTimers();
  const api = new HttpApi({
    base: server.base,
    source: FakeSource,
    visibility: new FakeVisibility(),
    retry: 3_000,
    timers,
  });
  await api.snapshot();
  const seen: Event[] = [];
  api.subscribe((e) => seen.push(e));
  server.failNext();
  FakeSource.opened[0]?.deliver(SSE.reload, {});
  // The snapshot failed: the connection is dropped, and the next one waits for the pause.
  await until(() => FakeSource.opened[0]?.closed === true);
  timers.advance(2_999);
  expect(FakeSource.opened).toHaveLength(1);
  timers.advance(1);
  // The pause over, the session is checked (the snapshot answers now), then the stream is opened again.
  await until(() => FakeSource.opened.length === 2);
  expect(FakeSource.opened.map((s) => [s.url, s.closed])).toEqual([
    [`${server.base}${API.events}?after=7`, true],
    [`${server.base}${API.events}?after=7`, false],
  ]);
  expect(seen).toEqual([]);
  FakeSource.opened[1]?.deliver(SSE.reload, {});
  await until(() => seen.length === 1);
  expect(seen[0]).toMatchObject({ type: "state.replaced", seq: 7 });
});

test("a connection that fails (refused, or dropped) is opened again after a pause, from the last number; not once nobody listens", async () => {
  const server = serve(snapshot);
  cleanups.push(server.stop);
  const timers = new HeldTimers();
  const api = new HttpApi({
    base: server.base,
    source: FakeSource,
    visibility: new FakeVisibility(),
    retry: 3_000,
    timers,
  });
  await api.snapshot();
  const off = api.subscribe(() => undefined);
  FakeSource.opened[0]?.deliver("error", {});
  expect(FakeSource.opened[0]?.closed).toBe(true);
  timers.advance(2_999);
  expect(FakeSource.opened).toHaveLength(1);
  timers.advance(1);
  // The pause over, the session is checked (the snapshot answers), then the stream is opened again.
  await until(() => FakeSource.opened.length === 2);
  expect(FakeSource.opened.map((s) => s.url)).toEqual([
    `${server.base}${API.events}?after=7`,
    `${server.base}${API.events}?after=7`,
  ]);
  FakeSource.opened[1]?.deliver("error", {});
  off();
  timers.advance(10 * 60_000);
  await Bun.sleep(20);
  expect(FakeSource.opened).toHaveLength(2);
});

test("a snapshot the service answers 401 says the session is lost: the tab is told, and opens nothing more (#68)", async () => {
  const server = serve(snapshot);
  cleanups.push(server.stop);
  const tab = new FakeVisibility();
  const api = new HttpApi({ base: server.base, source: FakeSource, visibility: tab });
  const lost: (string | null)[] = [];
  api.onSessionLost((open) => lost.push(open));
  api.subscribe(() => undefined);
  server.lockOut();
  await expect(api.snapshot()).rejects.toMatchObject({ status: 401, reason: "no session" });
  // Development's 401 names no command.
  expect(lost).toEqual([null]);
  // The connection opened before is closed, and no other is tried: the next link is a new session.
  expect(FakeSource.opened.map((s) => s.closed)).toEqual([true]);
  tab.set(true);
  tab.set(false);
  expect(FakeSource.opened).toHaveLength(1);
});

test("another door on the session answered 401 (the drawer's): the tab is told once, and the stream stops", async () => {
  const server = serve(snapshot);
  cleanups.push(server.stop);
  const api = new HttpApi({ base: server.base, source: FakeSource, visibility: new FakeVisibility() });
  const lost: (string | null)[] = [];
  api.onSessionLost((open) => lost.push(open));
  api.subscribe(() => undefined);
  api.endSession("lookover open");
  api.endSession(null);
  expect(lost).toEqual(["lookover open"]);
  expect(FakeSource.opened.map((s) => s.closed)).toEqual([true]);
});

test("a stream that reconnects into a 401 says the session is lost too, once, and stops trying", async () => {
  const server = serve(snapshot);
  cleanups.push(server.stop);
  const timers = new HeldTimers();
  const api = new HttpApi({
    base: server.base,
    source: FakeSource,
    visibility: new FakeVisibility(),
    retry: 3_000,
    timers,
  });
  await api.snapshot();
  const lost: (string | null)[] = [];
  api.onSessionLost((open) => lost.push(open));
  api.subscribe(() => undefined);
  // The service restarts: the stream drops, and the new service knows no such session. The stream can't read the
  // 401's body: the snapshot asked before a new stream reads it, and the command it names reaches the screen.
  server.lockOut(() => noSession(BINARY_OPEN));
  FakeSource.opened[0]?.deliver("error", {});
  timers.advance(3_000);
  await until(() => lost.length === 1);
  expect(lost).toEqual([BINARY_OPEN]);
  // Before a new stream, the service is asked whether the session still opens: it doesn't, so none is opened.
  expect(FakeSource.opened).toHaveLength(1);
  timers.advance(10 * 60_000);
  expect(FakeSource.opened).toHaveLength(1);
  expect(lost).toHaveLength(1);
});

test("the program's 401 names the command that opens Lookover: every door hands it to the session screen (ADR 0058)", async () => {
  for (const door of ["snapshot", "command", "logs"] as const) {
    const server = serve(snapshot);
    cleanups.push(server.stop);
    const api = new HttpApi({ base: server.base, source: FakeSource, visibility: new FakeVisibility() });
    const lost: (string | null)[] = [];
    api.onSessionLost((open) => lost.push(open));
    server.lockOut(() => noSession(BINARY_OPEN));
    const asked =
      door === "snapshot"
        ? api.snapshot()
        : door === "command"
          ? api.send({ type: "engine.check" })
          : api.logs();
    await expect(asked).rejects.toMatchObject({ status: 401 });
    expect(lost).toEqual([BINARY_OPEN]);
  }
});

test("a 401 whose body doesn't say gets no command: the screen says the sentence without one", async () => {
  const bodies = [
    () => new Response("no session", { status: 401 }),
    () => Response.json({ error: "no session", open: 7 }, { status: 401 }),
    () => Response.json(["lookover open"], { status: 401 }),
  ];
  for (const body of bodies) {
    const server = serve(snapshot);
    cleanups.push(server.stop);
    const api = new HttpApi({ base: server.base, source: FakeSource, visibility: new FakeVisibility() });
    const lost: (string | null)[] = [];
    api.onSessionLost((open) => lost.push(open));
    server.lockOut(body);
    await expect(api.snapshot()).rejects.toMatchObject({ status: 401 });
    expect(lost).toEqual([null]);
  }
});

test("a listener gone while the session is being checked leaves no stream behind", async () => {
  const server = serve(snapshot);
  cleanups.push(server.stop);
  const timers = new HeldTimers();
  const api = new HttpApi({
    base: server.base,
    source: FakeSource,
    visibility: new FakeVisibility(),
    retry: 3_000,
    timers,
  });
  await api.snapshot();
  const off = api.subscribe(() => undefined);
  FakeSource.opened[0]?.deliver("error", {});
  // The pause over, the snapshot is asked for and held; the last listener leaves meanwhile.
  server.hold();
  timers.advance(3_000);
  off();
  server.release();
  await Bun.sleep(20);
  expect(FakeSource.opened).toHaveLength(1);
  timers.advance(10 * 60_000);
  expect(FakeSource.opened).toHaveLength(1);
});

test("the log's tail comes from the service; a refusal rejects with its status (ADR 0055)", async () => {
  const server = serve(snapshot);
  cleanups.push(server.stop);
  const api = new HttpApi({ base: server.base, source: FakeSource, visibility: new FakeVisibility() });
  expect(await api.logs()).toEqual(TAIL);
  server.lockOut();
  await expect(api.logs()).rejects.toMatchObject({ status: 401 });
});

test("a log message reaches the log listeners alone, never the event listeners, and each opening says connected (ADR 0055)", async () => {
  const server = serve(snapshot);
  cleanups.push(server.stop);
  const timers = new HeldTimers();
  const api = new HttpApi({
    base: server.base,
    source: FakeSource,
    visibility: new FakeVisibility(),
    timers,
  });
  await api.snapshot();
  const seen: Event[] = [];
  const heard: LogMessage[] = [];
  cleanups.push(api.subscribe((e) => seen.push(e)));
  cleanups.push(api.subscribeLogs((m) => heard.push(m)));
  // One connection carries both.
  expect(FakeSource.opened).toHaveLength(1);
  FakeSource.opened[0]?.deliver("open", {});
  FakeSource.opened[0]?.deliver(SSE.log, {
    line: "2026-10-06T08:52:00.000+00:00 Lookover is stopping (Ctrl+C)",
  });
  expect(seen).toEqual([]);
  // The connection fails and is opened again: a line written meanwhile is lost, so the page reads the tail again.
  FakeSource.opened[0]?.deliver("error", {});
  timers.advance(3_000);
  await until(() => FakeSource.opened.length === 2);
  FakeSource.opened[1]?.deliver("open", {});
  expect(heard).toEqual([
    { type: "connected" },
    { type: "line", line: "2026-10-06T08:52:00.000+00:00 Lookover is stopping (Ctrl+C)" },
    { type: "connected" },
  ]);
});

test("a log listener alone opens the connection, and the last listener of either kind closes it", async () => {
  const server = serve(snapshot);
  cleanups.push(server.stop);
  const api = new HttpApi({ base: server.base, source: FakeSource, visibility: new FakeVisibility() });
  const offLogs = api.subscribeLogs(() => undefined);
  expect(FakeSource.opened.map((s) => s.closed)).toEqual([false]);
  const offEvents = api.subscribe(() => undefined);
  offLogs();
  expect(FakeSource.opened.map((s) => s.closed)).toEqual([false]);
  offEvents();
  expect(FakeSource.opened.map((s) => s.closed)).toEqual([true]);
});

test("subscribed while hidden, the client opens nothing until the tab is shown", async () => {
  const server = serve(snapshot);
  cleanups.push(server.stop);
  const tab = new FakeVisibility();
  tab.set(true);
  const api = new HttpApi({ base: server.base, source: FakeSource, visibility: tab });
  await api.snapshot();
  api.subscribe(() => undefined);
  expect(FakeSource.opened).toHaveLength(0);
  tab.set(false);
  expect(FakeSource.opened.map((s) => s.url)).toEqual([`${server.base}${API.events}?after=7`]);
});

test("told to reload, the client fetches the snapshot again, hands it over as a replacing event, and what arrived meanwhile follows it", async () => {
  const server = serve(snapshot);
  cleanups.push(server.stop);
  const tab = new FakeVisibility();
  const api = new HttpApi({ base: server.base, source: FakeSource, visibility: tab });
  const seen: Event[] = [];
  api.subscribe((e) => seen.push(e));
  server.hold();
  FakeSource.opened[0]?.deliver(SSE.reload, {});
  // While the snapshot is on its way: one event it will include, one it won't.
  FakeSource.opened[0]?.deliver(SSE.event, { type: "clock", at: T0 + 1000, seq: 6 });
  FakeSource.opened[0]?.deliver(SSE.event, { type: "clock", at: T0 + 3000, seq: 9 });
  await Bun.sleep(20);
  expect(seen).toEqual([]);
  server.release();
  await until(() => seen.length === 2);
  expect(seen).toEqual([
    { type: "state.replaced", at: T0, seq: 7, state: snapshot },
    { type: "clock", at: T0 + 3000, seq: 9 },
  ]);
  // The stream that said reload may follow a room the service swapped out (a scenario loaded, ADR 0046): once
  // the snapshot is in, it is replaced by one that asks after what the reload led to.
  expect(FakeSource.opened.map((s) => [s.url, s.closed])).toEqual([
    [`${server.base}${API.events}`, true],
    [`${server.base}${API.events}?after=9`, false],
  ]);
  tab.set(true);
  tab.set(false);
  expect(FakeSource.opened[2]?.url).toBe(`${server.base}${API.events}?after=9`);
});

// ---- against the real service ----

const SERVICE = resolve(import.meta.dir, "../../../service/src/main.ts");
// How long the real service may take to start before it is a failure: the program loads, plants the sandbox
// (a dozen git commands) and checks the engines, under a second on an idle machine. A test against it is
// given longer than the starts it waits for, or Bun's 5 s would cut a slow start short.
const START_LIMIT_MS = 10_000;
const ONE_START_MS = START_LIMIT_MS + 5_000;
const TWO_STARTS_MS = 2 * START_LIMIT_MS + 5_000;

interface Demo {
  origin: string;
  openUrl: string;
  port: number;
  home: string;
  stop(): Promise<void>;
}

/**
 * The service in demo mode, as `bun dev` starts it, in a temporary data folder. Stopped and removed
 * after the test, unless `shared`: then the caller stops it.
 */
async function startDemoService(
  options: { home?: string; port?: number; eventsKept?: number; shared?: boolean } = {},
) {
  const home = options.home ?? mkdtempSync(join(realpathSync.native(tmpdir()), "lookover-web-"));
  const announce = join(home, `service-${Date.now()}.json`);
  const args = [
    "--demo",
    `--home=${home}`,
    `--announce=${announce}`,
    ...(options.port === undefined ? [] : [`--port=${options.port}`]),
    ...(options.eventsKept === undefined ? [] : [`--events-kept=${options.eventsKept}`]),
  ];
  const proc = Bun.spawn([process.execPath, SERVICE, "serve", ...args], {
    stdout: "ignore",
    stderr: "inherit",
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    proc.kill();
    await proc.exited;
  };
  // Cleanups run in reverse: the folder goes once every service in it has stopped.
  if (!options.shared) {
    if (options.home === undefined) cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    cleanups.push(stop);
  }
  for (let i = 0; i < START_LIMIT_MS / 20 && !existsSync(announce); i++) await Bun.sleep(20);
  if (!existsSync(announce)) throw new Error("The service did not start");
  const announced = JSON.parse(readFileSync(announce, "utf8"));
  const demo: Demo = { ...announced, home, stop };
  return demo;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Reads a stream as the browser's EventSource does, from the URL the client built. */
function streamSource(fetchWithSession: Fetch) {
  return class StreamSource implements LiveSource {
    static dropped = 0;
    private handlers = new Map<string, Handler>();
    private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    constructor(url: string) {
      // A connection the service drops (it stopped) ends the stream; the browser would reconnect by itself.
      void this.read(url).catch(() => {
        StreamSource.dropped += 1;
      });
    }
    addEventListener(type: string, handler: Handler): void {
      this.handlers.set(type, handler);
    }
    close(): void {
      // Cancelling a stream the service already dropped is refused: it is as closed as it gets.
      void this.reader?.cancel().catch(() => {
        StreamSource.dropped += 1;
      });
    }
    private async read(url: string): Promise<void> {
      const res = await fetchWithSession(url);
      this.reader = res.body?.getReader();
      if (!this.reader) throw new Error(`The event stream answered ${res.status} with no body`);
      // As the browser says once the stream's answer came.
      this.handlers.get("open")?.({ data: "" });
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const lines = buffer.slice(0, end).split("\n");
          buffer = buffer.slice(end + 2);
          const field = (name: string) =>
            lines
              .find((l) => l.startsWith(`${name}:`))
              ?.slice(name.length + 1)
              .trimStart() ?? "";
          if (field("event")) this.handlers.get(field("event"))?.({ data: field("data") });
        }
      }
    }
  };
}

/** What the browser does with the opened link: follows it once and keeps the cookie, on every request. */
async function openApp(demo: Demo): Promise<Fetch> {
  const opened = await fetch(demo.openUrl, { redirect: "manual" });
  expect(opened.status).toBe(303);
  const cookie = opened.headers.get("set-cookie")?.split(";")[0] ?? "";
  return (input, init) =>
    fetch(input, { ...init, headers: { ...init?.headers, cookie, origin: demo.origin } });
}

/**
 * The file's demo services. A start is a program loading, planting the sandbox and checking the engines.
 * - `shared`: one service and one session for most of the real service's tests (the opened link works once),
 *   started as the file loads, while the small server's tests run. Kept 2 events, which the catch-up test relies
 *   on; the restart test, last, stops it.
 * - `ownDemo()`: the scenario load's alone, started the first time a test asks for it: a load moves the numbers
 *   the shared one's tests read.
 */
const shared = startDemoService({ eventsKept: 2, shared: true }).then(async (demo) => ({
  demo,
  withSession: await openApp(demo),
}));
// A start that fails fails the test waiting for it, not the file as it loads.
shared.catch(() => undefined);
const sharedDemo = () => shared;
/** The services the file started, stopped after its last test. */
const started: Promise<Demo>[] = [shared.then(({ demo }) => demo)];
let own: Promise<Demo> | undefined;
function ownDemo(): Promise<Demo> {
  if (own === undefined) {
    own = startDemoService({ shared: true });
    started.push(own);
  }
  return own;
}
afterAll(async () => {
  for (const service of started) {
    const demo = await service.catch(() => null);
    if (demo === null) continue;
    await demo.stop();
    rmSync(demo.home, { recursive: true, force: true });
  }
});

/**
 * A tab whose snapshot dates from number `seq`: the service has moved on since. The number is forged on the
 * real snapshot's way in, once: the running demo service makes no event after its start, so a tab that lags
 * behind can be had no other way; what the service then replays or says is real.
 */
function snapshotAt(withSession: Fetch, seq: number): Fetch {
  let first = true;
  return async (input, init) => {
    const res = await withSession(input, init);
    if (!first || !input.endsWith(API.snapshot)) return res;
    first = false;
    return Response.json({ ...(await res.json()), seq });
  };
}

test(
  "against the real service: the link opens the app once, and the client sees what the service holds",
  async () => {
    const { demo, withSession } = await sharedDemo();
    const tab = new FakeVisibility();
    const api = new HttpApi({
      base: demo.origin,
      fetch: withSession,
      source: streamSource(withSession),
      visibility: tab,
    });
    // As the UI does: listen first, then load the snapshot. Nothing falls between the two.
    const seen: Event[] = [];
    const off = api.subscribe((e) => seen.push(e));
    cleanups.push(off);
    const state = await api.snapshot();
    // The demo wiring (ADR 0046): S10's seed, a quiet day, played before the first request: the start, the
    // repository, six pull requests opened and reviewed or skipped, main's rules read and counted, each round's
    // outbox as it posted, sixty-eight events.
    expect(state.seq).toBe(68);
    expect(state.repos.map((r) => r.id)).toEqual([repositoryId("sasensi/lookover-sandbox")]);
    expect(Object.keys(state.changes).sort()).toEqual([
      "sasensi/lookover-sandbox#135",
      "sasensi/lookover-sandbox#137",
      "sasensi/lookover-sandbox#139",
      "sasensi/lookover-sandbox#141",
      "sasensi/lookover-sandbox#144",
      "sasensi/lookover-sandbox#146",
    ]);
    await Bun.sleep(100);
    expect(seen).toEqual([]);

    // The drawer's door on the same session: the listing names the scenario loaded and its faults, and
    // "Refresh" lists again with nothing new to say.
    const drawer = new DemoApi({ base: demo.origin, fetch: withSession });
    const listing = await drawer.listing();
    expect(listing.current).toBe("S10");
    expect(listing.faults).toEqual(FAULTS);
    await drawer.send({ type: "refresh" });
    // What the service refuses, by status and reason: a repository it doesn't watch, a pull request it doesn't hold.
    const elsewhere = {
      type: "repo.setSetting",
      repoId: repositoryId("sam/app"),
      key: "onPush",
      value: true,
    } as const;
    await expect(api.send(elsewhere)).rejects.toMatchObject({ status: 404, reason: "no such repository" });
    await expect(
      api.send({ type: "review.request", changeId: changeId("sasensi/lookover-sandbox#9") }),
    ).rejects.toMatchObject({ status: 404 });
    expect(seen).toEqual([]);

    // The log file of the scratch data folder (ADR 0055): the start, stamped, and the seed's reviews.
    const tail = await api.logs();
    expect(tail).toContainEqual(expect.stringMatching(/^\S+ Lookover service \(demo mode, S10\) · /));
    expect(tail).toContainEqual(expect.stringMatching(/^\S+ sasensi\/lookover-sandbox#135 opened by /));
  },
  ONE_START_MS,
);

test(
  "against the real service: a tab without the session is told it is lost on its snapshot, and asks nothing more (#68)",
  async () => {
    const { demo } = await sharedDemo();
    // The browser's own fetch, with no cookie: a tab opened on a link that was used, or after a restart.
    const bare: Fetch = (input, init) =>
      fetch(input, { ...init, headers: { ...init?.headers, origin: demo.origin } });
    const api = new HttpApi({
      base: demo.origin,
      fetch: bare,
      source: FakeSource,
      visibility: new FakeVisibility(),
    });
    let lost = 0;
    api.onSessionLost(() => {
      lost += 1;
    });
    cleanups.push(api.subscribe(() => undefined));
    await expect(api.snapshot()).rejects.toMatchObject({ status: 401, reason: "no session" });
    expect(lost).toBe(1);
    expect(FakeSource.opened.map((s) => s.closed)).toEqual([true]);
  },
  ONE_START_MS,
);

test(
  "against the real service: a tab that comes back gets exactly what it missed, or reloads when the buffer moved on",
  async () => {
    const { demo, withSession } = await sharedDemo();

    // Events 1 to 68 happened; the service keeps 67 and 68, the round of the seed's last review and the rules it
    // counted. A tab at 66 missed two.
    const recent = new HttpApi({
      base: demo.origin,
      fetch: snapshotAt(withSession, 66),
      source: streamSource(withSession),
      visibility: new FakeVisibility(),
    });
    await recent.snapshot();
    const missed: Event[] = [];
    cleanups.push(recent.subscribe((e) => missed.push(e)));
    await until(() => missed.length >= 2);
    await Bun.sleep(100);
    expect(events(missed)).toEqual([
      [67, "round.finished"],
      [68, "rules.changed"],
    ]);

    // A tab at 65 missed one the service no longer holds: it loads the snapshot again.
    const old = new HttpApi({
      base: demo.origin,
      fetch: snapshotAt(withSession, 65),
      source: streamSource(withSession),
      visibility: new FakeVisibility(),
    });
    await old.snapshot();
    const reloaded: Event[] = [];
    cleanups.push(old.subscribe((e) => reloaded.push(e)));
    await until(() => reloaded.length >= 1);
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]).toMatchObject({ type: "state.replaced", seq: 68 });
  },
  ONE_START_MS,
);

test(
  "against the real service: a tab open when a scenario loads reloads, then follows the new room's events",
  async () => {
    // Its own service: a load moves the numbers the shared one's tests read.
    const demo = await ownDemo();
    const withSession = await openApp(demo);
    const api = new HttpApi({
      base: demo.origin,
      fetch: withSession,
      source: streamSource(withSession),
      visibility: new FakeVisibility(),
    });
    const seen: Event[] = [];
    cleanups.push(api.subscribe((e) => seen.push(e)));
    const heard: LogMessage[] = [];
    cleanups.push(api.subscribeLogs((m) => heard.push(m)));
    expect((await api.snapshot()).seq).toBe(68);
    // The snapshot swapped the first stream for one asking after 68: it follows the log once its answer came. One
    // asked while the scenario loads waits for the load, and so misses the new room's seed lines (#313).
    const connected = () => heard.filter((m) => m.type === "connected").length;
    await until(() => connected() >= 2);
    expect(connected()).toBe(2);

    const drawer = new DemoApi({ base: demo.origin, fetch: withSession });
    await drawer.send({ type: "demo.load", id: "S10" });
    await until(() => seen.length >= 1);
    // S10 again in a new room: its sixty-eight events and the load's clock event, numbered on from 68.
    expect(seen.map((e) => [e.seq, e.type])).toEqual([[137, "state.replaced"]]);
    // The new room's seed wrote to the same log file, and its lines came live, on no event.
    const opened = (m: LogMessage) =>
      m.type === "line" && / sasensi\/lookover-sandbox#135 opened by /.test(m.line);
    await until(() => heard.some(opened));
    expect(heard.some(opened)).toBe(true);
    expect(heard[0]).toEqual({ type: "connected" });

    // The new room's clock moves: the tab hears it on the stream, not only on its next reload.
    await drawer.send({ type: "demo.advance", ms: 60_000 });
    await until(() => seen.length >= 2);
    expect(events(seen)).toEqual([
      [137, "state.replaced"],
      [138, "clock"],
    ]);
  },
  ONE_START_MS,
);

// The last test of the file: it stops the shared service and starts it again on its data folder, which
// costs one start instead of a fresh one (that would plant the sandbox again).
test(
  "against the real service: a hidden tab holds no connection, and shown after a restart it reloads",
  async () => {
    const { demo: first, withSession } = await sharedDemo();
    const tab = new FakeVisibility();
    const api = new HttpApi({
      base: first.origin,
      fetch: withSession,
      source: streamSource(withSession),
      visibility: tab,
    });
    const seen: Event[] = [];
    cleanups.push(api.subscribe((e) => seen.push(e)));
    const before = await api.snapshot();
    expect(before.seq).toBe(68);

    tab.set(true);
    await first.stop();
    // The service comes back on the same port and data folder; the cookie still opens it.
    const second = await startDemoService({ home: first.home, port: first.port });
    expect(second.origin).toBe(first.origin);

    tab.set(false);
    await until(() => seen.length >= 1);
    expect(seen).toHaveLength(1);
    const after = seen[0];
    if (after?.type !== "state.replaced") throw new Error(`Expected a replaced state, got ${after?.type}`);
    // The restart plays the scenario again in a new room, numbered on from the first one's last event (ADR
    // 0046), so the tab reloads rather than mixing two stories; what the start fixed moved with it.
    expect(after.seq).toBe(136);
    expect(after.state.service.since).toBeGreaterThanOrEqual(before.service.since);
    expect(Object.keys(after.state.changes).sort()).toEqual(Object.keys(before.changes).sort());
  },
  TWO_STARTS_MS,
);
