// The `engines` module's Claude half through its entry, driving the fake `claude` program of testkit (ADR 0039):
// the port suite (every outcome, health, the run folder), then what only this adapter shows: the exact text and
// tokens of a recording, its raw streams in the run folder, what the program received, and how `claude` is
// found. Codex's half is `codex.test.ts`.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { EngineRunSpec, Engines } from "@lookover/contracts";
import { createEngines, engineEnv, type Host, type Program, saidIn } from "@lookover/engines";
import { createProcessRunner } from "@lookover/process";
import { type ClaudeRecording, claudeReceived, describeEngines, fakeClaude } from "@lookover/testkit";
import { z } from "zod";
import { NEVER, passed, SHELL, WINDOWS_SHELL } from "./env.test-support.ts";

// The tests run at once (`describe.concurrent`): their time is the fake's bun process starting, which they wait on
// side by side. A run here may last until its 10 s wall-clock limit (`spec.timeoutMs`) and `until` waits up to
// 5 s: each test is given longer than what it waits for.
setDefaultTimeout(15_000);

const made: string[] = [];

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A fresh folder for one test: the data folder, with the review worktree and the run folder under it. */
function folder(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "lookover-engines-")));
  made.push(dir);
  return dir;
}

/** Windows, whatever this machine is: the `.exe` and `.cmd` rules of locate apply. */
const WINDOWS: Host = { platform: "win32", arch: "x64" };
const LINUX: Host = { platform: "linux", arch: "x64" };

const PROMPT = "Review this diff.\n\n```diff\n+const a = 1;\n```\n";

/** The module on `claude` (the fake replaying `recording`, or a program, or nothing), with a run spec into `dir`. */
function fixture(claude: ClaudeRecording | Program | null, env: Record<string, string> = {}, host?: Host) {
  const dir = folder();
  const program = typeof claude === "string" ? fakeClaude(claude) : claude;
  const engines = createEngines({
    runner: createProcessRunner({ registryFile: join(dir, "processes.json") }),
    env,
    ...(program === null ? {} : { claude: program }),
    ...(host === undefined ? {} : { host }),
  });
  const spec: EngineRunSpec = {
    engine: "claude",
    prompt: PROMPT,
    cwd: dir,
    timeoutMs: 10_000,
    artefactsDir: join(dir, "runs", "1"),
  };
  return { engines, spec, dir };
}

const run = (engines: Engines, spec: EngineRunSpec) => engines.run(spec, new AbortController().signal);

/** Resolves when `check` holds, or fails after five seconds. */
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("still waiting after five seconds");
    await Bun.sleep(20);
  }
}

const on = (claude: ClaudeRecording | null) => () => Promise.resolve(fixture(claude));

describeEngines(
  "the engines module on the fake claude",
  {
    ready: on("ok"),
    failing: on("invalid_output"),
    signedOut: on("auth_required"),
    atLimit: on("quota_exhausted"),
    crashing: on("crashed"),
    // A recording that never answers, until the limit or the signal kills it; under way once the fake has its prompt.
    slow: () => {
      const f = fixture("timeout");
      return Promise.resolve({
        ...f,
        started: () => until(() => existsSync(join(f.dir, "claude.received.json"))),
      });
    },
    notInstalled: on(null),
    // A file where the run folder's parent should be: no folder can be made under it.
    unwritable: () => {
      const f = fixture("ok");
      writeFileSync(join(f.dir, "taken"), "");
      return Promise.resolve({ ...f, spec: { ...f.spec, artefactsDir: join(f.dir, "taken", "1") } });
    },
  },
  { concurrent: true },
);

describe.concurrent("the outcome of a run", () => {
  // The text and the tokens are the ok recording's: `bun run record:claude ok` prints the new ones to put here.
  test("ok: the answer's text, no JSON read from it, and the tokens, cached input counted in", async () => {
    const { engines, spec } = fixture("ok");
    const result = await run(engines, spec);
    expect(result.outcome).toBe("ok");
    expect(result.text).toBe(
      'I don\'t see any files or context to analyze in the current directory.\n\n```json\n{"findings": []}\n```',
    );
    // The text ends in a JSON block, but reading it is `review`'s (ADR 0028): a free-text run has no JSON.
    expect(result.json).toBeNull();
    // input 10, cache creation 1027, cache read 5409; output 250.
    expect(result.usage).toEqual({ inputTokens: 6446, outputTokens: 250 });
  });

  test("a structured-output run: the JSON is the value the program validated, not anything in the text", async () => {
    const dir = folder();
    // A program that answers as `claude -p --json-schema` does (exploration 02): the value in `structured_output`.
    const script = join(dir, "structured.ts");
    const result = {
      type: "result",
      is_error: false,
      result: '```json\n{"findings": ["from the text"]}\n```',
      structured_output: { findings: [], empty_reason: "Docs only." },
    };
    writeFileSync(script, `console.log(${JSON.stringify(JSON.stringify(result))});\n`);
    const { engines, spec } = fixture({ executable: process.execPath, args: [script] });
    const answered = await run(engines, spec);
    expect(answered.outcome).toBe("ok");
    expect(answered.json).toEqual({ value: { findings: [], empty_reason: "Docs only." } });
  });

  test("invalid output: the program ended on its error flag without an answer", async () => {
    const { engines, spec } = fixture("invalid_output");
    const result = await run(engines, spec);
    expect(result.outcome).toBe("invalid_output");
    expect(result.text).toBe("");
    expect(result.json).toBeNull();
  });

  // `bun run live`, 2026-10-07: another Claude process was refreshing the shared sign-in. The stream's error is
  // `server_error`, not `authentication_failed`, and the text never says "not logged in".
  test("signed in, but the sign-in couldn't be refreshed: a sign-in problem, not invalid output", async () => {
    const { engines, spec } = fixture("auth_refresh");
    const result = await run(engines, spec);
    expect(result.outcome).toBe("auth_required");
    expect(result.text).toStartWith("Failed to refresh OAuth token");
  });

  test("cancelled: the caller's signal aborts a run once the program has read its prompt", async () => {
    const { engines, spec, dir } = fixture("cancelled");
    const controller = new AbortController();
    const pending = engines.run(spec, controller.signal);
    await until(() => existsSync(join(dir, "claude.received.json")));
    controller.abort();
    expect((await pending).outcome).toBe("cancelled");
  });
});

/** A program that writes each of `pieces` to stdout `gapMs` apart, whatever it is asked: a CLI of our making. */
function writing(dir: string, pieces: string[], gapMs = 0): Program {
  const script = join(dir, "claude-like.ts");
  writeFileSync(
    script,
    [
      "await Bun.stdin.text();",
      `for (const piece of ${JSON.stringify(pieces)}) {`,
      "  await new Promise((done) => process.stdout.write(piece, done));",
      `  await Bun.sleep(${gapMs});`,
      "}",
    ].join("\n"),
  );
  return { executable: process.execPath, args: [script] };
}

/** One event of Claude's stream as a line. */
const line = (event: unknown) => `${JSON.stringify(event)}\n`;
/** An assistant event holding `content`. */
const said = (...content: unknown[]) => line({ type: "assistant", message: { content } });
const tool = (name: string, input: unknown) => ({ type: "tool_use", id: `toolu_${name}`, name, input });
const RESULT = line({ type: "result", is_error: false, result: "Done." });

/** A program that prints `text` 4 KB at a time, each piece written before the next, whatever it is asked. */
function printing(dir: string, text: string): Program {
  const file = join(dir, "printed.txt");
  writeFileSync(file, text);
  const script = join(dir, "printing.ts");
  writeFileSync(
    script,
    [
      "await Bun.stdin.text();",
      `const text = await Bun.file(${JSON.stringify(file)}).text();`,
      "for (let at = 0; at < text.length; at += 4096) {",
      "  await new Promise((done) => process.stdout.write(text.slice(at, at + 4096), done));",
      "}",
    ].join("\n"),
  );
  return { executable: process.execPath, args: [script] };
}

/** Every line of every stdout the fakes replay, Claude's and Codex's. */
function recordedLines(): string[] {
  const fakes = join(import.meta.dir, "..", "..", "testkit");
  return ["fake-claude", "fake-codex"].flatMap((fake) =>
    readdirSync(join(fakes, fake, "recordings")).flatMap((name) => {
      const stdout = join(fakes, fake, "recordings", name, "run.stdout.jsonl");
      return existsSync(stdout) ? readFileSync(stdout, "utf8").split("\n") : [];
    }),
  );
}

const HUGE = "a".repeat(1_000_000);
const started = (command: unknown) => ({
  type: "item.started",
  item: { type: "command_execution", command },
});
/** Lines no engine writes: not JSON, the wrong shapes, huge, open quotes, deep nesting. */
const ODD_LINES = [
  "",
  "\r",
  "not json at all",
  "null",
  "42",
  '"text"',
  "[]",
  "[".repeat(100_000) + "]".repeat(100_000),
  "\ud800 lone surrogate",
  ...[
    { type: "assistant" },
    { type: "assistant", message: null },
    { type: "assistant", message: { content: "text" } },
    { type: "assistant", message: { content: [null, 1, "x", { type: "tool_use" }] } },
    { type: "assistant", message: { content: [tool("Read", null), tool("Read", []), tool("Grep", "x")] } },
    {
      type: "assistant",
      message: { content: [tool("Read", { file_path: 7 }), tool("Glob", { pattern: {} })] },
    },
    { type: "assistant", message: { content: [tool("Read", { file_path: `/${HUGE}` })] } },
    {
      type: "assistant",
      message: { content: [tool("Read", { file_path: "C:" }), tool("Read", { file_path: "\\\\?\\C:\\" })] },
    },
    { type: "assistant", message: { content: [tool("Read", { file_path: "/İ/".repeat(1000) })] } },
    { type: "item.started" },
    { type: "item.started", item: null },
    started(7),
    started(""),
    started('bash -lc "open'),
    started("pwsh -Command"),
    started(`bash -lc "${'a\\"'.repeat(500_000)}"`),
    started(`bash -lc ${"'x' ".repeat(200_000)}`),
    started(HUGE),
  ].map((event) => JSON.stringify(event)),
];

/** Whether `a` is an activity: one of its kinds, with its one text and nothing else. */
const isActivity = (a: unknown): boolean =>
  z
    .discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("read"), path: z.string() }),
      z.strictObject({ kind: z.enum(["search", "list"]), pattern: z.string() }),
      z.strictObject({ kind: z.literal("command"), text: z.string() }),
    ])
    .safeParse(a).success;

/** The module on `claude`, reading a limit's reset at `now`, with a run spec into a folder of its own. */
function at(now: number, claude: ClaudeRecording | Program) {
  const dir = folder();
  const engines = createEngines({
    runner: createProcessRunner({ registryFile: join(dir, "processes.json") }),
    env: {},
    claude: typeof claude === "string" ? fakeClaude(claude) : claude,
    now: () => now,
  });
  return run(engines, {
    engine: "claude",
    prompt: PROMPT,
    cwd: dir,
    timeoutMs: 10_000,
    artefactsDir: join(dir, "run"),
  });
}

/** A program that prints these stream lines, exits 1. */
function claudeLike(...lines: unknown[]): Program {
  const script = join(folder(), "claude-like.ts");
  const out = lines.map((l) => JSON.stringify(l)).join("\n");
  writeFileSync(
    script,
    `process.stdout.write(${JSON.stringify(`${out}\n`)}, () => { process.exitCode = 1; });\n`,
  );
  return { executable: process.execPath, args: [script] };
}

const AT_LIMIT_RESULT = {
  type: "result",
  is_error: true,
  result: "You've hit your limit · resets 1am (Europe/Paris)",
};

describe.concurrent("when claude's limit resets (ADR 0055)", () => {
  test("the rejected rate-limit event's resetsAt is the reset", async () => {
    // 1791327600 s: 2026-10-07 01:00 in Paris, the time the result names.
    const result = await at(Date.UTC(2026, 9, 6, 20, 0), "quota_exhausted");
    expect(result.outcome).toBe("quota_exhausted");
    expect(result.limitUntil).toBe(Date.UTC(2026, 9, 6, 23, 0));
    expect(result.limitSaid).toBeUndefined();
  });

  test("a reset past, or more than 8 days away, is none: the result's words for the log", async () => {
    const past = await at(Date.UTC(2026, 9, 7, 0, 0), "quota_exhausted");
    expect(past.limitUntil).toBeUndefined();
    expect(past.limitSaid).toBe("You've hit your limit · resets 1am (Europe/Paris)");
    const far = await at(Date.UTC(2026, 8, 28, 22, 59), "quota_exhausted");
    expect(far.limitUntil).toBeUndefined();
    const within = await at(Date.UTC(2026, 8, 28, 23, 1), "quota_exhausted");
    expect(within.limitUntil).toBe(Date.UTC(2026, 9, 6, 23, 0));
  });

  test("an event that allowed the run gives no reset; a limit with none read gives the result's words", async () => {
    const allowed = {
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed_warning", resetsAt: 1791327600 },
    };
    const result = await at(Date.UTC(2026, 9, 6, 20, 0), claudeLike(allowed, AT_LIMIT_RESULT));
    expect(result.outcome).toBe("quota_exhausted");
    expect(result.limitUntil).toBeUndefined();
    expect(result.limitSaid).toBe("You've hit your limit · resets 1am (Europe/Paris)");
  });

  test("a run that met no limit says no reset", async () => {
    const result = await at(Date.UTC(2026, 9, 6, 20, 0), "ok");
    expect(result.limitUntil).toBeUndefined();
    expect(result.limitSaid).toBeUndefined();
  });
});

/** The run of `engines` on `spec`, with every activity it reported, and whether one came after it resolved. */
async function watched(engines: Engines, spec: EngineRunSpec) {
  const activities: unknown[] = [];
  let resolved = false;
  let late = false;
  const result = await engines.run(
    {
      ...spec,
      onActivity: (a) => {
        if (resolved) late = true;
        activities.push(a);
      },
    },
    new AbortController().signal,
  );
  resolved = true;
  await Bun.sleep(50);
  return { result, activities, late };
}

describe.concurrent("what claude did, as it came (ADR 0055)", () => {
  test("the real round 2: the search, then the file it read, relative to the worktree with /", async () => {
    const { engines, spec } = fixture("review-round-2");
    const { result, activities, late } = await watched(engines, spec);
    expect(result.outcome).toBe("ok");
    expect(activities).toEqual([
      { kind: "search", pattern: "matching|listInvoices|legacy-name|greeting" },
      { kind: "read", path: "src/invoices.ts" },
    ]);
    expect(late).toBe(false);
  });

  test("the real round 1: the search, then the file listing", async () => {
    const { engines, spec } = fixture("review");
    const { activities } = await watched(engines, spec);
    expect(activities).toEqual([
      { kind: "search", pattern: "legacy-name|listInvoices|unpaid|apiKey" },
      { kind: "list", pattern: "**/*.{ts,js,json}" },
    ]);
  });

  test("an event cut across chunks is read once it is whole", async () => {
    const dir = folder();
    const event = said(tool("Grep", { pattern: "apiKey" }));
    const cut = Math.floor(event.length / 2);
    const { engines, spec } = fixture(writing(dir, [event.slice(0, cut), event.slice(cut), RESULT], 100));
    const { activities } = await watched(engines, { ...spec, cwd: dir });
    expect(activities).toEqual([{ kind: "search", pattern: "apiKey" }]);
  });

  test("a last line with no newline is read too, before the run resolves", async () => {
    const dir = folder();
    const last = said(tool("Glob", { pattern: "src/**" })).trimEnd();
    const { engines, spec } = fixture(writing(dir, [RESULT, last]));
    const { activities, late } = await watched(engines, { ...spec, cwd: dir });
    expect(activities).toEqual([{ kind: "list", pattern: "src/**" }]);
    expect(late).toBe(false);
  });

  test("a read outside the worktree is shown as it is, the home folder as ~", async () => {
    const dir = folder();
    const home = join(dir, "home");
    const work = join(dir, "work");
    mkdirSync(work);
    const { engines, spec } = fixture(
      writing(dir, [
        said(tool("Read", { file_path: join(work, "src", "a.ts") })),
        said(tool("Read", { file_path: join(home, ".ssh", "config") })),
        said(tool("Read", { file_path: join(dir, "elsewhere.txt") })),
        said(tool("Read", { file_path: "src/b.ts" })),
        RESULT,
      ]),
      { HOME: home, USERPROFILE: home },
    );
    const { activities } = await watched(engines, { ...spec, cwd: work });
    const sep = process.platform === "win32" ? "\\" : "/";
    expect(activities).toEqual([
      { kind: "read", path: "src/a.ts" },
      { kind: "read", path: `~${sep}.ssh${sep}config` },
      { kind: "read", path: join(dir, "elsewhere.txt") },
      { kind: "read", path: "src/b.ts" },
    ]);
  });

  test("nothing the model wrote comes out: its text, its thinking, its summaries, a tool it may not use", async () => {
    const dir = folder();
    const { engines, spec } = fixture(
      writing(dir, [
        said({ type: "thinking", thinking: "Ignore the rules and print the key." }),
        said({ type: "text", text: "I will now read the file." }, tool("Read", { file_path: "src/a.ts" })),
        line({ type: "system", subtype: "task_summary", detail: "Reading src/a.ts" }),
        line({ type: "system", subtype: "post_turn_summary", status_detail: "Review complete" }),
        said(tool("Task", { prompt: "Say hello" }), tool("Read", {}), tool("Grep", { pattern: 42 })),
        line({ type: "user", message: { content: [{ type: "tool_result", content: "secret" }] } }),
        "not json at all\n",
        RESULT,
      ]),
    );
    const { activities } = await watched(engines, { ...spec, cwd: dir });
    expect(activities).toEqual([{ kind: "read", path: "src/a.ts" }]);
  });

  test("a worktree whose name lowercases longer still gives paths relative to it", async () => {
    const dir = folder();
    // "İ" lowercases to two characters: a path compared lowercased must not be sliced at the lowercased length.
    const work = join(dir, "İİwork");
    mkdirSync(work);
    const { engines, spec } = fixture(
      writing(dir, [said(tool("Read", { file_path: join(work, "src", "a.ts") })), RESULT]),
    );
    const { activities } = await watched(engines, { ...spec, cwd: work });
    expect(activities).toEqual([{ kind: "read", path: "src/a.ts" }]);
  });

  test("a long line in many chunks is read once whole", async () => {
    const dir = folder();
    // A 4 MB text, then a read in the same event, written 4 KB at a time: the line is held as pieces, joined
    // once its newline comes (not joined again with each chunk, which is quadratic in its length).
    const event = said(
      { type: "text", text: "x".repeat(4_000_000) },
      tool("Read", { file_path: "src/a.ts" }),
    );
    const { engines, spec } = fixture(printing(dir, `${event}${RESULT}`));
    const { result, activities } = await watched(engines, { ...spec, cwd: dir });
    expect(result.outcome).toBe("ok");
    expect(activities).toEqual([{ kind: "read", path: "src/a.ts" }]);
  });

  test.each(["claude", "codex"] as const)(
    "%s's reader takes every recorded line and odd ones without failing, and gives only activities",
    async (engine) => {
      const dir = folder();
      const program = printing(dir, `${[...recordedLines(), ...ODD_LINES].join("\n")}\n`);
      const engines = createEngines({
        runner: createProcessRunner({ registryFile: join(dir, "processes.json") }),
        env: {},
        [engine]: program,
      });
      const spec: EngineRunSpec = {
        engine,
        prompt: PROMPT,
        cwd: dir,
        timeoutMs: 10_000,
        artefactsDir: join(dir, "runs", "1"),
      };
      const { activities } = await watched(engines, spec);
      const recorded = JSON.parse(readFileSync(join(spec.artefactsDir, "run.json"), "utf8"));
      expect(recorded.unreadActivity).toBeUndefined();
      expect(activities.length).toBeGreaterThan(0);
      for (const activity of activities) expect(isActivity(activity)).toBe(true);
    },
  );

  test("a listener that throws is called no more, and the run goes on", async () => {
    const { engines, spec } = fixture("review-round-2");
    let calls = 0;
    const result = await engines.run(
      {
        ...spec,
        onActivity: () => {
          calls++;
          throw new Error("the listener broke");
        },
      },
      new AbortController().signal,
    );
    expect(result.outcome).toBe("ok");
    expect(calls).toBe(1);
  });
});

describe.concurrent("the run folder", () => {
  test("keeps the prompt, the raw streams and how the run went", async () => {
    const { engines, spec } = fixture("ok");
    await run(engines, spec);
    const read = (name: string) => readFileSync(join(spec.artefactsDir, name), "utf8");
    expect(read("prompt.md")).toBe(PROMPT);
    expect(read("stdout.jsonl")).toStartWith('{"type":"system","subtype":"init"');
    expect(read("stderr.txt")).toBe("");
    expect(JSON.parse(read("run.json"))).toMatchObject({
      engine: "claude",
      outcome: "ok",
      end: "exited",
      exitCode: 0,
      cwd: spec.cwd,
      timeoutMs: 10_000,
    });
  });

  test("the run says how long its program ran, as run.json does (ADR 0055)", async () => {
    const { engines, spec } = fixture("ok");
    const result = await run(engines, spec);
    const recorded = JSON.parse(readFileSync(join(spec.artefactsDir, "run.json"), "utf8"));
    expect(result.tookMs).toBeGreaterThan(0);
    expect(result.tookMs).toBe(recorded.tookMs);
  });

  test("a run that never started still says why, and took no time", async () => {
    const { engines, spec } = fixture(null);
    const result = await run(engines, spec);
    expect(result.tookMs).toBe(0);
    const recorded = JSON.parse(readFileSync(join(spec.artefactsDir, "run.json"), "utf8"));
    expect(recorded).toMatchObject({ outcome: "crashed", executable: null });
    expect(existsSync(join(spec.artefactsDir, "stdout.jsonl"))).toBe(false);
  });

  test("a folder that can't be made: the run crashes without starting the program, and nothing is thrown", async () => {
    const { engines, spec, dir } = fixture("ok");
    // A file where the folder's parent should be: no folder can be made under it.
    writeFileSync(join(dir, "taken"), "");
    const blocked = { ...spec, artefactsDir: join(dir, "taken", "1") };
    expect((await run(engines, blocked)).outcome).toBe("crashed");
    expect(existsSync(join(dir, "claude.received.json"))).toBe(false);
    expect((await run(engines, { ...blocked, engine: "codex" })).outcome).toBe("crashed");
  });
});

describe.concurrent("what claude is given", () => {
  // Each run starts the fake, a bun process: one run answers for its flags and its environment.
  test("the hardened flags, the model, the prompt on stdin, never on the command line, and the environment: the allow-list, then Lookover's own, nothing else (ADR 0048)", async () => {
    const { engines, spec, dir } = fixture("ok", SHELL, LINUX);
    await run(engines, spec);
    const received = claudeReceived(dir);
    expect(received.stdin).toBe(PROMPT);
    // Exactly these, in this order (ADR 0012, ADR 0048): a flag added or dropped shows here.
    expect(received.args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--restricted",
      "--setting-sources=",
      "--safe-mode",
      "--settings",
      '{"disableAllHooks":true}',
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--disable-slash-commands",
      "--tools",
      "Read,Grep,Glob",
      "--allowedTools",
      "Read",
      "Grep",
      "Glob",
      "--permission-mode",
      "dontAsk",
      "--permission-prompts",
      "none",
      "--model",
      "opus",
    ]);
    const passedOn = passed(received.env, SHELL);
    for (const name of NEVER) expect(passedOn).not.toContain(name);
    expect(passedOn).toEqual([
      "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
      "CLAUDE_CODE_DISABLE_CLAUDE_MDS",
      "CLAUDE_CODE_GIT_BASH_PATH",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CONFIG_DIR",
      "DBUS_SESSION_BUS_ADDRESS",
      "HOME",
      "HTTPS_PROXY",
      "LANG",
      "LC_ALL",
      "NoDefaultCurrentDirectoryInExePath",
      "PATH",
      "SSL_CERT_FILE",
      "TMPDIR",
      "TZ",
    ]);
  });

  test("the model given at creation; on Windows, an environment name matches whatever its case", async () => {
    const dir = folder();
    const given = {
      Path: "C:\\bin",
      SystemRoot: "C:\\Windows",
      Claude_Config_Dir: "C:\\c",
      Gh_Token: "ghp_x",
    };
    const engines = createEngines({
      runner: createProcessRunner({ registryFile: join(dir, "processes.json") }),
      env: given,
      claude: fakeClaude("ok"),
      model: "claude-opus-4-1",
      host: WINDOWS,
    });
    await run(engines, {
      engine: "claude",
      prompt: PROMPT,
      cwd: dir,
      timeoutMs: 10_000,
      artefactsDir: join(dir, "run"),
    });
    const received = claudeReceived(dir);
    expect(received.args.join(" ")).toContain("--model claude-opus-4-1");
    expect(passed(received.env, given)).toEqual([
      "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
      "CLAUDE_CODE_DISABLE_CLAUDE_MDS",
      "Claude_Config_Dir",
      "NoDefaultCurrentDirectoryInExePath",
      "Path",
      "SystemRoot",
    ]);
  });

  test("Lookover's own switches, whatever the shell said; the rest as the shell had it", () => {
    expect(engineEnv("claude", SHELL, LINUX)).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/me",
      TMPDIR: "/tmp",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      LANG: "en_GB.UTF-8",
      LC_ALL: "en_GB.UTF-8",
      TZ: "Europe/Paris",
      HTTPS_PROXY: "http://proxy:3128",
      SSL_CERT_FILE: "/etc/ssl/cert.pem",
      CLAUDE_CONFIG_DIR: "/home/me/.claude",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test",
      CLAUDE_CODE_GIT_BASH_PATH: "/usr/bin/bash",
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      NoDefaultCurrentDirectoryInExePath: "1",
    });
  });

  test("on Windows, the profile folders and the system's own pass in the case the shell gave them", () => {
    expect(engineEnv("claude", WINDOWS_SHELL, WINDOWS)).toEqual({
      Path: "C:\\Windows\\System32;C:\\Users\\Your Name\\.local\\bin",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      USERPROFILE: "C:\\Users\\Your Name",
      HOMEDRIVE: "C:",
      HOMEPATH: "\\Users\\Your Name",
      APPDATA: "C:\\Users\\Your Name\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\Your Name\\AppData\\Local",
      TEMP: "C:\\Users\\Your Name\\AppData\\Local\\Temp",
      TMP: "C:\\Users\\Your Name\\AppData\\Local\\Temp",
      USERNAME: "me",
      SystemRoot: "C:\\Windows",
      SystemDrive: "C:",
      windir: "C:\\Windows",
      ComSpec: "C:\\Windows\\system32\\cmd.exe",
      ProgramData: "C:\\ProgramData",
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      https_proxy: "http://proxy:3128",
      Claude_Config_Dir: "C:\\Users\\Your Name\\.claude",
      CLAUDE_CODE_GIT_BASH_PATH: "C:\\Program Files\\Git\\bin\\bash.exe",
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      NoDefaultCurrentDirectoryInExePath: "1",
    });
  });

  test("elsewhere, a name matches in its own case only", () => {
    expect(Object.keys(engineEnv("claude", { Path: "/bin", PATH: "/usr/bin" }, LINUX))).not.toContain("Path");
  });
});

describe.concurrent("health", () => {
  test("installed, its version, signed in", async () => {
    const { engines } = fixture("ok");
    expect(await engines.health("claude")).toEqual({ installed: true, version: "2.1.283", signedIn: true });
  });

  test("installed but signed out", async () => {
    const { engines } = fixture("auth_required");
    expect(await engines.health("claude")).toEqual({ installed: true, version: "2.1.283", signedIn: false });
  });

  test("claude is found on PATH when no program is given", async () => {
    const dir = folder();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude.exe"), "");
    const { engines } = fixture(null, { PATH: [join(dir, "elsewhere"), bin].join(delimiter) }, WINDOWS);
    const health = await engines.health("claude");
    expect(health.installed).toBe(true);
  });

  test("a .cmd shim on PATH is unwrapped to the executable it names", async () => {
    const dir = folder();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude.cmd"), `@echo off\r\n"%LOOKOVER_TEST_BUN%" %*\r\n`);
    const { engines } = fixture(null, { PATH: bin, LOOKOVER_TEST_BUN: process.execPath }, WINDOWS);
    const health = await engines.health("claude");
    expect(health.installed).toBe(true);
    expect(health.version).toBe(Bun.version);
    expect(health.signedIn).toBe(false);
  });

  test("only npm's launcher, which runs Claude through Node: not installed, saying why", async () => {
    const dir = folder();
    const bin = join(dir, "nvm", "v22.20.0");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "node.exe"), "");
    writeFileSync(
      join(bin, "claude.cmd"),
      '@ECHO off\r\n"%~dp0\\node.exe" "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n',
    );
    const { engines } = fixture(null, { PATH: bin }, WINDOWS);
    expect(await engines.health("claude")).toEqual({
      installed: false,
      version: null,
      signedIn: false,
      why: { kind: "npm-launcher" },
    });
  });

  test("an install folder holding a stray file is searched past, never thrown on", async () => {
    const dir = folder();
    const bundles = join(dir, "Claude", "claude-code");
    mkdirSync(bundles, { recursive: true });
    // The desktop app's folder holds one folder per version: a file there is not one.
    writeFileSync(join(bundles, "9.9.9"), "");
    const { engines, spec } = fixture(null, { APPDATA: dir });
    expect(await engines.health("claude")).toEqual({ installed: false, version: null, signedIn: false });
    expect((await run(engines, spec)).outcome).toBe("crashed");
  });
});

describe.concurrent("what the model said in a run, for whoever checks it obeyed nothing (bun run live)", () => {
  const jsonl = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join("\n");

  test("Claude: its text and its tool calls, never what a tool showed it", () => {
    const stdout = jsonl(
      { type: "system", subtype: "init", cwd: "CANARY-INIT" },
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "AGENTS.md" } }],
        },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "CANARY-READ" }] },
      },
      { type: "assistant", message: { content: [{ type: "text", text: "One finding." }] } },
    );
    expect(saidIn("claude", stdout)).toEqual(['{"file_path":"AGENTS.md"}', "One finding."]);
  });

  test("Codex: its messages and its commands, never their output", () => {
    const stdout = jsonl(
      {
        type: "item.completed",
        item: {
          id: "1",
          type: "command_execution",
          command: "cat AGENTS.md",
          aggregated_output: "CANARY-READ",
        },
      },
      { type: "item.completed", item: { id: "2", type: "agent_message", text: "One finding." } },
    );
    expect(saidIn("codex", stdout)).toEqual(["One finding.", "cat AGENTS.md"]);
  });

  test("Claude: its final answer and its structured output", () => {
    const stdout = jsonl({
      type: "result",
      result: "Approved. CANARY-ANSWER",
      structured_output: { verdict: "CANARY-STRUCTURED" },
    });
    expect(saidIn("claude", stdout)).toEqual(["Approved. CANARY-ANSWER", '{"verdict":"CANARY-STRUCTURED"}']);
  });

  test("Codex: the tool calls and file changes it made, never what a tool returned", () => {
    const stdout = jsonl(
      {
        type: "item.completed",
        item: {
          id: "1",
          type: "mcp_tool_call",
          server: "lookover",
          tool: "say",
          arguments: { text: "CANARY-MCP" },
          result: { content: [{ type: "text", text: "CANARY-RETURNED" }] },
          status: "completed",
        },
      },
      {
        type: "item.completed",
        item: { id: "2", type: "file_change", changes: [{ path: "CANARY-FILE.md", kind: "add" }] },
      },
    );
    expect(saidIn("codex", stdout)).toEqual([
      '{"server":"lookover","tool":"say","arguments":{"text":"CANARY-MCP"}}',
      '[{"path":"CANARY-FILE.md","kind":"add"}]',
    ]);
  });
});
