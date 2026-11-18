// The real tray (ADR 0105 §4-7): `lookover-tray`, the Rust helper, started by the service and spoken to over its
// standard streams, one JSON object a line. It first says `ready` with its version and protocol, or `unavailable`
// with why; then each view is a `show` line in and each click a `click` line out, and it exits when its standard
// input closes. The helper is found in a clone's `dist/` (`bun run lookover`), else beside the executable
// (`trayHelperPath`). It can't run, and says so through `start`'s `{ unavailable }` (which the keeper logs), when it
// is missing (from a clone: run `bun run build`), when Linux has no desktop (neither `DISPLAY` nor `WAYLAND_DISPLAY`:
// never started), when it says another version or protocol than the program's (from a clone: run `bun run build`),
// says nothing in 10 s, says something else first or stops before it is ready. `readTrayFirstLine` is that reading of
// its first line, which the build's and the release smoke's checks share (`trayHelperName`, its file name, too): both
// live in `tray-protocol.ts`, which imports nothing, so the smoke reaches them where nothing was installed.
// What it writes on its standard error is logged, line by line. A click whose handling throws is logged as that
// click's failure (the Pause that didn't pause): the helper goes on.
// It is gone once it exited and its standard output ended, so what it said last is heard first. A line longer than
// 64 KiB, on either stream, is cut there, and the log says so.
// Its end once ready (it stopped, or can't be written to) goes to `onEnd`, once, never after `stop`; `stop` closes
// its standard input, and kills it if it still runs a moment later. `show` never throws.
// It refuses to be built under `bun test` (ADR 0045) unless a test gives what starts it (a scripted helper): no test
// puts an icon on the screen.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { underTest } from "./config.ts";
import { said } from "./said.ts";
import { REAL_TIMERS, type Timers } from "./timers.ts";
import type { RunningTray, Tray, TrayItem } from "./tray.ts";
import { readTrayFirstLine, trayHelperName } from "./tray-protocol.ts";

/** How long the helper has to say `ready` (ADR 0105 §5). */
const READY_MS = 10_000;

/** How long a stopped helper has to exit once its standard input is closed, before it is killed. */
const STOP_MS = 2_000;

/** The longest line read from the helper, in characters: the rest of a longer one is cut, and the log says so. */
const LINE_MAX = 64 * 1024;

/** Why there is no tray when the helper isn't where it is looked for (ADR 0105 §6, §17). */
const MISSING = "No lookover-tray beside this executable";

/** Why there is no tray when a clone's `dist/` holds no helper: its build makes one (ADR 0105 §14). */
const MISSING_IN_CLONE = "No lookover-tray in this clone's dist/: run `bun run build`";

/** Why there is no tray on Linux without a desktop (ADR 0105 §7). */
const NO_DESKTOP = "No desktop to show an icon on";

const UNDER_TEST =
  "The real tray never runs under bun test: a test puts no icon on this screen (ADR 0045). Use memoryTray, or helperTray with a scripted spawn.";

const ITEMS = {
  open: true,
  "pause.hour": true,
  "pause.tomorrow": true,
  "pause.forever": true,
  resume: true,
  quit: true,
} satisfies Record<TrayItem, true>;

/** What the log says when a click's handling throws, before what it said: the menu's item, and what it didn't do. */
const CLICK_FAILED = {
  open: "The tray's Open didn't open Lookover",
  "pause.hour": "The tray's Pause for 1 hour didn't pause",
  "pause.tomorrow": "The tray's Pause until tomorrow didn't pause",
  "pause.forever": "The tray's Pause until I resume didn't pause",
  resume: "The tray's Resume didn't resume",
  quit: "The tray's Quit didn't quit Lookover",
} satisfies Record<TrayItem, string>;

export interface HelperTrayOptions {
  /** The helper's file (`trayHelperPath`). */
  path: string;
  /**
   * What starts the helper (`argv`, its file first) with `options`: `Bun.spawn` by default. A test gives one that
   * runs a scripted helper with Bun.
   */
  spawn?: (argv: string[], options: HelperSpawnOptions) => HelperProcess;
  /** The program's version, which the helper's `ready` must name. */
  version: string;
  /** Whether this runs from a clone, where a helper of another version is rebuilt with `bun run build`. */
  clone: boolean;
  platform: NodeJS.Platform;
  /** The environment the helper starts with, and where Linux's desktop is read. */
  env: Record<string, string | undefined>;
  /** Where the helper's standard error goes, a line at a time. */
  log(line: string): void;
  timers?: Pick<Timers, "after">;
}

/** How the helper is started: its three streams piped, in `env`, with no window of its own. */
interface HelperSpawnOptions {
  stdin: "pipe";
  stdout: "pipe";
  stderr: "pipe";
  env: Record<string, string | undefined>;
  windowsHide: true;
}

/** What the tray reads of the helper's process. */
type HelperProcess = Pick<
  Bun.Subprocess<"pipe", "pipe", "pipe">,
  "stdin" | "stdout" | "stderr" | "exited" | "exitCode" | "kill"
>;

/**
 * Where the helper is looked for (ADR 0105 §6): beside `executable`, the binary (`dist/` of a clone's build, or the
 * npm platform package's folder); in `clone`'s `dist/` when Lookover runs from a clone (`executable` null).
 */
export function trayHelperPath(executable: string | null, clone: string, platform: NodeJS.Platform): string {
  return join(executable === null ? join(clone, "dist") : dirname(executable), trayHelperName(platform));
}

/** The real tray: `lookover-tray` at `o.path`. Throws under `bun test` without `o.spawn`. */
export function helperTray(o: HelperTrayOptions): Tray {
  if (o.spawn === undefined && underTest()) throw new Error(UNDER_TEST);
  const spawn = o.spawn ?? ((argv: string[], options: HelperSpawnOptions) => Bun.spawn(argv, options));
  const timers = o.timers ?? REAL_TIMERS;
  return {
    start: async (onClick, onEnd) => {
      if (o.platform === "linux" && !o.env.DISPLAY && !o.env.WAYLAND_DISPLAY)
        return { unavailable: NO_DESKTOP };
      if (!existsSync(o.path)) return { unavailable: o.clone ? MISSING_IN_CLONE : MISSING };
      let child: HelperProcess;
      try {
        child = spawn([o.path], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: o.env,
          windowsHide: true,
        });
      } catch (error) {
        return { unavailable: `lookover-tray didn't start: ${said(error)}` };
      }
      void eachLine(child.stderr, "standard error", o.log, o.log).catch((error: unknown) =>
        o.log(`lookover-tray's standard error can't be read: ${said(error)}`),
      );
      return await new Session(child, o, timers, { onClick, onEnd }).ready();
    },
  };
}

/**
 * Calls `line` with each line `stream` (the helper's `name`) gives, without its line end, until it ends; a line
 * longer than `LINE_MAX` is cut there, and `log` says so before it is given.
 */
async function eachLine(
  stream: ReadableStream<Uint8Array>,
  name: string,
  line: (text: string) => void,
  log: (text: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let rest = "";
  let cut = false;
  for await (const chunk of stream) {
    const parts = decoder.decode(chunk, { stream: true }).split("\n");
    for (const [i, part] of parts.entries()) {
      if (!cut) rest += part;
      if (!cut && rest.length > LINE_MAX) {
        rest = rest.slice(0, LINE_MAX);
        cut = true;
        log(`lookover-tray wrote a line longer than 64 KiB on its ${name}: the rest of it is cut`);
      }
      if (i === parts.length - 1) continue;
      line(rest.replace(/\r$/, ""));
      rest = "";
      cut = false;
    }
  }
  if (rest !== "") line(rest);
}

/** What a helper's first line is to its session: ready, or why there is no tray. */
type First = { ready: true } | { unavailable: string };

/** One run of the helper, from its start to its end. */
class Session {
  private first: ((answer: First) => void) | null = null;
  private cancelReady: () => void = () => undefined;
  private ended = false;
  private stopped = false;
  private exitWait: (() => void) | null = null;

  private readonly child: HelperProcess;
  private readonly o: HelperTrayOptions;
  private readonly timers: Pick<Timers, "after">;
  private readonly onClick: (item: TrayItem) => void;
  private readonly onEnd: (reason: string) => void;

  constructor(
    child: HelperProcess,
    o: HelperTrayOptions,
    timers: Pick<Timers, "after">,
    ends: { onClick: (item: TrayItem) => void; onEnd: (reason: string) => void },
  ) {
    this.child = child;
    this.o = o;
    this.timers = timers;
    this.onClick = ends.onClick;
    this.onEnd = ends.onEnd;
  }

  async ready(): Promise<RunningTray | { unavailable: string }> {
    const answer = await new Promise<First>((resolve) => {
      this.first = resolve;
      const cancel = this.timers.after(READY_MS, () =>
        this.answer({ unavailable: `lookover-tray said nothing in ${READY_MS / 1000} s` }),
      );
      this.cancelReady = cancel;
      const read = eachLine(this.child.stdout, "standard output", (line) => this.heard(line), this.o.log);
      void read.catch((error: unknown) => this.gone(`its standard output can't be read: ${said(error)}`));
      // Gone only once what it wrote is all heard: its last line can come after its exit.
      // An unreadable output is heard above.
      void Promise.all([read, this.child.exited]).then(
        ([, code]) => this.gone(`exit code ${code}`),
        () => undefined,
      );
    });
    if ("unavailable" in answer) {
      this.close();
      return answer;
    }
    return { show: (view) => this.write({ type: "show", ...view }), stop: () => this.stop() };
  }

  /** The helper's first answer, heard once: refused, it is stopped at once, so its end is never heard. */
  private answer(first: First): void {
    const resolve = this.first;
    this.first = null;
    this.cancelReady();
    if ("unavailable" in first) this.stopped = true;
    resolve?.(first);
  }

  /** The helper stopped (`why`): before it was ready, it is unavailable; after, it ended. */
  private gone(why: string): void {
    if (this.first === null) this.end(`lookover-tray stopped (${why})`);
    else this.answer({ unavailable: `lookover-tray stopped before it was ready (${why})` });
  }

  private heard(line: string): void {
    if (this.first !== null) {
      this.answer(this.firstOf(line));
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      message = null;
    }
    if (isClick(message)) this.clicked(message.item);
    else this.o.log(`lookover-tray said a line Lookover doesn't read: ${line}`);
  }

  /** `item` handed to `onClick`: its handling failing is that click's, logged, never the helper's output's. */
  private clicked(item: TrayItem): void {
    try {
      this.onClick(item);
    } catch (error) {
      this.o.log(`${CLICK_FAILED[item]}: ${said(error)}`);
    }
  }

  /** What the first `line` means here: refused from a clone, a stale helper is rebuilt with `bun run build`. */
  private firstOf(line: string): First {
    const first = readTrayFirstLine(line, this.o.version);
    if (!("refused" in first)) return first;
    return { unavailable: `${first.refused}${first.stale && this.o.clone ? ": run `bun run build`" : ""}` };
  }

  private write(line: object): void {
    if (this.stopped || this.ended) return;
    try {
      this.child.stdin.write(`${JSON.stringify(line)}\n`);
      void Promise.resolve(this.child.stdin.flush()).catch((error: unknown) => this.broken(error));
    } catch (error) {
      this.broken(error);
    }
  }

  /** The helper can't be written to any more: it ends, and is stopped. */
  private broken(error: unknown): void {
    this.end(`lookover-tray can't be told what to show: ${said(error)}`);
    this.close();
  }

  private end(reason: string): void {
    if (this.ended || this.stopped) return;
    this.ended = true;
    this.onEnd(reason);
  }

  private stop(): void {
    this.stopped = true;
    this.close();
  }

  /** Its standard input closed, so it exits; killed if it still runs a moment later. */
  private close(): void {
    // A pipe closed already (the helper gone) has nothing left to close: its end is heard through `exited`.
    void Promise.resolve()
      .then(() => this.child.stdin.end())
      .catch(() => undefined);
    if (this.exitWait !== null || this.child.exitCode !== null) return;
    this.exitWait = this.timers.after(STOP_MS, () => this.child.kill());
    void this.child.exited.then(() => this.exitWait?.());
  }
}

const isClick = (said: unknown): said is { type: "click"; item: TrayItem } =>
  typeof said === "object" &&
  said !== null &&
  "type" in said &&
  said.type === "click" &&
  "item" in said &&
  typeof said.item === "string" &&
  Object.hasOwn(ITEMS, said.item);
