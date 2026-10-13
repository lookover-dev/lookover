// The running service: the server (`Bun.serve` on 127.0.0.1, the session's cookie and one-time token, the API
// and its event streams, on real timers) over one engine room (`room.ts`: the store, the poller, the queue, the
// runs, the checks, the reactions, the event log, and the room's clock and timers). The server stays up while a
// room is replaced (ADR 0046, a scenario load): the API reaches the current room through one accessor. The room
// is built once here, at start; in demo mode a scenario load (`demo.load`) builds a second one on a fresh folder,
// plays its seed, and only then stops the old one and swaps the new one in, the server, the session and the
// streams up throughout.
// What it is wired with (fakes or real adapters) is `run-service.ts`'s choice; here every port is a parameter.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { API } from "@lookover/contracts";
import { openStore } from "@lookover/store";
import { type ApiDeps, createApi, described, type Loaded, type Loader, randomToken } from "./api.ts";
import { buildDemoRoom, type DemoRoomOptions } from "./demo/driver.ts";
import type { Scenario } from "./demo/scenario.ts";
import { SCENARIOS } from "./demo/scenarios.ts";
import type { LogReader, LogSink } from "./log-sink.ts";
import { buildRoom, type RoomOptions } from "./room.ts";
import { said } from "./said.ts";
import { REAL_TIMERS, type Timers } from "./timers.ts";
import type { WebFiles } from "./web-files.ts";
import { writeWhole } from "./whole-file.ts";

/** How often a quiet event stream says it is alive. */
const KEEPALIVE_MS = 15_000;

/** The server's own options, apart from the room's. */
interface ServerOptions {
  /** The data folder: the session file lives there. */
  home: string;
  /** 0, the default, takes any free port. */
  port?: number;
  /**
   * The origin the app is served from, when it isn't this service: the dev server that proxies `/api` here.
   * Host and Origin must match it. Default: this service's own.
   */
  origin?: string;
  /**
   * The server's own time (a quiet event stream's keepalive, a minted link's two minutes), apart from the room's: the
   * real timers, which no room swap drops, unless a test moves time by hand.
   */
  serverTimers?: Timers;
  /**
   * What `API.stop` does once it answered (ADR 0054): this service's own stop, unless the program gives its own (the
   * same stop, then the process's exit).
   */
  stopAsked?: () => void;
  /** The built web app the service serves beside its API (ADR 0054); none in development, where Vite serves it. */
  webFiles?: WebFiles;
  /**
   * Where the service's lines go (ADR 0054): the room's `log`, unless one is given, writes to it, and the session's
   * secret and its link's token are registered with it before the server listens; the Logs page reads it back (ADR
   * 0055). The console when not given, and the page's tail empty.
   */
  logSink?: LogSink & LogReader;
  /**
   * The port to try first when `port` is 0 (ADR 0054: the one the program used last, kept in `<home>/port`), any
   * free one when it can't be bound, whatever the error.
   */
  preferredPort?: number;
  /**
   * Whether the start makes a one-time link to open the app with (`openUrl`): yes by default, as demo and live mode
   * do; the program makes none (ADR 0054), and no token opens a session until a link is minted.
   */
  startLink?: boolean;
  /**
   * Whether a 401 names the command that opens Lookover, from the room's Lookover's command (ADR 0058): the program
   * does; development doesn't by default, its screen naming the link `bun dev` printed.
   */
  namesOpen?: boolean;
}

export interface ServiceOptions extends RoomOptions, ServerOptions {}

/** Demo mode (ADR 0046): the server over a scenario's room, built by the driver on the scripted fakes. */
export interface DemoServiceOptions extends ServerOptions {
  scenario: Scenario;
  /**
   * What `demo.load` may name and the listing shows: the catalogue (`SCENARIOS`) unless a test brings its own;
   * `scenario` need not be in it.
   */
  scenarios?: Scenario[];
  /**
   * The instant the seed ends at, where the clock then stands still (`bun run proof`); the real time otherwise. A
   * load's seed ends at the same instant, so two loads of one scenario show the same facts.
   */
  frozen?: number;
  version: string;
  eventsKept?: number;
  log?(line: string): void;
  /** What builds each room, its seed played: the driver's `buildDemoRoom`, unless a test holds or breaks one. */
  driver?: typeof buildDemoRoom;
  /** What makes each room's App store files user-only: the App store's own unless a test injects a quicker one. */
  userOnly?: DemoRoomOptions["userOnly"];
  /** The person's `gh` (ADR 0059) every room holds, as each world says: a test's own; none, one per room. */
  gh?: DemoRoomOptions["gh"];
}

export interface RunningService {
  /** This service's own origin, `http://127.0.0.1:<port>`. */
  origin: string;
  port: number;
  /** The URL to open the app with: it carries the one-time token, and works once. Null when the start made none. */
  openUrl: string | null;
  stop(): Promise<void>;
}

/** The session cookie's name for the data folder `home`: one per folder, so services side by side keep theirs (ADR 0010). */
export const sessionCookie = (home: string): string =>
  `lookover-${createHash("sha1").update(home).digest("hex").slice(0, 8)}`;

/** 24 random bytes as base64url: anything else in the session file is not a secret this service made. */
const SECRET = /^[A-Za-z0-9_-]{32}$/;

/**
 * What the session cookie holds: the data folder's, made once, so a tab opened before a restart keeps its
 * session and catches up (ADR 0038, ADR 0010). The link's token is the start's: it works once. A file a crash
 * left empty or cut short is made again, never taken as a secret; it is written whole (`writeWhole`). The mode keeps the file to the owner on POSIX; Windows
 * ignores it, and the data folder's own permissions apply.
 */
function sessionSecret(home: string): string {
  const file = join(home, "session");
  if (existsSync(file)) {
    const kept = readFileSync(file, "utf8");
    if (SECRET.test(kept)) return kept;
  }
  const value = randomToken();
  writeWhole(file, value, 0o600);
  return value;
}

/** Where the service's lines go: the options' `log`, else their log sink, else the console. */
function logOf(o: { log?(line: string): void; logSink?: LogSink }): (line: string) => void {
  if (o.log !== undefined) return o.log;
  const sink = o.logSink;
  return (line) => (sink === undefined ? console.error(line) : sink.write(line));
}

/** The log sink's filter, which an engine's activity passes too (ADR 0055); none without a sink. */
function secretsOf(o: { logSink?: LogSink }): { secretsRemoved?: (text: string) => string } {
  const sink = o.logSink;
  return sink === undefined ? {} : { secretsRemoved: (text) => sink.secretsRemoved(text) };
}

export async function startService(o: ServiceOptions): Promise<RunningService> {
  const {
    port: _port,
    origin: _origin,
    serverTimers: _timers,
    stopAsked: _stopAsked,
    webFiles: _webFiles,
    logSink: _logSink,
    preferredPort: _preferredPort,
    startLink: _startLink,
    namesOpen: _namesOpen,
    ...roomOptions
  } = o;
  const room = await buildRoom({ ...roomOptions, log: logOf(o), ...secretsOf(o) });
  return serve(o, { room: () => room, demo: () => null, loader: null });
}

/** Where a demo service keeps its rooms, one folder each, numbered in the order they were built. */
const ROOMS = "rooms";

/**
 * At start: the number the last room's events reached. Every old room is read for it, then swept (a store that
 * won't open, from another Lookover, counts for nothing and is swept too), so a tab left open across a restart is
 * told to reload (ADR 0038) and nothing of an old story stays on disk.
 */
function sweepRooms(home: string): number {
  const rooms = join(home, ROOMS);
  mkdirSync(rooms, { recursive: true });
  let eventsFrom = 0;
  for (const name of readdirSync(rooms)) {
    eventsFrom = Math.max(eventsFrom, lastEventOf(join(rooms, name)));
    rmSync(join(rooms, name), { recursive: true, force: true });
  }
  return eventsFrom;
}

/** A fresh folder for the next room under `home`: numbered after every room made so far, whatever it was named. */
function roomFolder(home: string, id: string): string {
  const rooms = join(home, ROOMS);
  mkdirSync(rooms, { recursive: true });
  let n = 0;
  for (const name of readdirSync(rooms)) {
    const made = Number(name.split("-")[0]);
    if (Number.isInteger(made)) n = Math.max(n, made);
  }
  return join(rooms, `${n + 1}-${id}`);
}

/**
 * Removes a room's folder once it is stopped: a file still held (a store that failed to open) is left to the next
 * start's sweep.
 */
function sweep(folder: string, log: (line: string) => void): void {
  try {
    rmSync(folder, { recursive: true, force: true });
  } catch (error) {
    log(`${folder} is left behind: ${said(error)}`);
  }
}

/**
 * The number the room on `dir` numbered its events up to; 0 for a store that won't open (another Lookover's:
 * swept).
 */
function lastEventOf(dir: string): number {
  try {
    const store = openStore({ home: dir });
    const last = store.events.last();
    store.close();
    return last;
  } catch {
    return 0;
  }
}

/**
 * Demo mode: the server over the scenario's room, its seed played before the first request is answered. The
 * room's folder is a fresh one under `home/rooms`, its events numbered after the last room's. A load (ADR 0046)
 * builds the next room the same way, on a fresh folder numbered after the current one, its events after the
 * current room's last, and swaps it in once its seed is played: the server, the session and the streams stay up.
 */
export async function startDemoService(o: DemoServiceOptions): Promise<RunningService> {
  const log = logOf(o);
  /**
   * A room for `scenario` on a fresh folder, its events numbered after `eventsFrom`; the folder, to sweep it once
   * it is stopped. A seed that fails has stopped its room: its folder is swept here.
   */
  const build = async (scenario: Scenario, eventsFrom: number) => {
    const folder = roomFolder(o.home, scenario.id);
    try {
      const demo = await (o.driver ?? buildDemoRoom)({
        scenario,
        home: folder,
        eventsFrom,
        version: o.version,
        log,
        ...secretsOf(o),
        ...(o.frozen === undefined ? {} : { frozen: o.frozen }),
        ...(o.eventsKept === undefined ? {} : { eventsKept: o.eventsKept }),
        ...(o.scenarios === undefined ? {} : { scenarios: o.scenarios }),
        ...(o.userOnly === undefined ? {} : { userOnly: o.userOnly }),
        ...(o.gh === undefined ? {} : { gh: o.gh }),
      });
      // The room now, read through the driver: a fault may restart it (ADR 0053's lost key).
      return {
        demo,
        get room() {
          return demo.room;
        },
        folder,
      };
    } catch (error) {
      sweep(folder, log);
      throw error;
    }
  };
  type Built = Awaited<ReturnType<typeof build>>;
  let current = await build(o.scenario, sweepRooms(o.home));
  /** The load under way: commands are refused and new streams wait while it is; null between loads. */
  let loading: Promise<void> | null = null;

  /**
   * The old room stands still and the commands already under way answer; then the next room is built and its
   * seed played, its events numbered after the old room's last, while the old one still answers. A load whose
   * old room numbered an event meanwhile fails, as one whose seed fails does: the next room stopped and swept,
   * the old one as it was, its clock flowing again if it did. Otherwise the old room falls silent (what it sends
   * as it stops reaches no stream), is stopped and swept, and the next one swapped in, with one `clock` event
   * ending the load so the UI's `now` follows.
   */
  const load = async (id: string, settled: () => Promise<void>): Promise<Loaded> => {
    const scenario = (o.scenarios ?? SCENARIOS).find((s) => s.id === id);
    if (scenario === undefined) return "no_such_scenario";
    let loaded = () => {};
    loading = new Promise<void>((resolve) => {
      loaded = resolve;
    });
    const old = current;
    const was = { running: old.room.demo?.running ?? false, speed: old.room.demo?.speed ?? 1 };
    old.room.demo?.set(false, was.speed);
    let next: Built | null = null;
    try {
      try {
        await settled();
        const eventsFrom = old.room.events.last();
        next = await build(scenario, eventsFrom);
        // Moves no time: an advance sends the one `clock` event that ends the load, at the next room's `now`.
        await next.room.demo?.advance(0);
        const moved = old.room.events.last();
        if (moved !== eventsFrom) {
          throw new Error(
            `The room of ${old.demo.scenario.id} moved on while ${id} was built: event ${moved}, after ${eventsFrom}`,
          );
        }
      } catch (error) {
        if (next !== null) {
          await next.room.stop().catch((stopped: unknown) => log(`${id}: ${said(stopped)}`));
          sweep(next.folder, log);
        }
        old.room.demo?.set(was.running, was.speed);
        return { failed: said(error) };
      }
      old.room.events.silence();
      current = next;
      await old.room.stop().catch((stopped: unknown) => log(`${old.demo.scenario.id}: ${said(stopped)}`));
      sweep(old.folder, log);
      return "ok";
    } finally {
      loading = null;
      loaded();
    }
  };
  const loader: Loader = { loading: () => loading, load };
  return serve(o, { room: () => current.room, demo: () => current.demo, loader });
}

/** What the API reaches through accessors: the current room, its demo driver, and the loader that swaps rooms. */
type Doors = Pick<ApiDeps, "room" | "demo" | "loader">;

/**
 * Listens on `wanted`; when that is 0 (any port) and a `preferred` one is given, on that one first, then on any
 * free port when it can't be bound, whatever the error (taken, refused, reserved).
 */
function listenPreferring<T>(listen: (port: number) => T, wanted: number, preferred: number | undefined): T {
  if (wanted !== 0 || preferred === undefined) return listen(wanted);
  try {
    return listen(preferred);
  } catch {
    return listen(0);
  }
}

/** The server over the rooms behind `doors`: the session, `Bun.serve` and the API. */
async function serve(o: ServerOptions, doors: Doors): Promise<RunningService> {
  const { port: wanted, origin: served, serverTimers } = o;
  const session = {
    cookie: sessionCookie(o.home),
    secret: sessionSecret(o.home),
    token: o.startLink === false ? null : randomToken(),
  };
  o.logSink?.secret(session.secret);
  if (session.token !== null) o.logSink?.secret(session.token);
  const log = logOf(o);
  // The API needs the origin, which needs the port: the server is started first, and routes once the API exists.
  let api: ReturnType<typeof createApi> | undefined;
  const listen = (port: number) =>
    Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: (request, s) => {
        if (!api) return new Response(null, { status: 503 });
        return api.fetch(request, s);
      },
      // What the API's own handler didn't answer: to the log, never printed whole by Bun (ADR 0054).
      error: (error) => {
        log(`a request failed: ${described(error)}`);
        return new Response(null, { status: 500 });
      },
    });
  const server = listenPreferring(listen, wanted ?? 0, o.preferredPort);
  const port = server.port;
  if (port === undefined) throw new Error("The server has no port");
  const own = `http://127.0.0.1:${port}`;
  const origin = served ?? own;
  api = createApi({
    ...doors,
    origin,
    session,
    namesOpen: o.namesOpen ?? false,
    keepaliveMs: KEEPALIVE_MS,
    timers: serverTimers ?? REAL_TIMERS,
    webFiles: o.webFiles ?? null,
    log,
    logs: o.logSink ?? null,
    secret: (value) => o.logSink?.secret(value),
    forget: (value) => o.logSink?.forget(value),
    stop: () => (o.stopAsked ?? (() => void stop().catch((error: unknown) => log(said(error)))))(),
  });

  /** The stop under way or done: asked twice (Ctrl+C, then `lookover stop`), the service stops once. */
  let stopping: Promise<void> | null = null;
  const stop = () => {
    stopping ??= (async () => {
      // The server first: no request reaches a room whose store is closing. A load under way ends first, so the
      // room stopped is the one it swapped in, and the old one is stopped once, by the load.
      await server.stop(true);
      await doors.loader?.loading();
      await doors.room().stop();
    })();
    return stopping;
  };

  return {
    origin: own,
    port,
    openUrl: session.token === null ? null : `${origin}${API.session}?token=${session.token}`,
    stop,
  };
}
