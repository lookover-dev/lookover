// The real tray (ADR 0105 §4-7), `helperTray`, on a scripted helper: a Bun script that speaks `lookover-tray`'s
// protocol as ADR 0105 §4 says it (`ready` or `unavailable` first, `show` lines in, `click` lines out, an exit when its
// standard input closes), or doesn't (silent, another version, dying, deaf to its input's end), and writes down each
// line it was sent. It is started through the port with the spawn a test gives (run by Bun, or with its output held
// past its exit), so `bun test` never draws an icon; the real helper, run as it is, refuses to start here.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitUntil } from "@lookover/testkit";
import type { TrayView } from "@lookover/web/tray";
import { helperTray, type Timers, type Tray, type TrayItem, trayHelperName } from "./index.ts";

type RunningTray = Exclude<Awaited<ReturnType<Tray["start"]>>, { unavailable: string }>;

// Each start runs a Bun process: seconds apiece on a busy machine.
setDefaultTimeout(30_000);

const VERSION = "0.17.0";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "lookover-tray-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let made = 0;

/** How the scripted helper behaves: what it says first, and what it does after. */
type Script =
  | { says: "ready"; version?: string; protocol?: number | string; after?: "dies" | "stays" }
  | { says: "unavailable"; reason: string }
  | { says: "nothing" }
  | { says: "dies" };

/**
 * A scripted helper in its own folder: it says what `script` says on its first line and its standard error, then
 * writes each line it is sent to `got.jsonl`, answers a `show` whose line is `click <item>` with that click, and a
 * `show` whose line is `die` by exiting 3, `last click` by saying the click `open` and exiting 0 in the same tick,
 * `long` by writing a line of 100 000 characters on each stream; on its standard input's end it writes `closed` and
 * exits 0. A helper that `stays` never reads its standard input. It writes its process id to `pid`.
 */
function scriptedHelper(script: Script): {
  path: string;
  got: () => string[];
  closed: () => boolean;
  pid: () => number | null;
} {
  const dir = join(scratch, `helper ${++made}`);
  mkdirSync(dir);
  const got = join(dir, "got.jsonl");
  const closed = join(dir, "closed");
  const pid = join(dir, "pid");
  const path = join(dir, "lookover-tray.ts");
  writeFileSync(
    path,
    `const script = ${JSON.stringify(script)};
const say = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
process.stderr.write("lookover-tray: started\\n");
require("node:fs").writeFileSync(${JSON.stringify(pid)}, String(process.pid));
if (script.says === "dies") process.exit(5);
if (script.says === "unavailable") { say({ type: "unavailable", reason: script.reason }); process.exit(0); }
if (script.says === "ready") say({ type: "ready", version: script.version ?? ${JSON.stringify(VERSION)}, protocol: script.protocol ?? 1 });
if (script.after === "dies") process.exit(4);
if (script.after === "stays") setInterval(() => {}, 1000);
else {
let rest = "";
for await (const chunk of Bun.stdin.stream()) {
  rest += new TextDecoder().decode(chunk);
  const lines = rest.split("\\n");
  rest = lines.pop();
  for (const line of lines) {
    require("node:fs").appendFileSync(${JSON.stringify(got)}, line + "\\n");
    const show = JSON.parse(line);
    if (show.line.startsWith("click ")) say({ type: "click", item: show.line.slice(6) });
    if (show.line === "die") { process.stderr.write("lookover-tray: asked to die\\n"); process.exit(3); }
    if (show.line === "last click") { say({ type: "click", item: "open" }); process.exit(0); }
    if (show.line === "long") { process.stderr.write("e".repeat(100000) + "\\n"); say("o".repeat(100000)); }
  }
}
require("node:fs").writeFileSync(${JSON.stringify(closed)}, "closed");
}
`,
  );
  return {
    path,
    got: () => (existsSync(got) ? readFileSync(got, "utf8").split("\n").filter(Boolean) : []),
    closed: () => existsSync(closed),
    pid: () => (existsSync(pid) ? Number(readFileSync(pid, "utf8")) : null),
  };
}

/** Timers whose waits a test fires by hand: each asked for is kept, with its time. */
function handTimers(): { timers: Pick<Timers, "after">; fire(ms: number): void; asked(): number[] } {
  const waits: { ms: number; fire: () => void; cancelled: boolean }[] = [];
  return {
    timers: {
      after: (ms, fire) => {
        const wait = { ms, fire, cancelled: false };
        waits.push(wait);
        return () => {
          wait.cancelled = true;
        };
      },
    },
    fire: (ms) => {
      for (const wait of waits.filter((w) => w.ms === ms && !w.cancelled)) wait.fire();
    },
    asked: () => waits.filter((w) => !w.cancelled).map((w) => w.ms),
  };
}

type Spawn = NonNullable<Parameters<typeof helperTray>[0]["spawn"]>;

/** Runs the scripted helper with this Bun. */
const byBun: Spawn = (argv, options) => Bun.spawn([process.execPath, ...argv], options);

/** Runs it with this Bun, what its standard output says but `ready` heard only a moment after it exited. */
const outputAfterExit: Spawn = (argv, options) => {
  const child = byBun(argv, options);
  const late = new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
    transform: async (chunk, out) => {
      if (!new TextDecoder().decode(chunk).includes('"type":"ready"')) await child.exited;
      await Bun.sleep(100);
      out.enqueue(chunk);
    },
  });
  return {
    stdin: child.stdin,
    stdout: child.stdout.pipeThrough(late),
    stderr: child.stderr,
    exited: child.exited,
    get exitCode() {
      return child.exitCode;
    },
    kill: (signal) => child.kill(signal),
  };
};

/**
 * A desktop session's environment: on Linux the port starts no helper without a display, and the machine that runs
 * the tests (CI's) may have none.
 */
const DESKTOP = { DISPLAY: ":0" };

/** The port on `helper`, run by this Bun, its log lines and its ends kept. */
function trayOn(
  helper: { path: string },
  o: {
    platform?: NodeJS.Platform;
    env?: Record<string, string>;
    timers?: Pick<Timers, "after">;
    spawn?: Spawn;
    clone?: boolean;
    /** What a click does once it is kept: a throw here is the click's handling failing. */
    clicked?: (item: TrayItem) => void;
  } = {},
) {
  const logged: string[] = [];
  const clicks: TrayItem[] = [];
  const ends: string[] = [];
  /** The clicks and ends in the order they came. */
  const heard: string[] = [];
  const tray = helperTray({
    path: helper.path,
    spawn: o.spawn ?? byBun,
    version: VERSION,
    clone: o.clone ?? false,
    platform: o.platform ?? process.platform,
    env: o.env ?? DESKTOP,
    log: (line) => logged.push(line),
    ...(o.timers === undefined ? {} : { timers: o.timers }),
  });
  const start = () =>
    tray.start(
      (item) => {
        clicks.push(item);
        heard.push(`click ${item}`);
        o.clicked?.(item);
      },
      (reason) => {
        ends.push(reason);
        heard.push(`end: ${reason}`);
      },
    );
  return { tray, start, logged, clicks, ends, heard };
}

const view = (line: string): TrayView => ({
  state: "idle",
  tooltip: `Lookover: ${line}`,
  line,
  paused: false,
});

/** Whether the process `pid` still runs. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The running tray `answer` is, or a failed test. */
function running(answer: RunningTray | { unavailable: string }): RunningTray {
  if ("unavailable" in answer) throw new Error(`unavailable: ${answer.unavailable}`);
  return answer;
}

test("a helper that says ready is told each view, as one show line each", async () => {
  const helper = scriptedHelper({ says: "ready" });
  const { start } = trayOn(helper);
  const icon = running(await start());
  icon.show(view("All good"));
  icon.show({
    state: "paused",
    tooltip: "Lookover: Paused until you resume",
    line: "Paused until you resume",
    paused: true,
  });
  await waitUntil(() => helper.got().length === 2, 10_000);
  expect(helper.got().map((line) => JSON.parse(line))).toEqual([
    { type: "show", state: "idle", tooltip: "Lookover: All good", line: "All good", paused: false },
    {
      type: "show",
      state: "paused",
      tooltip: "Lookover: Paused until you resume",
      line: "Paused until you resume",
      paused: true,
    },
  ]);
  icon.stop();
});

test("a click the helper says reaches onClick; a line it can't read and its standard error are logged", async () => {
  const helper = scriptedHelper({ says: "ready" });
  const { start, clicks, logged } = trayOn(helper);
  const icon = running(await start());
  icon.show(view("click pause.hour"));
  icon.show(view("click open"));
  icon.show(view("click snooze"));
  await waitUntil(() => clicks.length === 2 && logged.length === 2, 10_000);
  expect(clicks).toEqual(["pause.hour", "open"]);
  expect(logged).toEqual([
    "lookover-tray: started",
    'lookover-tray said a line Lookover doesn\'t read: {"type":"click","item":"snooze"}',
  ]);
  icon.stop();
});

test("a click whose handling throws is logged as that click's failure, and the helper keeps running", async () => {
  const helper = scriptedHelper({ says: "ready" });
  const clicked = (item: TrayItem) => {
    throw new Error(`no ${item} today`);
  };
  const { start, clicks, logged, ends } = trayOn(helper, { clicked });
  const icon = running(await start());
  const items: TrayItem[] = ["open", "pause.hour", "pause.tomorrow", "pause.forever", "resume", "quit"];
  for (const item of items) icon.show(view(`click ${item}`));
  await waitUntil(() => clicks.length === items.length && helper.got().length === items.length, 10_000);
  expect(logged.filter((line) => line.startsWith("The tray's"))).toEqual([
    "The tray's Open didn't open Lookover: no open today",
    "The tray's Pause for 1 hour didn't pause: no pause.hour today",
    "The tray's Pause until tomorrow didn't pause: no pause.tomorrow today",
    "The tray's Pause until I resume didn't pause: no pause.forever today",
    "The tray's Resume didn't resume: no resume today",
    "The tray's Quit didn't quit Lookover: no quit today",
  ]);
  // Still running: told a view after, it hears it, and its end is the stop's, never heard.
  icon.show(view("All good"));
  await waitUntil(() => helper.got().length === items.length + 1, 10_000);
  icon.stop();
  await waitUntil(() => helper.closed(), 10_000);
  expect(ends).toEqual([]);
});

test("a helper that says nothing in 10 s is unavailable, and stopped", async () => {
  const helper = scriptedHelper({ says: "nothing" });
  const hand = handTimers();
  const { start, ends } = trayOn(helper, { timers: hand.timers });
  const answer = start();
  await waitUntil(() => hand.asked().includes(10_000), 10_000);
  hand.fire(10_000);
  expect(await answer).toEqual({ unavailable: "lookover-tray said nothing in 10 s" });
  await waitUntil(helper.closed, 10_000);
  expect(ends).toEqual([]);
});

test("a helper of another version or protocol is refused, saying why; from a clone, to run bun run build", async () => {
  const older = trayOn(scriptedHelper({ says: "ready", version: "0.16.0" }));
  expect(await older.start()).toEqual({ unavailable: "lookover-tray is version 0.16.0, not 0.17.0" });

  const other = trayOn(scriptedHelper({ says: "ready", protocol: 2 }));
  expect(await other.start()).toEqual({ unavailable: "lookover-tray speaks protocol 2, not 1" });

  const text = trayOn(scriptedHelper({ says: "ready", protocol: "1" }));
  expect(await text.start()).toEqual({ unavailable: 'lookover-tray speaks protocol "1", not 1' });

  const helper = scriptedHelper({ says: "ready", version: "0.16.0" });
  const clone = helperTray({
    path: helper.path,
    spawn: byBun,
    version: VERSION,
    clone: true,
    platform: process.platform,
    env: DESKTOP,
    log: () => {},
  });
  expect(
    await clone.start(
      () => {},
      () => {},
    ),
  ).toEqual({
    unavailable: "lookover-tray is version 0.16.0, not 0.17.0: run `bun run build`",
  });
  // Refused, it is told to go: its standard input closed.
  await waitUntil(helper.closed, 10_000);
});

test("a helper that can't show an icon says why, and is unavailable", async () => {
  const { start } = trayOn(scriptedHelper({ says: "unavailable", reason: "No tray host on this desktop" }));
  expect(await start()).toEqual({ unavailable: "No tray host on this desktop" });
});

test("a helper that exits before its standard output has said why is heard to the end", async () => {
  const helper = scriptedHelper({ says: "unavailable", reason: "No tray host on this desktop" });
  const { start } = trayOn(helper, { spawn: outputAfterExit });
  expect(await start()).toEqual({ unavailable: "No tray host on this desktop" });
});

test("a click the helper says as it exits reaches onClick before its end", async () => {
  const { start, heard } = trayOn(scriptedHelper({ says: "ready" }), { spawn: outputAfterExit });
  const icon = running(await start());
  icon.show(view("last click"));
  await waitUntil(() => heard.length === 2, 10_000);
  expect(heard).toEqual(["click open", "end: lookover-tray stopped (exit code 0)"]);
});

test("a line longer than 64 KiB is cut there, on either stream, and the log says so once", async () => {
  const { start, logged } = trayOn(scriptedHelper({ says: "ready" }));
  const icon = running(await start());
  icon.show(view("long"));
  await waitUntil(() => logged.length === 5, 10_000);
  expect(logged.slice(1).sort()).toEqual(
    [
      "lookover-tray wrote a line longer than 64 KiB on its standard error: the rest of it is cut",
      "e".repeat(65_536),
      "lookover-tray wrote a line longer than 64 KiB on its standard output: the rest of it is cut",
      `lookover-tray said a line Lookover doesn't read: "${"o".repeat(65_535)}`,
    ].sort(),
  );
  icon.stop();
});

test("a helper still running a moment after stop is killed", async () => {
  const helper = scriptedHelper({ says: "ready", after: "stays" });
  const hand = handTimers();
  const { start, ends } = trayOn(helper, { timers: hand.timers });
  const icon = running(await start());
  icon.stop();
  expect(hand.asked()).toContain(2_000);
  await Bun.sleep(300);
  const pid = helper.pid() ?? 0;
  expect(isRunning(pid)).toBe(true);
  hand.fire(2_000);
  await waitUntil(() => !isRunning(pid), 10_000);
  expect(ends).toEqual([]);
});

test("a helper that stops before it is ready is unavailable; once ready, its end reaches onEnd once", async () => {
  const early = trayOn(scriptedHelper({ says: "dies" }));
  expect(await early.start()).toEqual({
    unavailable: "lookover-tray stopped before it was ready (exit code 5)",
  });
  expect(early.ends).toEqual([]);

  const { start, ends, logged } = trayOn(scriptedHelper({ says: "ready" }));
  const icon = running(await start());
  icon.show(view("die"));
  await waitUntil(() => ends.length > 0, 10_000);
  expect(ends).toEqual(["lookover-tray stopped (exit code 3)"]);
  await waitUntil(() => logged.includes("lookover-tray: asked to die"), 10_000);
  // Told again once it ended, it says nothing more, and throws nothing.
  icon.show(view("All good"));
  icon.stop();
  expect(ends).toEqual(["lookover-tray stopped (exit code 3)"]);
});

test("stop closes the helper's standard input, and its end is never heard after", async () => {
  const helper = scriptedHelper({ says: "ready" });
  const { start, ends } = trayOn(helper);
  const icon = running(await start());
  icon.stop();
  await waitUntil(helper.closed, 10_000);
  await Bun.sleep(200);
  expect(ends).toEqual([]);
});

test("a helper that isn't there is unavailable, said as the release says it", async () => {
  const { start } = trayOn({ path: join(scratch, "nowhere", "lookover-tray.exe") });
  expect(await start()).toEqual({ unavailable: "No lookover-tray beside this executable" });
});

test("from a clone with no helper built, it is missing from the clone's dist/, built by bun run build", async () => {
  const { start } = trayOn({ path: join(scratch, "nowhere", "dist", "lookover-tray.exe") }, { clone: true });
  expect(await start()).toEqual({
    unavailable: "No lookover-tray in this clone's dist/: run `bun run build`",
  });
});

test("on Linux without DISPLAY or WAYLAND_DISPLAY the helper is never started", async () => {
  const helper = scriptedHelper({ says: "ready" });
  const bare = trayOn(helper, { platform: "linux", env: {} });
  expect(await bare.start()).toEqual({ unavailable: "No desktop to show an icon on" });
  await Bun.sleep(200);
  expect(bare.logged).toEqual([]);
  // A desktop of either kind starts it.
  const wayland = trayOn(helper, { platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" } });
  running(await wayland.start()).stop();
});

test("the real helper, run as it is, refuses to start under bun test", () => {
  expect(() =>
    helperTray({
      path: join(scratch, "lookover-tray.exe"),
      version: VERSION,
      clone: false,
      platform: process.platform,
      env: {},
      log: () => {},
    }),
  ).toThrow(/never runs under bun test/);
});

test("the helper is lookover-tray, lookover-tray.exe on Windows", () => {
  expect(trayHelperName("win32")).toBe("lookover-tray.exe");
  expect(trayHelperName("linux")).toBe("lookover-tray");
  expect(trayHelperName("darwin")).toBe("lookover-tray");
});
