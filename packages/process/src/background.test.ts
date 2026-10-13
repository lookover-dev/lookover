// The service started in the background through its entry (ADR 0054): on Windows the `CreateProcessW` it asks
// for, with no console window and out of the terminal's job, then again in the job when the job forbids it, then
// why not. Nothing starts there: the call is a fake, so no window pops at every check. The real one was started by
// hand on Windows (the ticket's note). Elsewhere a real starter starts a real program, under Bun's no-orphans.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BackgroundStart, browserCommand, startInBackground } from "@lookover/process/background";

const BUN = "C:\\Users\\Your Name\\.bun\\bin\\bun.exe";
const INVOCATION = {
  executable: BUN,
  args: ["H:\\clone dir\\apps\\service\\src\\main.ts", "serve", "--home=C:\\data"],
  cwd: "C:\\Users\\Your Name",
  env: { PATH: "C:\\Windows", LOCALAPPDATA: "C:\\Users\\Your Name\\AppData\\Local" },
};

/** A `CreateProcessW` that answers `answers` in turn, with every start it was asked for. */
function windows(...answers: ({ pid: number } | { error: number })[]) {
  const asked: BackgroundStart[] = [];
  const create = (start: BackgroundStart) => {
    asked.push(start);
    const answer = answers[asked.length - 1];
    if (answer === undefined || "error" in answer)
      return {
        opened: false as const,
        reason: `CreateProcessW failed (error ${answer?.error ?? 0})`,
        error: answer?.error ?? 0,
      };
    return { opened: true as const, pid: answer.pid };
  };
  return { asked, create };
}

test("on Windows: no console at all, no window, out of the terminal's job, the program by its path", async () => {
  const w = windows({ pid: 4242 });
  expect(await startInBackground(INVOCATION, "win32", w.create)).toEqual({
    started: true,
    pid: 4242,
    inTerminalJob: false,
  });
  expect(w.asked).toEqual([
    {
      executable: BUN,
      commandLine: `"${BUN}" "H:\\clone dir\\apps\\service\\src\\main.ts" serve --home=C:\\data`,
      cwd: "C:\\Users\\Your Name",
      env: INVOCATION.env,
      // DETACHED_PROCESS 0x8, CREATE_UNICODE_ENVIRONMENT 0x400, CREATE_BREAKAWAY_FROM_JOB 0x1000000,
      // CREATE_NO_WINDOW 0x8000000.
      creationFlags: 0x09000408,
    },
  ]);
});

test("on Windows: a job that forbids breaking away gets the start again inside it, and says so", async () => {
  // ERROR_ACCESS_DENIED: the terminal's job has no JOB_OBJECT_LIMIT_BREAKAWAY_OK.
  const w = windows({ error: 5 }, { pid: 4243 });
  expect(await startInBackground(INVOCATION, "win32", w.create)).toEqual({
    started: true,
    pid: 4243,
    inTerminalJob: true,
  });
  expect(w.asked.map((start) => start.creationFlags)).toEqual([0x09000408, 0x08000408]);
});

test("on Windows: refused both ways, it says why and starts nothing", async () => {
  const w = windows({ error: 5 }, { error: 2 });
  expect(await startInBackground(INVOCATION, "win32", w.create)).toEqual({
    started: false,
    reason: "CreateProcessW failed (error 2)",
  });
});

test("on Windows: a start refused for another reason than the job is said as it is, never made again", async () => {
  // ERROR_FILE_NOT_FOUND: no program at that path; inside the job would fail the same, and hide why.
  const w = windows({ error: 2 }, { pid: 4243 });
  expect(await startInBackground(INVOCATION, "win32", w.create)).toEqual({
    started: false,
    reason: "CreateProcessW failed (error 2)",
  });
  expect(w.asked).toHaveLength(1);
});

test("elsewhere: a program that isn't there is said, never thrown", async () => {
  const started = await startInBackground(
    { ...INVOCATION, executable: "/no/such/program", cwd: "/" },
    "linux",
  );
  expect(started.started).toBe(false);
});

test("the browser is the system's URL handler, never a shell that would read the link's &", () => {
  const url = "http://127.0.0.1:4100/api/v1/session?token=a-b_c&x=1";
  expect(browserCommand(url, "win32")).toEqual({
    executable: "rundll32.exe",
    args: ["url.dll,FileProtocolHandler", url],
  });
  expect(browserCommand(url, "darwin")).toEqual({ executable: "/usr/bin/open", args: [url] });
  expect(browserCommand(url, "linux")).toEqual({ executable: "xdg-open", args: [url] });
});

// Bun's no-orphans (`BUN_FEATURE_FLAG_NO_ORPHANS`, which an agent's shell and `bunfig.toml`'s `noOrphans` set) makes
// Linux end every child of the starter once the starter ends, its own environment cleared or not: the release's
// smoke saw `lookover start` succeed and `status` find nothing (#333). Real processes, POSIX only: a starter under the
// flag starts a program in the background and exits; then the test tells the program to answer, which it can only
// do if it still runs.
test.skipIf(process.platform === "win32")(
  "elsewhere: the program outlives a starter under Bun's no-orphans, and its id is the program's",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "lookover-background-"));
    const file = (name: string) => JSON.stringify(join(dir, name));
    try {
      writeFileSync(
        join(dir, "program.ts"),
        `import { existsSync, writeFileSync } from "node:fs";
const deadline = Date.now() + 10_000;
while (!existsSync(${file("go")}) && Date.now() < deadline) await Bun.sleep(20);
writeFileSync(${file("alive")}, String(process.pid));
`,
      );
      const entry = JSON.stringify(Bun.fileURLToPath(import.meta.resolve("@lookover/process/background")));
      writeFileSync(
        join(dir, "starter.ts"),
        `import { startInBackground } from ${entry};
const { BUN_FEATURE_FLAG_NO_ORPHANS: _ended, ...env } = process.env;
const started = await startInBackground({ executable: process.execPath, args: [${file("program.ts")}], cwd: ${JSON.stringify(dir)}, env });
console.log(JSON.stringify(started));
`,
      );
      const starter = Bun.spawnSync([process.execPath, join(dir, "starter.ts")], {
        cwd: dir,
        env: { BUN_FEATURE_FLAG_NO_ORPHANS: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(starter.exitCode).toBe(0);
      const started = JSON.parse(starter.stdout.toString());
      expect(started.started).toBe(true);
      writeFileSync(join(dir, "go"), "");
      const alive = join(dir, "alive");
      const deadline = Date.now() + 5_000;
      while (!existsSync(alive) && Date.now() < deadline) await Bun.sleep(20);
      expect(readFileSync(alive, "utf8")).toBe(String(started.pid));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  15_000,
);
