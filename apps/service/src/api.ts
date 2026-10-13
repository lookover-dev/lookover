// The local API (ADR 0010, ADR 0028, ADR 0038): Hono on 127.0.0.1, at the paths `API` names in contracts. The
// snapshot over HTTP, events over server-sent events with the sequence number as the event id, commands as
// JSON requests. Every request reaches the current engine room through one accessor (ADR 0046): a room swapped
// in behind it serves the next request; while a scenario loads, commands answer 409 "loading" and a new stream
// waits, and once the rooms are swapped every open stream is told to reload. Local security on every request: a
// one-time token in the opened URL becomes an HTTP-only cookie, Host and Origin must be the app's, there is no
// CORS, and the content security policy is strict. The manifest flow's pages (`app-flow-pages.ts`, ADR 0053) are
// mounted here: GitHub's redirects reach two of them with no session and from another site. The built web app's
// files are served on every other path when the service is given them (`web-files.ts`, ADR 0054). Beside the API, the
// `lookover` commands' two routes (ADR 0054), under the same checks: one mints a link that opens the app once within
// two minutes, the other answers and then stops the service. The log file (ADR 0055) is read beside the state: its
// tail on one route, and each line it gains on every open event stream as an unnumbered `log` message, which no
// replay ever sends again. The sentences in the JSON errors are for the developer's console, never shown on screen
// (coding standards: the words are the UI's).
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  type AgentRefusal,
  API,
  type CreateAppRefusal,
  createAppRefusalText,
  DEMO_API,
  type Event,
  HostError,
  type MintedLink,
  type NoSession,
  type SettingsFileError,
  type SettingsRefusal,
  type SettingsWriteFailure,
  SSE,
  type UseAppRefusal,
} from "@lookover/contracts";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import type { z } from "zod";
import { appFlowPages, OPEN_PAGES } from "./app-flow-pages.ts";
import type { AgentOutcome } from "./coding-agent.ts";
import { request } from "./commands.ts";
import type { DemoRoom, InjectRefusal } from "./demo/driver.ts";
import type { LogReader } from "./log-sink.ts";
import type { Room, SettingsAnswer } from "./room.ts";
import type { Timers } from "./timers.ts";
import { useApp } from "./use-app.ts";
import { serveWebFiles, type WebFiles } from "./web-files.ts";

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
  "form-action 'self'",
].join("; ");

/** `Sec-Fetch-Site` values a browser sends for the app's own requests and for a typed URL. */
const OWN_SITE = new Set(["same-origin", "none"]);

interface Session {
  /** The cookie's name, derived from the data folder so instances side by side don't share one (ADR 0010). */
  cookie: string;
  /** What the cookie holds. */
  secret: string;
  /**
   * The start's one-time token in the opened URL, which works once and never expires (demo and live mode); null when
   * the start made no link (the program, ADR 0054), which opens only through a minted one.
   */
  token: string | null;
}

/** How long a minted link opens the app (ADR 0054, G5). */
const LINK_MS = 120_000;

/** A new token or secret: 24 random bytes as base64url. */
export const randomToken = () => randomBytes(24).toString("base64url");

export interface ApiDeps {
  /** The one origin the app is served from: Host and Origin must be its. */
  origin: string;
  session: Session;
  /**
   * Whether a 401 names the command that opens Lookover (`NoSession.open`, ADR 0058), the room's Lookover's command
   * then `open`: the program only; development's screen names the link `bun dev` printed.
   */
  namesOpen: boolean;
  /** The current engine room: asked on every request, so a room swapped in serves the next one. */
  room(): Room;
  /**
   * The demo driver of the current room (ADR 0046): the drawer's faults and listing; null in live mode, where
   * the faults answer 501 and the listing 404.
   */
  demo(): DemoRoom | null;
  /**
   * A scenario load (ADR 0046): the room swap under this server; null in live mode, where `demo.load` answers
   * 501.
   */
  loader: Loader | null;
  /** How often a quiet stream says it is alive. */
  keepaliveMs: number;
  /** The server's own timers, which no room swap drops: the keepalive waits on them, a minted link ages on them. */
  timers: Timers;
  /** The built web app, served on every path no route answers (ADR 0054); null in development, where Vite serves it. */
  webFiles: WebFiles | null;
  /** Where an error no route expected is written (the log sink, which removes its secrets, ADR 0054). */
  log(line: string): void;
  /**
   * The log file read back (ADR 0055): its tail, and each line it gains; null when the service writes no file (a test,
   * a script), where the tail is empty and no line is sent. One for the server: a room swapped in writes to it too.
   */
  logs: LogReader | null;
  /** Registers a minted link's token with the log's filter before it is answered (ADR 0054): it is never logged. */
  secret(value: string): void;
  /** Takes a minted link's token out of the log's filter once used or expired: the filter holds the live ones only. */
  forget(value: string): void;
  /**
   * What `API.stop` asks for once its answer is sent: the service stopped as Ctrl+C stops it (and, in the program, the
   * process ended).
   */
  stop(): void;
}

/**
 * What a load answered: swapped in, no scenario by that id, or why the new room was not swapped in (its seed's
 * failure, or the old room moving on while it was built).
 */
export type Loaded = "ok" | "no_such_scenario" | { failed: string };

/** The room swap behind `demo.load` (ADR 0046). */
export interface Loader {
  /** The load under way, which commands refuse ("loading") and a new stream waits for; null between loads. */
  loading(): Promise<void> | null;
  /**
   * Builds the scenario's room, plays its seed and swaps it in, the old room stopped; or says why not. `settled`
   * resolves once every command already under way when the load began has answered: what they send is the old
   * room's, numbered before the next room starts.
   */
  load(id: string, settled: () => Promise<void>): Promise<Loaded>;
}

/** Why a fault did nothing, for the console. */
const NOTHING_TO_INJECT = {
  nothing_to_open: "no pull request left to open in this scenario",
  nothing_to_push: "no reviewed pull request of yours with a commit left to push",
  nothing_to_close: "no pull request open",
  not_installed: "the App isn't installed",
  no_app_kept: "no App kept yet",
  nothing_to_add: "no repository left to add in this scenario",
  nothing_to_remove: "no repository left on the App's installation",
  nothing_departed: "no repository left the App's installation",
  no_organisation: "the App lives on no organisation in this scenario",
} as const satisfies Record<InjectRefusal, string>;

/** What the commands endpoint parses: the app's commands and the developer drawer's verbs. */
type Parsed = z.infer<typeof request>;
/** What a command answered: the JSON body and its status. */
type Answer = [
  body:
    | { ok: true }
    | {
        error: string;
        invalid?: SettingsFileError;
        unwritten?: SettingsWriteFailure;
        refused?: SettingsRefusal;
        createApp?: CreateAppRefusal;
        useApp?: UseAppRefusal;
        agent?: AgentRefusal;
      },
  status: 200 | 404 | 409 | 500 | 501 | 502,
];
/**
 * What a command reaches: the current room, its demo driver, and a scenario load that tells every open stream to
 * reload once the rooms are swapped (null in live mode).
 */
interface Reach {
  room: Room;
  demo: DemoRoom | null;
  load: ((id: string) => Promise<Loaded>) | null;
  /** Every open stream told to reload: the service restarted under them (the drawer's "key-lost"). */
  restarted(): void;
  /** Settles once every other command under way has answered: what a restart waits for before the room stops. */
  others(): Promise<void>;
}
/** A row of `COMMANDS`: what the room (or the demo driver) does with one command, given in its own shape. */
type Row<K extends Parsed["type"]> = (at: Reach, command: Extract<Parsed, { type: K }>) => Promise<Answer>;

const OK: Answer = [{ ok: true }, 200];
/** A settings command refused with no file at fault: its code, which the UI words, and a line for the console. */
const REFUSED: Record<SettingsRefusal, [error: string, status: 404 | 409]> = {
  no_such_rule: ["no such rule", 404],
  no_such_finding: ["no such finding", 404],
  no_rule: ["the finding cites no rule", 409],
  settled: ["the finding is settled or not on the pull request", 409],
  reviewing: ["a round of the change is running", 409],
  unnamed: ["this repository's name can't be a settings file", 409],
};

/** Your coding agent's command refused before any write (ADR 0058): its code, which the UI words, and a line. */
const AGENT_REFUSED: Record<AgentRefusal, [error: string, status: 404 | 409]> = {
  not_offered: ["no PATH offer here", 409],
  no_such_agent: ["no such agent", 404],
  not_ours: ["the skill isn't Lookover's", 409],
};

/**
 * An `agent.*` command's answer: done; refused before any write, with its code; or a write the machine refused, with
 * its reason (500), as start at login's is. `what` names what didn't change.
 */
function agentAnswer(answer: AgentOutcome, what: string): Answer {
  if (answer === "ok") return OK;
  if (typeof answer === "string") {
    const [error, status] = AGENT_REFUSED[answer];
    return [{ error, agent: answer }, status];
  }
  return [{ error: `${what} didn't change: ${answer.refused}` }, 500];
}

function refused(code: SettingsRefusal): Answer {
  const [error, status] = REFUSED[code];
  return [{ error, refused: code }, status];
}

/**
 * A settings change's answer (ADR 0049): a file that doesn't read is refused with its error as data (the file, the
 * problem, the key: what Run checks names too), a write that failed with its file and why as `unwritten` (500), a repository whose name is no
 * path, or that the service doesn't watch, as such (`refused`).
 */
function settingsAnswer(answer: SettingsAnswer | "no_such_repository"): Answer {
  if (answer === "ok") return OK;
  if (answer === "no_such_repository") return [{ error: "no such repository" }, 404];
  switch (answer.refused) {
    case "invalid":
      return [{ error: `${answer.error.file} doesn't read`, invalid: answer.error }, 409];
    case "unwritten":
      return [{ error: `${answer.failure.file} was not written`, unwritten: answer.failure }, 500];
    case "unnamed":
      return refused("unnamed");
    case "no_such_rule":
      return refused("no_such_rule");
    default:
      return answer satisfies never;
  }
}

/** The demo clock's verbs in live mode: the room has no demo clock, nothing to move. */
const NO_CLOCK: Answer = [{ error: "no demo clock in live mode" }, 501];

/**
 * The commands the room answers, one row each, looked up once from the route: a new command goes here, by a row;
 * a command with no row answers 501 "not available yet". "Refresh" lists the pull requests now; "Review now"
 * answers 404 for a change the service doesn't see. The clock verbs (ADR 0046) move the room's demo clock, 501 in
 * live mode, where there is none. "Reconnect" is a listing now, and a host that still refuses throws its
 * `HostError` (502 through `onError`, as a refresh); "Run all checks" is refused while the checks run (ADR 0047);
 * "Send the waiting reviews to the other AI" (`engine.reroute`) moves what the other engine may review and takes.
 * "Sign in" is refused while one is pending for that engine (409), and when the login didn't open (500 with the
 * opener's reason: the engine not installed, no terminal program), nothing shown then (ADR 0047).
 * The setup's steps and the repository's switch are kept (404 for a repository the service doesn't watch); "Start at
 * login" is kept and registered by the program on the machine once the setup is done (ADR 0054,
 * `start-at-login.ts`), refused (500, with the machine's reason) when the machine refuses it; the first review is a
 * request, a preview posting nothing when asked so (404 for a change the service doesn't see); "Create it on GitHub"
 * only says where the App is made and that the setup waits for it (the page it opens makes it, `app-flow-pages.ts`),
 * refused (409, why in `createApp`) once an App is kept or under `live.json` (ADR 0053), or for an organisation the
 * person's `gh` doesn't list as theirs to admin, or can't answer for (ADR 0059); `gh.check` reads that `gh` again.
 * "Use an existing App" (`connection.useApp`, ADR 0053) answers why it refused as `useApp` (409, 502 when GitHub
 * couldn't be reached; `live-config` when `live.json` names the App); its key is in no answer.
 * The developer drawer's fault (ADR 0046) happens on the demo driver: 501 in live mode, where nothing scripted
 * touches a real repository, 409 when the story has nothing left for it. A load is the room swap: 404 for an id the
 * catalogue hasn't, 500 with the fixture's error when the seed fails (the old room still answers).
 */
const COMMANDS: { [K in Parsed["type"]]?: Row<K> } = {
  refresh: async ({ room }) => {
    await room.refresh();
    return OK;
  },
  "review.request": async ({ room }, { changeId }) =>
    (await room.review(changeId)) === "no_such_change" ? [{ error: "no such change" }, 404] : OK,
  "engine.check": async ({ room }) => {
    await room.checkEngines();
    return OK;
  },
  "service.pause": async ({ room }, command) => {
    room.pause(command.for);
    return OK;
  },
  "service.resume": async ({ room }) => {
    room.resume();
    return OK;
  },
  "demo.clock": async ({ room }, { running, speed }) => {
    if (room.demo === null) return NO_CLOCK;
    room.demo.set(running, speed);
    return OK;
  },
  "demo.advance": async ({ room }, { ms }) => {
    if (room.demo === null) return NO_CLOCK;
    await room.demo.advance(ms);
    return OK;
  },
  "demo.step": async ({ room }) => {
    if (room.demo === null) return NO_CLOCK;
    await room.demo.step();
    return OK;
  },
  "engine.signIn": async ({ room }, { id }) => {
    const answer = await room.signIn(id);
    if (answer === "ok") return OK;
    if (answer.refused === "pending") return [{ error: `the sign-in of ${id} is already running` }, 409];
    return [{ error: `the sign-in of ${id} didn't open: ${answer.reason}` }, 500];
  },
  "connection.reconnect": async ({ room }) => {
    await room.reconnect();
    return OK;
  },
  "service.runChecks": async ({ room }) =>
    (await room.runChecks()) === "running" ? [{ error: "the checks are already running" }, 409] : OK,
  "service.unlock": async ({ room }) => {
    room.unlock();
    return OK;
  },
  "engine.reroute": async ({ room }, { from }) => {
    room.reroute(from);
    return OK;
  },
  "setup.goto": async ({ room }, { step }) => {
    room.setup.goto(step);
    return OK;
  },
  "setup.chooseRepos": async ({ room }, { enabled }) => {
    room.setup.chooseRepos(enabled);
    return OK;
  },
  "setup.firstReview": async ({ room }, { changeId, preview }) =>
    (await room.setup.firstReview(changeId, preview)) === "ok" ? OK : [{ error: "no such change" }, 404],
  "setup.finish": async ({ room }) => {
    await room.setup.finish();
    return OK;
  },
  "service.startAtLogin": async ({ room }, { on }) => {
    const answer = await room.startAtLogin(on);
    return answer === "ok" ? OK : [{ error: `Start at login didn't change: ${answer.refused}` }, 500];
  },
  "agent.check": async ({ room }) => {
    await room.agent.check();
    return OK;
  },
  "agent.path": async ({ room }, { on }) => agentAnswer(await room.agent.path(on), "The PATH"),
  "agent.skill": async ({ room }, { agent, on }) =>
    agentAnswer(await room.agent.skill(agent, on), "The skill"),
  "settings.set": async ({ room }, { key, value }) =>
    settingsAnswer(await room.settings.setDefault(key, value)),
  "repo.setSetting": async ({ room }, { repoId, key, value }) =>
    settingsAnswer(await room.settings.set(repoId, key, value)),
  "repo.resetSetting": async ({ room }, { repoId, key }) =>
    settingsAnswer(await room.settings.reset(repoId, key)),
  "rule.setEnabled": async ({ room }, { ruleId, enabled }) =>
    settingsAnswer(await room.settings.setRule(ruleId, enabled)),
  "noise.apply": async ({ room }, { choice }) => {
    const answer = await room.settings.quiet(choice);
    if (answer === "no_such_change") return [{ error: "no such change" }, 404];
    if (
      answer === "no_such_finding" ||
      answer === "no_rule" ||
      answer === "settled" ||
      answer === "reviewing"
    )
      return refused(answer);
    return settingsAnswer(answer);
  },
  "repo.setEnabled": async ({ room }, { repoId, enabled }) =>
    room.setup.setEnabled(repoId, enabled) === "ok" ? OK : [{ error: "no such repository" }, 404],
  "repo.dismiss": async ({ room }, { repoId }) =>
    room.dismissDeparted(repoId) === "ok" ? OK : [{ error: "no such departed repository" }, 404],
  "connection.createApp": async ({ room }, { organisation }) => {
    const answer = await room.github.flow.createApp(organisation);
    return answer === "ok" ? OK : [{ error: createAppRefusalText(answer), createApp: answer }, 409];
  },
  "gh.check": async ({ room }) => {
    await room.github.checkGh();
    // "Check again" of a membership lost too (ADR 0059): a member again, reviews go on.
    await room.github.checkMembership();
    return OK;
  },
  "connection.useApp": async ({ room }, { appId, key }) => {
    const answer = await useApp(room.github, appId, key);
    if (answer === "ok") return OK;
    const { refused } = answer;
    const status = refused.kind === "unreachable" ? 502 : 409;
    return [{ error: `the App was refused: ${refused.kind}`, useApp: refused }, status];
  },
  "demo.inject": async ({ demo, restarted, others }, { fault }) => {
    if (demo === null) return [{ error: "nothing scripted in live mode" }, 501];
    const before = demo.room;
    const answer = await demo.inject(fault, others);
    // A fault that restarted the service: the open streams follow the old room's log, and reload instead.
    if (demo.room !== before) restarted();
    return answer === "ok" ? OK : [{ error: NOTHING_TO_INJECT[answer] }, 409];
  },
  "demo.load": async ({ load }, { id }) => {
    if (load === null) return [{ error: "no scenario to load in live mode" }, 501];
    const answer = await load(id);
    if (answer === "ok") return OK;
    if (answer === "no_such_scenario") return [{ error: `no scenario ${id}` }, 404];
    return [{ error: answer.failed }, 500];
  },
};

/** The row for a command's type, if it has one. */
const rowOf = <K extends Parsed["type"]>(type: K): Row<K> | undefined => COMMANDS[type];

/** What `Bun.serve` passes as the environment: enough to turn the idle timeout off for an event stream. */
interface Bindings {
  timeout(request: Request, seconds: number): void;
}

const same = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** `Last-Event-ID` or `?after=` as a number; undefined when absent; null when it is not a number. */
function lastSeen(value: string | undefined): number | null | undefined {
  if (value === undefined) return undefined;
  return /^\d+$/.test(value) ? Number(value) : null;
}

/** An error as a log line: its stack, which starts with its message, when it has one. */
export const described = (error: unknown): string =>
  error instanceof Error ? (error.stack ?? error.message) : String(error);

export function createApi(deps: ApiDeps) {
  const { origin, session, room, demo, loader } = deps;
  const host = new URL(origin).host;
  let tokenUsed = false;
  /** The minted links' tokens, each with when it was minted: one leaves once used or two minutes old. */
  const minted = new Map<string, number>();
  /** A minted link that opens the app no more, used or expired: out of the map and out of the log's filter. */
  const spent = (token: string) => {
    minted.delete(token);
    deps.forget(token);
  };
  /** Drops the minted links two minutes old. */
  const expire = () => {
    const now = deps.timers.now();
    for (const [token, at] of minted) if (now - at >= LINK_MS) spent(token);
  };
  /**
   * Whether `token` opens the app, using it up: the start's once, a minted one once within two minutes. Compared in
   * constant time, each in turn: a map lookup would answer faster for a near miss.
   */
  const opens = (token: string): boolean => {
    if (!tokenUsed && session.token !== null && same(token, session.token)) {
      tokenUsed = true;
      return true;
    }
    expire();
    for (const kept of minted.keys()) {
      if (!same(token, kept)) continue;
      spent(kept);
      return true;
    }
    return false;
  };
  /** Every open stream's way to say reload: told once the rooms are swapped (ADR 0046). */
  const reloaders = new Set<() => void>();
  const reloadAll = () => {
    for (const reload of reloaders) reload();
  };
  /** The commands under way, a load aside: a load waits for them before it reads where the old room stopped. */
  const underWay = new Set<Promise<unknown>>();
  const settled = async () => {
    await Promise.allSettled([...underWay]);
  };
  /** The load as a command reaches it: the swap, then every open stream told to reload. Null in live mode. */
  const load =
    loader === null
      ? null
      : async (id: string): Promise<Loaded> => {
          const answer = await loader.load(id, settled);
          if (answer === "ok") reloadAll();
          return answer;
        };
  const app = new Hono<{ Bindings: Bindings }>();

  // Before the route: every response has the policy, the ones built by `onError` included. Every path is the app's
  // host's alone, the web app's files as much as the API: a page served under another name (DNS rebinding) would
  // be another origin's, on the app's port.
  app.use("*", async (c, next) => {
    c.header("Content-Security-Policy", CSP);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    if (c.req.header("host") !== host) return c.json({ error: "wrong host" }, 403);
    return next();
  });

  /** Why a request is not the app's, from its headers alone; null when it is. */
  const foreign = (header: (name: string) => string | undefined, method: string): string | null => {
    const from = header("origin");
    if (from !== undefined && from !== origin) return "foreign origin";
    if (from === undefined && method !== "GET") return "no origin";
    // A GET carries no Origin, and a cookie on 127.0.0.1 is shared by every port: the browser's own word on it.
    const site = header("sec-fetch-site");
    if (site !== undefined && !OWN_SITE.has(site)) return "foreign site";
    return null;
  };

  app.use(`${API.prefix}/*`, async (c, next) => {
    // GitHub's redirects to the manifest flow's pages carry no session and come from another site (ADR 0053).
    if (c.req.path === API.session || OPEN_PAGES.has(c.req.path)) return next();
    const refused = foreign((name) => c.req.header(name), c.req.method);
    if (refused) return c.json({ error: refused }, 403);
    const cookie = getCookie(c, session.cookie);
    if (cookie === undefined || !same(cookie, session.secret)) {
      // Demo mode plays the program's 401 where its scenario plants the program's command (S14, for proof).
      const namesOpen = deps.namesOpen || deps.demo()?.scenario.world.namesOpen === true;
      const signedOut: NoSession = namesOpen
        ? { error: "no session", open: `${room().snapshot().service.command} open` }
        : { error: "no session" };
      return c.json(signedOut, 401);
    }
    return next();
  });

  app.get(API.session, (c) => {
    if (!opens(c.req.query("token") ?? "")) return c.json({ error: "this link was used" }, 403);
    setCookie(c, session.cookie, session.secret, { httpOnly: true, sameSite: "Strict", path: "/" });
    return c.redirect("/", 303);
  });

  app.get(API.snapshot, (c) => c.json(room().snapshot()));

  // The log file's last lines (ADR 0055), filtered as the file keeps them: a file, not state, so nothing numbers them.
  app.get(API.logs, (c) => c.json(deps.logs?.tail() ?? []));

  // `lookover open` and `lookover start` (ADR 0054): a link that opens the app once, within two minutes, its token
  // known to the log's filter before anyone sees it. Several may be live at once.
  app.post(API.link, (c) => {
    expire();
    const token = randomToken();
    deps.secret(token);
    minted.set(token, deps.timers.now());
    const link: MintedLink = { url: `${origin}${API.session}?token=${token}` };
    return c.json(link);
  });

  // `lookover stop` (ADR 0054): answered first, then the service stops as Ctrl+C stops it. The stop waits for the
  // answer to leave, since it closes every connection, this one included.
  app.post(API.stop, (c) => {
    setImmediate(deps.stop);
    return c.json({ ok: true });
  });

  // The developer drawer's listing (ADR 0046): the scenarios, the one loaded, the clock and the faults. In live
  // mode there is nothing to list: nothing scripted touches a real repository.
  app.get(DEMO_API.listing, (c) => {
    const driver = demo();
    if (driver === null) return c.json({ error: "no demo in live mode" }, 404);
    return c.json(driver.listing());
  });

  app.get(API.events, async (c) => {
    const after = lastSeen(c.req.header("last-event-id") ?? c.req.query(API.after));
    if (after === null) return c.json({ error: "the last event number must be a number" }, 400);
    c.env.timeout(c.req.raw, 0);
    // A stream opened while a scenario loads waits for the room it will follow: a number from the old room is
    // then from before the new room's start, and is told to reload.
    await loader?.loading();
    const { events } = room();
    return streamSSE(c, async (stream) => {
      // Every write goes through one chain, so what was missed goes out before what happens meanwhile.
      let chain: Promise<unknown> = stream.write(": connected\n\n");
      const write = (work: () => Promise<unknown>) => {
        chain = chain.then(work);
      };
      let sent = 0;
      const send = (event: Event) => {
        if (event.seq <= sent) return;
        sent = event.seq;
        write(() =>
          stream.writeSSE({ id: String(event.seq), event: SSE.event, data: JSON.stringify(event) }),
        );
      };
      // The replay and the live stream are decided together, before anything is awaited: no event falls between.
      const missed = after === undefined ? [] : events.since(after);
      const unsubscribe = events.subscribe(send);
      // Each line the log file gains (ADR 0055), with no id: the browser's `Last-Event-ID` stays the last event's.
      const unsubscribeLogs =
        deps.logs?.subscribe((line) =>
          write(() => stream.writeSSE({ event: SSE.log, data: JSON.stringify({ line }) })),
        ) ?? (() => {});
      const reload = () => write(() => stream.writeSSE({ event: SSE.reload, data: "{}" }));
      if (missed === null) reload();
      else for (const event of missed) send(event);
      // A room swapped in (ADR 0046): this stream follows the old room's log, and says reload instead; the tab
      // then fetches the snapshot and opens a new stream on the new room (#126 F3).
      reloaders.add(reload);
      // An event, not a comment: the browser's `EventSource` sees it, so the client can tell a dead
      // connection (a proxy or a sleeping laptop keeps one open without a word) from a quiet one. It carries
      // the service's `now` (ADR 0046): a tab follows the current room's clock between events, as a `clock`
      // event it applies and never stores, so it never runs ahead of a clock standing still.
      let cancelKeepalive = () => {};
      const keepalive = () => {
        const at = room().clock.now();
        write(() => stream.writeSSE({ event: SSE.keepalive, data: JSON.stringify({ at }) }));
        cancelKeepalive = deps.timers.after(deps.keepaliveMs, keepalive);
      };
      cancelKeepalive = deps.timers.after(deps.keepaliveMs, keepalive);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      reloaders.delete(reload);
      cancelKeepalive();
      unsubscribe();
      unsubscribeLogs();
    });
  });

  appFlowPages(app, { origin, room, demo });

  app.post(API.commands, async (c) => {
    const parsed = request.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "invalid command", issues: parsed.error.issues }, 400);
    // The one word the app knows for it (ADR 0046): while a scenario loads, or the service restarts (the drawer's
    // "key-lost"), nothing is done to either room.
    if ((loader?.loading() ?? demo()?.restarting() ?? null) !== null)
      return c.json({ error: "loading" }, 409);
    const command = parsed.data;
    const work = (async () => {
      const row = rowOf(command.type);
      if (row === undefined) return c.json({ error: "not available yet" }, 501);
      const others = async () => {
        await Promise.allSettled([...underWay].filter((w) => w !== work));
      };
      const [body, status] = await row(
        { room: room(), demo: demo(), load, restarted: reloadAll, others },
        command,
      );
      return c.json(body, status);
    })();
    if (command.type === "demo.load") return work;
    // Counted from its start, nothing awaited since the latch was read: a load begun later waits for its answer.
    underWay.add(work);
    try {
      return await work;
    } finally {
      underWay.delete(work);
    }
  });

  // An error no route expected is the log's, through its filter (ADR 0054), never Bun's to print whole: the request
  // is answered 500.
  app.onError((error, c) => {
    if (error instanceof HostError) return c.json({ error: error.failure }, 502);
    deps.log(`${c.req.method} ${c.req.path} failed: ${described(error)}`);
    return c.json({ error: "internal" }, 500);
  });

  // Last: what no route above answered.
  if (deps.webFiles !== null) serveWebFiles(app, deps.webFiles);

  return app;
}
