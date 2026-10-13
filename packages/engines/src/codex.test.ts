// The `engines` module's Codex half through its entry, driving the fake `codex` program of testkit (ADR 0039, ADR
// 0044): the port suite (every outcome, health, the run folder), then what only this adapter shows: the exact text
// and tokens of a recording, what the program received (the hardened flags, the prompt on stdin, the allow-listed
// environment), how the event stream is read, and health read from stderr.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineRunSpec, Engines } from "@lookover/contracts";
import {
  createEngines,
  type EnginesOptions,
  engineEnv,
  type Host,
  INPUT_LIMITS,
  type Program,
} from "@lookover/engines";
import { createProcessRunner } from "@lookover/process";
import { type CodexRecording, codexReceived, describeEngines, fakeCodex } from "@lookover/testkit";
import { NEVER, passed, SHELL, WINDOWS_SHELL } from "./env.test-support.ts";

// The tests run at once (`describe.concurrent`): their time is the fake's bun process starting, which they wait on
// side by side. A run here may last until its 10 s wall-clock limit (`spec.timeoutMs`) and `until` waits up to
// 5 s: each test is given longer than what it waits for.
setDefaultTimeout(15_000);

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function folder(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "lookover-codex-")));
  made.push(dir);
  return dir;
}

const PROMPT = "Review this diff.\n\n```diff\n+const a = 1;\n```\n";
const WINDOWS: Host = { platform: "win32", arch: "x64" };
const LINUX: Host = { platform: "linux", arch: "x64" };

/** The module on `codex` (the fake replaying `recording`, or a program, or nothing), with a run spec into `dir`. */
function fixture(codex: CodexRecording | Program | null, options: Partial<EnginesOptions> = {}) {
  const dir = folder();
  const program = typeof codex === "string" ? fakeCodex(codex) : codex;
  const engines = createEngines({
    runner: createProcessRunner({ registryFile: join(dir, "processes.json") }),
    env: {},
    ...options,
    // No claude: nothing here runs it, and none is looked for on this machine.
    ...(program === null ? {} : { codex: program }),
  });
  const spec: EngineRunSpec = {
    engine: "codex",
    prompt: PROMPT,
    cwd: dir,
    timeoutMs: 10_000,
    artefactsDir: join(dir, "runs", "1"),
  };
  return { engines, spec, dir };
}

const run = (engines: Engines, spec: EngineRunSpec) => engines.run(spec, new AbortController().signal);

/** A program that prints `stdout` and `stderr` and exits with `exitCode`, whatever it is asked: a CLI of our making. */
function scripted(dir: string, out: { stdout?: string; stderr?: string; exitCode?: number }): Program {
  const script = join(dir, "codex-like.ts");
  writeFileSync(
    script,
    [
      `await Bun.stdin.text();`,
      `process.stderr.write(${JSON.stringify(out.stderr ?? "")});`,
      `process.stdout.write(${JSON.stringify(out.stdout ?? "")}, () => { process.exitCode = ${out.exitCode ?? 0}; });`,
    ].join("\n"),
  );
  return { executable: process.execPath, args: [script] };
}

/** Events as `codex exec --json` writes them, one per line. */
const events = (...lines: unknown[]) => `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("still waiting after five seconds");
    await Bun.sleep(20);
  }
}

const on = (codex: CodexRecording | null) => () => Promise.resolve(fixture(codex));

describeEngines(
  "the engines module on the fake codex",
  {
    ready: on("ok"),
    failing: on("invalid_output"),
    signedOut: on("auth_required"),
    atLimit: on("quota_exhausted"),
    crashing: on("crashed"),
    slow: () => {
      const f = fixture("timeout");
      return Promise.resolve({
        ...f,
        started: () => until(() => existsSync(join(f.dir, "codex.received.json"))),
      });
    },
    notInstalled: on(null),
    unwritable: () => {
      const f = fixture("ok");
      writeFileSync(join(f.dir, "taken"), "");
      return Promise.resolve({ ...f, spec: { ...f.spec, artefactsDir: join(f.dir, "taken", "1") } });
    },
  },
  { concurrent: true },
);

describe.concurrent("the outcome of a codex run", () => {
  // The text and the tokens are the ok recording's: `bun run record:codex ok` prints the new ones to put here.
  test("ok: the last agent message's text, no JSON read from it, and the turn's tokens", async () => {
    const { engines, spec } = fixture("ok");
    const result = await run(engines, spec);
    expect(result.outcome).toBe("ok");
    expect(result.text).toBe('No findings.\n\n```json\n{"findings":[]}\n```');
    expect(result.json).toBeNull();
    // input 7743 (6912 of it cached, counted once), output 16.
    expect(result.usage).toEqual({ inputTokens: 7743, outputTokens: 16 });
  });

  test("several agent messages: the answer is the last; retries the CLI recovered from count for nothing", async () => {
    const dir = folder();
    const stdout = events(
      { type: "thread.started", thread_id: "t" },
      { type: "turn.started" },
      { type: "error", message: "Reconnecting... 1/5 (stream disconnected before completion)" },
      {
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "Reading the diff first." },
      },
      {
        type: "item.completed",
        item: { id: "item_1", type: "command_execution", command: "rg x", exit_code: 0, status: "completed" },
      },
      {
        type: "item.completed",
        item: { id: "item_2", type: "agent_message", text: "One finding.\n```json\n{}\n```" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 1000,
          cached_input_tokens: 600,
          output_tokens: 50,
          reasoning_output_tokens: 20,
        },
      },
    );
    const { engines, spec } = fixture(scripted(dir, { stdout }));
    const result = await run(engines, spec);
    expect(result.outcome).toBe("ok");
    expect(result.text).toBe("One finding.\n```json\n{}\n```");
    // Cached input is part of the input the API counts: never added on top.
    expect(result.usage).toEqual({ inputTokens: 1000, outputTokens: 50 });
  });

  test("a completed turn with no answer is invalid output", async () => {
    const dir = folder();
    const stdout = events(
      { type: "thread.started", thread_id: "t" },
      { type: "turn.started" },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 0 } },
    );
    const { engines, spec } = fixture(scripted(dir, { stdout }));
    expect((await run(engines, spec)).outcome).toBe("invalid_output");
  });

  test("a completed turn on a non-zero exit crashed: the signals disagree", async () => {
    const dir = folder();
    const stdout = events(
      { type: "item.completed", item: { type: "agent_message", text: "```json\n{}\n```" } },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } },
    );
    const { engines, spec } = fixture(scripted(dir, { stdout, exitCode: 1 }));
    expect((await run(engines, spec)).outcome).toBe("crashed");
  });

  test("the review demo mode replays: a real review's answer, ending in its block", async () => {
    const { engines, spec } = fixture("review");
    const result = await run(engines, spec);
    expect(result.outcome).toBe("ok");
    expect(result.text).toContain("```json");
    expect(result.text).toContain("src/invoices.ts");
  });

  test("a prompt over the CLI's input limit, refused before any turn: invalid output, the refusal as its text", async () => {
    const { engines, spec } = fixture("input_too_large");
    const result = await run(engines, spec);
    expect(result.outcome).toBe("invalid_output");
    expect(result.text).toBe("Input exceeds the maximum length of 1048576 characters.");
  });

  test("each engine's input limit keeps a margin under what its CLI refuses", () => {
    // codex-cli 0.154.0 refuses an input over 1,048,576 characters.
    expect(INPUT_LIMITS.codex).toBeLessThan(1_048_576 * 0.9);
    expect(INPUT_LIMITS.claude).toBeGreaterThan(0);
  });

  test("a model the plan refuses: invalid output, no text", async () => {
    const { engines, spec } = fixture("invalid_output");
    const result = await run(engines, spec);
    expect(result.outcome).toBe("invalid_output");
    expect(result.text).toBe("");
  });

  test("cancelled: the caller's signal aborts a run once the program has read its prompt", async () => {
    const { engines, spec, dir } = fixture("cancelled");
    const controller = new AbortController();
    const pending = engines.run(spec, controller.signal);
    await until(() => existsSync(join(dir, "codex.received.json")));
    controller.abort();
    expect((await pending).outcome).toBe("cancelled");
  });
});

/** A local time on this machine: Codex says its reset time in the machine's own. */
const local = (text: string) => new Date(text).getTime();
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** A run at the limit whose error says `said`, on `where`: the stream (the error event and turn.failed) or stderr. */
function limited(said: string, where: "stream" | "stderr", now: string | number) {
  const dir = folder();
  const stdout = events(
    { type: "thread.started", thread_id: "t" },
    { type: "turn.started" },
    ...(where === "stream"
      ? [
          { type: "error", message: said },
          { type: "turn.failed", error: { message: said } },
        ]
      : []),
  );
  const out = where === "stream" ? { stdout, exitCode: 1 } : { stdout, stderr: `${said}\n`, exitCode: 1 };
  const at = typeof now === "number" ? now : local(now);
  return fixture(scripted(dir, out), { now: () => at });
}

describe.concurrent("when codex's limit resets (ADR 0055)", () => {
  test("the real limit's stream: its dated time, read in the machine's local time", async () => {
    const { engines, spec } = fixture("quota_exhausted", { now: () => local("2026-10-11T05:26:25") });
    const result = await run(engines, spec);
    expect(result.outcome).toBe("quota_exhausted");
    expect(result.limitUntil).toBe(local("2026-10-14T10:11:00"));
    expect(result.limitSaid).toBeUndefined();
  });

  test("a bare time is the next one: later today, or tomorrow once it has passed", async () => {
    const said =
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage or try again at 1:00 AM.";
    const morning = await run(...pair(limited(said, "stream", "2026-10-11T00:30:00")));
    expect(morning.limitUntil).toBe(local("2026-10-11T01:00:00"));
    const noon = await run(...pair(limited(said, "stream", "2026-10-11T12:00:00")));
    expect(noon.limitUntil).toBe(local("2026-10-12T01:00:00"));
    const pm = "You've hit your usage limit. Try again at 12:05 PM.";
    expect((await run(...pair(limited(pm, "stream", "2026-10-11T09:00:00")))).limitUntil).toBe(
      local("2026-10-11T12:05:00"),
    );
  });

  test("the message on stderr is read too", async () => {
    const said = "You've hit your usage limit. Try again at Oct 1st, 2026 1:42 PM.";
    const result = await run(...pair(limited(said, "stderr", "2026-09-30T18:00:00")));
    expect(result.outcome).toBe("quota_exhausted");
    expect(result.limitUntil).toBe(local("2026-10-01T13:42:00"));
  });

  test("a time past, more than 8 days away, or none: no reset, and the limit's words for the log", async () => {
    const past = "You've hit your usage limit. Try again at Oct 1st, 2026 1:42 PM.";
    const before = await run(...pair(limited(past, "stream", "2026-10-11T12:00:00")));
    expect(before.limitUntil).toBeUndefined();
    expect(before.limitSaid).toBe(past);
    // The 8 days are real time: counted in ms from the reset, whatever clock change lies between.
    const reset = local("2026-10-01T13:42:00");
    const far = await run(...pair(limited(past, "stream", reset - 8 * DAY - MINUTE)));
    expect(far.limitUntil).toBeUndefined();
    const within = await run(...pair(limited(past, "stream", reset - 8 * DAY + MINUTE)));
    expect(within.limitUntil).toBe(reset);
    const none = "You've hit your usage limit. Upgrade to Pro.";
    const unread = await run(...pair(limited(none, "stderr", "2026-10-11T12:00:00")));
    expect(unread.outcome).toBe("quota_exhausted");
    expect(unread.limitUntil).toBeUndefined();
    expect(unread.limitSaid).toBe(none);
  });

  test("a run that met no limit says no reset, whatever its text holds", async () => {
    const { engines, spec } = fixture("ok", { now: () => local("2026-10-11T12:00:00") });
    const result = await run(engines, spec);
    expect(result.limitUntil).toBeUndefined();
    expect(result.limitSaid).toBeUndefined();
  });
});

const pair = (f: { engines: Engines; spec: EngineRunSpec }) => [f.engines, f.spec] as const;

/** The activities a run of `engines` on `spec` reported, in order. */
async function watched(engines: Engines, spec: EngineRunSpec): Promise<unknown[]> {
  const activities: unknown[] = [];
  await engines.run({ ...spec, onActivity: (a) => activities.push(a) }, new AbortController().signal);
  return activities;
}

describe.concurrent("what codex did, as it came (ADR 0055)", () => {
  test("the real review: each command as it started, without pwsh -Command, unquoted", async () => {
    const { engines, spec } = fixture("review");
    expect(await watched(engines, spec)).toEqual([
      {
        kind: "command",
        text: "Get-Location; rg --files --hidden -g '!node_modules' -g '!.git'; git status --short; git log -4 --oneline",
      },
      {
        kind: "command",
        text: "git show 610d86d:src/invoices.ts; git show 610d86d:README.md; git ls-tree -r HEAD; Get-ChildItem -Path .. -Filter AGENTS.md; Get-ChildItem -Path . -Filter AGENTS.md",
      },
      {
        kind: "command",
        text: "Get-Content README.md; Get-Content src/invoices.ts; Get-Content src/greeting.ts; rg -n 'listInvoices|unpaid|apiKey|legacy-name|greeting|100|total' . --hidden -g '!.git'",
      },
      {
        kind: "command",
        text: String.raw`node -e 'const fs = require("fs"); let source = fs.readFileSync("src/invoices.ts", "utf8").replace(/export interface Invoice \{[\s\S]*?\}/, "").replace(/export function/g, "function").replace(/: Invoice\[\]/g, "").replace(/: number/g, ""); const run = new Function(source + "\nreturn { listInvoices, unpaid, total };")(); const invoices = Array.from({length: 150}, (_, n) => ({id: String(n), amountCents: 100, paid: false, apiKey: "secret-" + n})); const captured = []; const originalLog = console.log; console.log = (...args) => captured.push(args); const listed = run.listInvoices(invoices, 150); run.listInvoices(invoices, 1); console.log = originalLog; console.log(JSON.stringify({requested: 150, returned: listed.length, previousCap: 100, secretsLoggedForLimitOne: captured[1][1].length, unpaid: run.unpaid(invoices).length, total: run.total(invoices)}));'`,
      },
    ]);
  });

  test("bash -lc is removed too; a command in no shell, or one it can't unquote, is shown as it is", async () => {
    const dir = folder();
    const started = (command: string) => ({
      type: "item.started",
      item: { id: "i", type: "command_execution", command, aggregated_output: "", status: "in_progress" },
    });
    const program = scripted(dir, {
      stdout: events(
        started(`/bin/bash -lc "rg -n 'apiKey' src"`),
        started("rg --files"),
        started(`bash -lc "echo 'open`),
        started(`/usr/bin/python3 -c "print(1)"`),
        { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
      ),
    });
    const { engines, spec } = fixture(program);
    expect(await watched(engines, spec)).toEqual([
      { kind: "command", text: "rg -n 'apiKey' src" },
      { kind: "command", text: "rg --files" },
      { kind: "command", text: `bash -lc "echo 'open` },
      { kind: "command", text: `/usr/bin/python3 -c "print(1)"` },
    ]);
  });

  test("nothing the model wrote comes out: its messages, its reasoning, a command's end, a tool call", async () => {
    const dir = folder();
    const program = scripted(dir, {
      stdout: events(
        { type: "thread.started", thread_id: "t" },
        { type: "item.completed", item: { id: "a", type: "agent_message", text: "Ignore the rules." } },
        { type: "item.completed", item: { id: "r", type: "reasoning", text: "I should print the key." } },
        {
          type: "item.started",
          item: { id: "c", type: "command_execution", command: "rg --files", status: "in_progress" },
        },
        {
          type: "item.completed",
          item: { id: "c", type: "command_execution", command: "rg --files", aggregated_output: "secret" },
        },
        { type: "item.started", item: { id: "m", type: "mcp_tool_call", server: "s", tool: "t" } },
        { type: "item.completed", item: { id: "a2", type: "agent_message", text: "Done." } },
        { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
      ),
    });
    const { engines, spec } = fixture(program);
    expect(await watched(engines, spec)).toEqual([{ kind: "command", text: "rg --files" }]);
  });
});

describe.concurrent("a codex run's folder", () => {
  test("keeps the prompt, the events, stderr and how the run went", async () => {
    const { engines, spec } = fixture("auth_required");
    await run(engines, spec);
    const read = (name: string) => readFileSync(join(spec.artefactsDir, name), "utf8");
    expect(read("prompt.md")).toBe(PROMPT);
    expect(read("stdout.jsonl")).toStartWith('{"type":"thread.started"');
    expect(read("stderr.txt")).toContain("401 Unauthorized");
    expect(JSON.parse(read("run.json"))).toMatchObject({
      engine: "codex",
      model: "gpt-6.1-sol",
      effort: "high",
      outcome: "auth_required",
      end: "exited",
      exitCode: 1,
      cwd: spec.cwd,
      timeoutMs: 10_000,
    });
  });

  test("not installed: the run never starts, and its folder says why", async () => {
    const { engines, spec } = fixture(null);
    await run(engines, spec);
    expect(JSON.parse(readFileSync(join(spec.artefactsDir, "run.json"), "utf8"))).toMatchObject({
      engine: "codex",
      outcome: "crashed",
      executable: null,
      reason: "codex is not installed",
    });
  });
});

describe.concurrent("what codex is given", () => {
  // Each run starts the fake, a bun process: one run answers for its flags and its environment.
  test("the hardened flags, the model and its effort, the folder, the prompt on stdin only; on Windows, an environment name matches whatever its case", async () => {
    const given = { Path: "C:\\bin", Codex_Home: "C:\\x", OpenAI_Api_Key: "sk-test", Gh_Token: "ghp_x" };
    const { engines, spec, dir } = fixture("ok", { env: given, host: WINDOWS });
    await run(engines, spec);
    const received = codexReceived(dir);
    expect(received.stdin).toBe(PROMPT);
    // Exactly these, in this order (ADR 0044, ADR 0048): a flag added or dropped shows here.
    expect(received.args).toEqual([
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox",
      "read-only",
      "-c",
      'approval_policy="never"',
      "-c",
      "project_doc_max_bytes=0",
      "-c",
      "project_doc_fallback_filenames=[]",
      "-c",
      'web_search="disabled"',
      "-c",
      'shell_environment_policy.inherit="core"',
      // The self-test's live run found the repository's `.agents/skills` offered to the model (#91).
      "-c",
      "skills.include_instructions=false",
      // Nor its own bundled skills: no skill at all reaches a review (#235, ADR 0056).
      "-c",
      "skills.bundled.enabled=false",
      "--disable",
      "apps",
      "--disable",
      "plugins",
      "--disable",
      "browser_use",
      "--disable",
      "computer_use",
      "--disable",
      "image_generation",
      "--disable",
      "multi_agent",
      "--disable",
      "hooks",
      "--disable",
      "skill_search",
      "-c",
      'windows.sandbox="unelevated"',
      "--model",
      "gpt-6.1-sol",
      "-c",
      'model_reasoning_effort="high"',
      "--cd",
      spec.cwd,
      "-",
    ]);
    expect(passed(received.env, given)).toEqual(["Codex_Home", "NoDefaultCurrentDirectoryInExePath", "Path"]);
  });

  test("elsewhere, no Windows sandbox setting; the environment: the allow-list, then Lookover's own, nothing else (ADR 0048)", async () => {
    const { engines, spec, dir } = fixture("ok", { env: SHELL, host: LINUX });
    await run(engines, spec);
    const received = codexReceived(dir);
    expect(received.args.join(" ")).not.toContain("windows.sandbox");
    const passedOn = passed(received.env, SHELL);
    for (const name of NEVER) expect(passedOn).not.toContain(name);
    expect(passedOn).toEqual([
      "CODEX_CA_CERTIFICATE",
      "CODEX_HOME",
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

  test("the model and the effort given at creation", async () => {
    const { engines, spec, dir } = fixture("ok", { codexModel: "gpt-5.6-luna", codexEffort: "medium" });
    await run(engines, spec);
    const args = codexReceived(dir).args.join(" ");
    expect(args).toContain("--model gpt-5.6-luna");
    expect(args).toContain('-c model_reasoning_effort="medium"');
  });

  test("the confirm pass, built with only its effort, runs the same default model (#250)", async () => {
    const { engines, spec, dir } = fixture("ok", { codexEffort: "medium" });
    await run(engines, spec);
    const args = codexReceived(dir).args.join(" ");
    expect(args).toContain("--model gpt-6.1-sol");
    expect(args).toContain('-c model_reasoning_effort="medium"');
  });

  test("engineEnv gives the recorders the environment a run gets", () => {
    expect(engineEnv("codex", SHELL, LINUX)).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/me",
      TMPDIR: "/tmp",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      LANG: "en_GB.UTF-8",
      LC_ALL: "en_GB.UTF-8",
      TZ: "Europe/Paris",
      HTTPS_PROXY: "http://proxy:3128",
      SSL_CERT_FILE: "/etc/ssl/cert.pem",
      CODEX_HOME: "/home/me/.codex",
      CODEX_CA_CERTIFICATE: "/home/me/ca.pem",
      NoDefaultCurrentDirectoryInExePath: "1",
    });
  });

  test("on Windows, the profile folders and the system's own pass in the case the shell gave them", () => {
    expect(engineEnv("codex", WINDOWS_SHELL, WINDOWS)).toEqual({
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
      Codex_Home: "C:\\Users\\Your Name\\.codex",
      NoDefaultCurrentDirectoryInExePath: "1",
    });
  });
});

describe.concurrent("codex's health", () => {
  test("installed, its version, signed in with ChatGPT: `login status` answers on stderr", async () => {
    const { engines } = fixture("ok");
    expect(await engines.health("codex")).toEqual({ installed: true, version: "0.162.1", signedIn: true });
  });

  test("installed but signed out", async () => {
    const { engines } = fixture("auth_required");
    expect(await engines.health("codex")).toEqual({ installed: true, version: "0.162.1", signedIn: false });
  });

  test("signed in with an API key: signed out for Lookover, which runs on the plan only (ADR 0001)", async () => {
    const dir = folder();
    const { engines } = fixture(
      scripted(dir, {
        stdout: "codex-cli 0.162.0-alpha.2\n",
        stderr: "Logged in using an API key - sk-proj-***ABCD\n",
      }),
    );
    expect(await engines.health("codex")).toEqual({
      installed: true,
      version: "0.162.0-alpha.2",
      signedIn: false,
      why: { kind: "signed-in-otherwise", how: "an API key" },
    });
  });

  test("signed in with an access token: signed out too, saying how it is signed in", async () => {
    const dir = folder();
    const { engines } = fixture(
      scripted(dir, { stdout: "codex-cli 0.162.1\n", stderr: "Logged in using an access token\n" }),
    );
    expect((await engines.health("codex")).why).toEqual({
      kind: "signed-in-otherwise",
      how: "an access token",
    });
  });

  /** The fake replaying `ok` (signed in with ChatGPT) that says it is codex-cli `version`. */
  const asVersion = (version: string): Program => {
    const program = fakeCodex("ok");
    return { ...program, args: [...program.args, "--as-version", version] };
  };

  test("a CLI older than the model's minimum is too old: not usable, saying its version, the model and the one needed", async () => {
    const { engines } = fixture(asVersion("0.154.0"));
    expect(await engines.health("codex")).toEqual({
      installed: false,
      version: "0.154.0",
      signedIn: true,
      why: { kind: "too-old", version: "0.154.0", model: "gpt-6.1-sol", needs: "0.162.0" },
    });
  });

  test("the minimum's pre-releases (the desktop app's 0.162.0-alpha.2) and later versions are new enough", async () => {
    for (const version of ["0.162.0-alpha.2", "0.162.0", "0.162.1", "0.170.0"]) {
      const { engines } = fixture(asVersion(version));
      expect(await engines.health("codex")).toEqual({ installed: true, version, signedIn: true });
    }
  });

  test("a version it can't read is not judged too old", async () => {
    const { engines } = fixture(asVersion("dev"));
    expect(await engines.health("codex")).toEqual({ installed: true, version: null, signedIn: true });
  });

  test("a model with no minimum known is never judged too old", async () => {
    const { engines } = fixture(asVersion("0.100.0"), { codexModel: "gpt-5.6-luna" });
    expect(await engines.health("codex")).toEqual({ installed: true, version: "0.100.0", signedIn: true });
  });

  test("health and runs of one engine never go through the other's", async () => {
    const { engines } = fixture("ok");
    // No claude was given, and an empty environment finds none.
    expect(await engines.health("claude")).toEqual({ installed: false, version: null, signedIn: false });
  });
});
