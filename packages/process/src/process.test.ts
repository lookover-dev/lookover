// The `process` leaf through its entry: a child program (`test/child.ts`) that spawns grandchildren is run,
// timed out, killed and swept, and afterwards no process of its tree is left, on Windows and POSIX alike.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ProcessLimits, StartedProcess } from "@lookover/contracts";
import { createProcessRunner, type Timers } from "@lookover/process";

// A test waits up to 4 s for its process tree to start, then up to 4 s for it to be gone: longer than Bun's
// 5 s, so each test is given more than both.
setDefaultTimeout(15_000);

const CHILD = resolve(import.meta.dir, "..", "test", "child.ts");
const GENEROUS: ProcessLimits = { wallClockMs: 10_000, idleMs: 10_000 };
const made: string[] = [];

/**
 * Time the test moves by hand: a limit fires when the test says so, once the tree is up, never because a
 * loaded machine was slow to start it.
 */
class HeldTimers implements Timers {
  private at = 0;
  private pending: { due: number; fire: () => void }[] = [];
  now = () => this.at;
  after = (ms: number, fire: () => void) => {
    const timer = { due: this.at + ms, fire };
    this.pending.push(timer);
    return () => {
      this.pending = this.pending.filter((t) => t !== timer);
    };
  };
  /** Moves time on by `ms`, firing every timer that falls due, in order. */
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

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A fresh folder, with the registry file of a runner built on it. */
function folder(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "lookover-process-")));
  made.push(dir);
  return dir;
}

/** Starts the child program in `mode` with the arguments, from a runner whose registry lives in `dir`. */
function startChild(
  dir: string,
  args: string[],
  limits = GENEROUS,
  stdin = "",
  timers?: Timers,
): StartedProcess {
  const runner = createProcessRunner({
    registryFile: join(dir, "processes.json"),
    ...(timers === undefined ? {} : { timers }),
  });
  return runner.start(
    { executable: process.execPath, args: [CHILD, ...args], cwd: dir, env: {}, stdin },
    limits,
  );
}

/** The pids the child program announced on stdout: its grandchildren. */
function announcedPids(stdout: string): number[] {
  return [...stdout.matchAll(/^pid (\d+)$/gm)].map((m) => Number(m[1]));
}

/** Resolves when `check` holds, or fails after four seconds: a loaded machine is slow to start a tree. */
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("still waiting after four seconds");
    await Bun.sleep(20);
  }
}

/** Whether the OS still has a process with this pid (signal 0 probes without killing). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function expectAllGone(pids: number[]): Promise<void> {
  expect(pids.length).toBeGreaterThan(0);
  await until(() => pids.every((pid) => !alive(pid)));
}

test("the wall-clock limit ends the run and leaves no process of the tree", async () => {
  const dir = folder();
  const timers = new HeldTimers();
  const started = startChild(
    dir,
    ["linger", dir, "2", "0"],
    { wallClockMs: 2000, idleMs: 10_000 },
    "",
    timers,
  );
  await until(() => existsSync(join(dir, "ready")));

  timers.advance(1999);
  expect(alive(started.pid)).toBe(true);
  timers.advance(1);
  const result = await started.result;

  expect(result.end).toBe("wall_clock");
  expect(result.exitCode).toBeNull();
  expect(result.tookMs).toBe(2000);
  const grandchildren = announcedPids(result.stdout);
  expect(grandchildren).toHaveLength(2);
  await expectAllGone([started.pid, ...grandchildren]);
});

test("the idle limit ends a run that stops writing, and leaves no process of the tree", async () => {
  const dir = folder();
  const timers = new HeldTimers();
  const started = startChild(
    dir,
    ["linger", dir, "2", "0"],
    { wallClockMs: 10_000, idleMs: 2000 },
    "",
    timers,
  );
  await until(() => existsSync(join(dir, "ready")));

  timers.advance(1999);
  expect(alive(started.pid)).toBe(true);
  timers.advance(1);
  const result = await started.result;

  expect(result.end).toBe("idle");
  expect(result.exitCode).toBeNull();
  expect(result.tookMs).toBe(2000);
  const grandchildren = announcedPids(result.stdout);
  expect(grandchildren).toHaveLength(2);
  await expectAllGone([started.pid, ...grandchildren]);
});

test("kill ends the run as killed and leaves no process of the tree; a second kill changes nothing", async () => {
  const dir = folder();
  const started = startChild(dir, ["linger", dir, "2", "0"]);
  await until(() => existsSync(join(dir, "ready")));

  started.kill();
  const result = await started.result;
  started.kill();

  expect(result.end).toBe("killed");
  expect(result.exitCode).toBeNull();
  const grandchildren = announcedPids(result.stdout);
  expect(grandchildren).toHaveLength(2);
  await expectAllGone([started.pid, ...grandchildren]);
});

test("a program that never reads a large stdin can still be killed, and nothing throws", async () => {
  const dir = folder();
  const started = startChild(dir, ["linger", dir, "0", "0"], GENEROUS, "x".repeat(4 * 1024 * 1024));
  await until(() => existsSync(join(dir, "ready")));

  started.kill();
  const result = await started.result;

  expect(result.end).toBe("killed");
  await expectAllGone([started.pid]);
});

test("a program that exits leaving grandchildren behind: the result settles, exited, and they are gone", async () => {
  const dir = folder();
  const started = startChild(dir, ["leave", dir, "2"]);

  const result = await started.result;

  expect(result.end).toBe("exited");
  expect(result.exitCode).toBe(0);
  const grandchildren = announcedPids(result.stdout);
  expect(grandchildren).toHaveLength(2);
  await expectAllGone([started.pid, ...grandchildren]);
});

test("sweepOrphans kills the tree a run left behind, once, and reports it", async () => {
  const dir = folder();
  const registryFile = join(dir, "processes.json");
  // The previous run of Lookover: it started a tree and then died without ending it.
  const started = startChild(dir, ["linger", dir, "2", "0"]);
  await until(() => existsSync(join(dir, "ready")));
  const next = createProcessRunner({ registryFile });

  expect(await next.sweepOrphans()).toBe(1);

  const result = await started.result;
  const grandchildren = announcedPids(result.stdout);
  expect(grandchildren).toHaveLength(2);
  await expectAllGone([started.pid, ...grandchildren]);
  expect(await next.sweepOrphans()).toBe(0);
});

test("a pid in the registry with another creation time is another program: never killed", async () => {
  const dir = folder();
  const started = startChild(dir, ["linger", dir, "0", "0"]);
  await until(() => existsSync(join(dir, "ready")));
  // A registry a crashed run left, whose pid the OS has since given to the program above.
  const staleRegistry = join(dir, "stale.json");
  writeFileSync(staleRegistry, JSON.stringify([{ pid: started.pid, created: "an earlier program" }]));
  const next = createProcessRunner({ registryFile: staleRegistry });

  expect(await next.sweepOrphans()).toBe(0);

  expect(alive(started.pid)).toBe(true);
  started.kill();
  expect((await started.result).end).toBe("killed");
  await expectAllGone([started.pid]);
});

test("the sweep leaves what the runner itself is running alone", async () => {
  const dir = folder();
  const runner = createProcessRunner({ registryFile: join(dir, "processes.json") });
  const started = runner.start(
    { executable: process.execPath, args: [CHILD, "linger", dir, "0", "0"], cwd: dir, env: {}, stdin: "" },
    GENEROUS,
  );
  await until(() => existsSync(join(dir, "ready")));

  expect(await runner.sweepOrphans()).toBe(0);

  expect(alive(started.pid)).toBe(true);
  started.kill();
  expect((await started.result).end).toBe("killed");
  await expectAllGone([started.pid]);
});

test("start runs the program with its input on stdin and reports stdout, stderr and the exit code", async () => {
  const started = startChild(folder(), ["echo", "3"], GENEROUS, "hello\n");

  expect(started.pid).toBeGreaterThan(0);
  expect(await started.result).toEqual({
    end: "exited",
    exitCode: 3,
    stdout: "HELLO\n",
    stderr: "err",
    tookMs: expect.any(Number),
  });
});

test("the stdout listener gets every chunk as it arrives, in order, and nothing of stderr", async () => {
  const dir = folder();
  const runner = createProcessRunner({ registryFile: join(dir, "processes.json") });
  const chunks: string[] = [];
  const started = runner.start(
    { executable: process.execPath, args: [CHILD, "linger", dir, "0", "10"], cwd: dir, env: {}, stdin: "" },
    GENEROUS,
    (chunk) => chunks.push(chunk),
  );
  // The chunks come while the program runs, not once it has ended.
  await until(() => chunks.join("").split("tick\n").length > 4);
  started.kill();

  const { stdout } = await started.result;
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks.join("")).toBe(stdout);
});

test("the stdout listener of a program that answers its stdin gets that answer, not its stderr", async () => {
  const dir = folder();
  const runner = createProcessRunner({ registryFile: join(dir, "processes.json") });
  const chunks: string[] = [];
  const started = runner.start(
    { executable: process.execPath, args: [CHILD, "echo", "0"], cwd: dir, env: {}, stdin: "hello\n" },
    GENEROUS,
    (chunk) => chunks.push(chunk),
  );
  await started.result;
  expect(chunks.join("")).toBe("HELLO\n");
});

test("a program that can't start ends with failed_to_start and the reason, never a throw", async () => {
  const dir = folder();
  const runner = createProcessRunner({ registryFile: join(dir, "processes.json") });

  const started = runner.start(
    { executable: join(dir, "no-such-program"), args: [], cwd: dir, env: {}, stdin: "" },
    GENEROUS,
  );

  expect(started.pid).toBe(0);
  const result = await started.result;
  expect(result.end).toBe("failed_to_start");
  expect(result.exitCode).toBeNull();
  expect(result.stderr).toContain("no-such-program");
});

test("a program the registry can't record is killed and ends with failed_to_start, never a throw", async () => {
  const dir = folder();
  // A file where the registry's folder should be: the registry can't be written.
  writeFileSync(join(dir, "taken"), "");
  const runner = createProcessRunner({ registryFile: join(dir, "taken", "processes.json") });

  const started = runner.start(
    {
      executable: process.execPath,
      args: ["-e", "setTimeout(() => {}, 60000)"],
      cwd: dir,
      env: {},
      stdin: "",
    },
    GENEROUS,
  );

  expect(started.pid).toBe(0);
  const result = await started.result;
  expect(result.end).toBe("failed_to_start");
  expect(result.exitCode).toBeNull();
  expect(result.stderr).toContain("registry");
});

test("a registry that can't drop a program at its end still lets the result settle as the program ended", async () => {
  const dir = folder();
  const registryFile = join(dir, "processes.json");
  const runner = createProcessRunner({ registryFile });

  const started = runner.start(
    {
      executable: process.execPath,
      args: ["-e", "setTimeout(() => {}, 1000)"],
      cwd: dir,
      env: {},
      stdin: "",
    },
    GENEROUS,
  );
  // A folder where the registry file was: the entry can't be dropped when the program ends.
  rmSync(registryFile);
  mkdirSync(registryFile);

  const result = await started.result;
  expect(result.end).toBe("exited");
  expect(result.exitCode).toBe(0);
});

test("a file that is no program at all ends with failed_to_start too, never a throw", async () => {
  const dir = folder();
  const runner = createProcessRunner({ registryFile: join(dir, "processes.json") });
  writeFileSync(join(dir, "empty.exe"), "");

  const started = runner.start(
    { executable: join(dir, "empty.exe"), args: [], cwd: dir, env: {}, stdin: "" },
    GENEROUS,
  );

  expect(started.pid).toBe(0);
  const result = await started.result;
  expect(result.end).toBe("failed_to_start");
  expect(result.stderr).not.toBe("");
});
