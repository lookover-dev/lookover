// The scripted engines (ADR 0046) through the entry: the port suite on a clock flowing fast, then what the
// script adds: answers by worktree and pass, rendered as `review` reads them, durations on the timers given,
// health set by hand, a sign-in that lands after 5 s on the clock, a failure consumed by one run, self-tests.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { EngineHealth, EngineRunSpec } from "@lookover/contracts";
import { DemoClock, describeEngines, ScriptedEngines, type ScriptedFindAnswer } from "./index.ts";

const WORKTREE = join("worktrees", "1", "3c1d9a0");

/** A find prompt as `review` writes its marker line. */
const FIND_PROMPT = `Review this.\n\nHead commit: 3c1d9a0, round 1 of this pull request's review. The diff follows.`;
/** A confirm prompt as `review` writes its marker line. */
const CONFIRM_PROMPT = `Check these.\n\nHead commit: 3c1d9a0, the confirm pass of round 1. The claims follow.`;

const spec: EngineRunSpec = {
  engine: "claude",
  prompt: FIND_PROMPT,
  cwd: WORKTREE,
  timeoutMs: 10_000,
  artefactsDir: "/tmp/runs/1",
};

const READY: EngineHealth = { installed: true, version: "2.1.290", signedIn: true };

const NOTHING: ScriptedFindAnswer = { findings: [] };

const ONE_FINDING: ScriptedFindAnswer = {
  notes: "I read the diff. One real problem.",
  findings: [
    {
      path: "src/total.ts",
      line: 2,
      lineText: "  return items.reduce((a, b) => a + b);",
      severity: "blocking",
      category: "correctness",
      title: "total() throws on an empty list",
      body: "When `items` is empty, `reduce` without an initial value throws, because there is no first element.",
      defectKey: "reduce_without_initial_value",
      suggestion: "return items.reduce((a, b) => a + b, 0);",
    },
  ],
  usage: { inputTokens: 1200, outputTokens: 300 },
};

const go = () => new AbortController().signal;

/** Engines on a clock standing still: a duration elapses only when the test advances it. */
function still(health: EngineHealth | null = READY) {
  const clock = new DemoClock({ at: 0 });
  const engines = new ScriptedEngines({ timers: clock });
  if (health) engines.setHealth("claude", health);
  return { clock, engines };
}

/** The suite's fixture: Claude in `health`, on a clock flowing a thousand times faster than the wall. */
function flowing(health: EngineHealth | null, answer?: ScriptedFindAnswer) {
  const clock = new DemoClock({ at: 0, running: true, speed: 1000 });
  const engines = new ScriptedEngines({ timers: clock });
  if (health) engines.setHealth("claude", health);
  if (answer) engines.scriptFind(WORKTREE, answer);
  return Promise.resolve({ engines, spec, read: (path: string) => engines.file(path) });
}

describeEngines("ScriptedEngines", {
  ready: () => flowing(READY, NOTHING),
  failing: async () => {
    const f = await flowing(READY, NOTHING);
    f.engines.nextRunAnswers("claude", "invalid_output");
    return f;
  },
  signedOut: () => flowing({ ...READY, signedIn: false }, NOTHING),
  atLimit: async () => {
    const f = await flowing(READY, NOTHING);
    f.engines.nextRunAnswers("claude", "quota_exhausted");
    return f;
  },
  crashing: () => flowing(READY),
  slow: () => flowing(READY, { ...NOTHING, tookMs: 3_600_000 }),
  notInstalled: () => flowing(null),
});

describe("ScriptedEngines: answers by worktree and pass", () => {
  test("a find answer is rendered as the block review reads, with its notes and usage", async () => {
    const { engines } = still();
    engines.scriptFind(WORKTREE, ONE_FINDING);
    const result = await engines.run(spec, go());
    expect(result.outcome).toBe("ok");
    expect(result.json).toBeNull();
    expect(result.usage).toEqual({ inputTokens: 1200, outputTokens: 300 });
    expect(result.text).toBe(
      [
        "I read the diff. One real problem.",
        "",
        "```json",
        JSON.stringify(
          {
            findings: [
              {
                path: "src/total.ts",
                side: "head",
                line: 2,
                end_line: null,
                line_text: "  return items.reduce((a, b) => a + b);",
                severity: "blocking",
                category: "correctness",
                title: "total() throws on an empty list",
                body: "When `items` is empty, `reduce` without an initial value throws, because there is no first element.",
                defect_key: "reduce_without_initial_value",
                suggestion: "return items.reduce((a, b) => a + b, 0);",
                pre_existing: false,
              },
            ],
            earlier: [],
            empty_reason: null,
          },
          null,
          2,
        ),
        "```",
        "",
      ].join("\n"),
    );
  });

  test("a confirm answer is rendered as the verdicts block, and found by the confirm pass's marker", async () => {
    const { engines } = still();
    engines.scriptFind(WORKTREE, NOTHING);
    engines.scriptConfirm(WORKTREE, {
      verdicts: [
        {
          id: "C1",
          verdict: "confirmed",
          reason: "The list can be empty.",
          evidence: ["src/total.ts:2"],
          severity: "blocking",
        },
      ],
    });
    const result = await engines.run({ ...spec, prompt: CONFIRM_PROMPT }, go());
    expect(result.outcome).toBe("ok");
    expect(result.text).toBe(
      [
        "```json",
        JSON.stringify(
          {
            verdicts: [
              {
                id: "C1",
                verdict: "confirmed",
                reason: "The list can be empty.",
                evidence: ["src/total.ts:2"],
                severity: "blocking",
              },
            ],
          },
          null,
          2,
        ),
        "```",
        "",
      ].join("\n"),
    );
  });

  test("the same commit asked again gets the same answer: a script is not consumed", async () => {
    const { engines } = still();
    engines.scriptFind(WORKTREE, ONE_FINDING);
    const first = await engines.run(spec, go());
    const second = await engines.run(spec, go());
    expect(second.text).toBe(first.text);
    expect(engines.runs).toHaveLength(2);
  });

  test("a worktree nothing is scripted for crashes, saying which worktree and pass", async () => {
    const { engines } = still();
    engines.scriptFind(WORKTREE, NOTHING);
    const other = join("worktrees", "2", "9f0e1d2");
    const result = await engines.run({ ...spec, cwd: other }, go());
    expect(result.outcome).toBe("crashed");
    expect(result.text).toBe(`Nothing scripted for the find pass in ${other}`);
    const confirm = await engines.run({ ...spec, prompt: CONFIRM_PROMPT }, go());
    expect(confirm.outcome).toBe("crashed");
    expect(confirm.text).toBe(`Nothing scripted for the confirm pass in ${WORKTREE}`);
  });

  test("a prompt without a pass marker crashes, saying so", async () => {
    const { engines } = still();
    engines.scriptFind(WORKTREE, NOTHING);
    const result = await engines.run({ ...spec, prompt: "Review this diff." }, go());
    expect(result.outcome).toBe("crashed");
    expect(result.text).toBe(
      "Nothing scripted: the prompt carries neither the find pass's marker nor the confirm pass's",
    );
  });

  test("the run's folder holds the prompt and how it ended, in memory", async () => {
    const { engines } = still();
    engines.scriptFind(WORKTREE, NOTHING);
    await engines.run(spec, go());
    expect(engines.file(join(spec.artefactsDir, "prompt.md"))).toBe(FIND_PROMPT);
    expect(JSON.parse(engines.file(join(spec.artefactsDir, "run.json")) ?? "null")).toEqual({
      engine: "claude",
      outcome: "ok",
    });
  });
});

describe("ScriptedEngines: time, health and failures", () => {
  test("a duration elapses on the timers given, never on the wall clock", async () => {
    const { clock, engines } = still();
    engines.scriptFind(WORKTREE, { ...NOTHING, tookMs: 90_000 });
    let answered = false;
    const running = engines.run({ ...spec, timeoutMs: 600_000 }, go()).then((r) => {
      answered = true;
      return r;
    });
    await clock.advance(89_999);
    expect(answered).toBe(false);
    await clock.advance(1);
    expect(answered).toBe(true);
    expect((await running).outcome).toBe("ok");
  });

  test("activities play at their afterMs on the clock, before the answer; one due after it never plays", async () => {
    const { clock, engines } = still();
    engines.scriptFind(WORKTREE, {
      ...NOTHING,
      tookMs: 90_000,
      activity: [
        { afterMs: 10_000, activity: { kind: "search", pattern: "listInvoices" } },
        { afterMs: 30_000, activity: { kind: "read", path: "src/invoices.ts" } },
        { afterMs: 120_000, activity: { kind: "list", pattern: "**/*.ts" } },
      ],
    });
    const heard: unknown[] = [];
    const running = engines.run({ ...spec, timeoutMs: 600_000, onActivity: (a) => heard.push(a) }, go());
    await clock.advance(9_999);
    expect(heard).toEqual([]);
    await clock.advance(1);
    expect(heard).toEqual([{ kind: "search", pattern: "listInvoices" }]);
    await clock.advance(20_000);
    expect(heard).toHaveLength(2);
    await clock.advance(60_000);
    expect((await running).outcome).toBe("ok");
    await clock.advance(60_000);
    expect(heard).toEqual([
      { kind: "search", pattern: "listInvoices" },
      { kind: "read", path: "src/invoices.ts" },
    ]);
  });

  test("a confirm answer plays its activities too, and none plays after a cancel", async () => {
    const { clock, engines } = still();
    engines.scriptConfirm(WORKTREE, {
      verdicts: [],
      tookMs: 90_000,
      activity: [
        { afterMs: 10_000, activity: { kind: "read", path: "src/a.ts" } },
        { afterMs: 50_000, activity: { kind: "read", path: "src/b.ts" } },
      ],
    });
    const heard: unknown[] = [];
    const controller = new AbortController();
    const running = engines.run(
      { ...spec, prompt: CONFIRM_PROMPT, timeoutMs: 600_000, onActivity: (a) => heard.push(a) },
      controller.signal,
    );
    await clock.advance(20_000);
    controller.abort();
    expect((await running).outcome).toBe("cancelled");
    await clock.advance(60_000);
    expect(heard).toEqual([{ kind: "read", path: "src/a.ts" }]);
  });

  test("a duration past the spec's limit times out at the limit, on the clock", async () => {
    const { clock, engines } = still();
    engines.scriptFind(WORKTREE, { ...NOTHING, tookMs: 90_000 });
    const running = engines.run({ ...spec, timeoutMs: 60_000 }, go());
    await clock.advance(60_000);
    expect((await running).outcome).toBe("timeout");
  });

  test("health is what was set, not installed by default, and signIn flips it to signed in after 5 s", async () => {
    const { clock, engines } = still(null);
    expect(await engines.health("codex")).toEqual({ installed: false, version: null, signedIn: false });
    engines.setHealth("codex", {
      installed: true,
      version: "0.162.1",
      signedIn: false,
      why: { kind: "signed-in-otherwise", how: "an API key" },
    });
    engines.signIn("codex");
    await clock.advance(4_999);
    expect(await engines.health("codex")).toMatchObject({ signedIn: false });
    await clock.advance(1);
    expect(await engines.health("codex")).toEqual({ installed: true, version: "0.162.1", signedIn: true });
  });

  test("signing in an engine that isn't installed is refused", () => {
    const { engines } = still(null);
    expect(() => engines.signIn("codex")).toThrow("codex is not installed");
  });

  test("healthOf reads the health at once, the sign-in's change included", async () => {
    const { clock, engines } = still(null);
    expect(engines.healthOf("codex")).toEqual({ installed: false, version: null, signedIn: false });
    engines.setHealth("codex", { installed: true, version: "0.162.1", signedIn: false });
    engines.signIn("codex");
    await clock.advance(5_000);
    expect(engines.healthOf("codex")).toEqual({ installed: true, version: "0.162.1", signedIn: true });
  });

  test("nextRunAnswers is consumed by one run of that engine; the next answers the script again", async () => {
    const { engines } = still();
    engines.scriptFind(WORKTREE, NOTHING);
    engines.nextRunAnswers("claude", "quota_exhausted");
    const codex = { ...spec, engine: "codex" } as const;
    engines.setHealth("codex", READY);
    expect((await engines.run(codex, go())).outcome).toBe("ok");
    expect((await engines.run(spec, go())).outcome).toBe("quota_exhausted");
    expect((await engines.run(spec, go())).outcome).toBe("ok");
  });

  test("nextRunAnswers at the limit may say when it resets (ADR 0055)", async () => {
    const { engines } = still();
    engines.nextRunAnswers("claude", "quota_exhausted", Date.UTC(2026, 9, 14, 8, 11));
    const result = await engines.run(spec, go());
    expect(result).toMatchObject({ outcome: "quota_exhausted", limitUntil: Date.UTC(2026, 9, 14, 8, 11) });
    engines.nextRunAnswers("claude", "quota_exhausted");
    expect((await engines.run(spec, go())).limitUntil).toBeUndefined();
  });

  test("signed out by health, a run asks for a sign-in without a script saying so", async () => {
    const { engines } = still({ ...READY, signedIn: false });
    engines.scriptFind(WORKTREE, NOTHING);
    expect((await engines.run(spec, go())).outcome).toBe("auth_required");
  });

  test("signed out while it runs, a run asks for a sign-in at its end, as the real session would", async () => {
    const { clock, engines } = still();
    engines.scriptFind(WORKTREE, { ...NOTHING, tookMs: 90_000 });
    const running = engines.run({ ...spec, timeoutMs: 600_000 }, go());
    await clock.advance(30_000);
    engines.setHealth("claude", { ...READY, signedIn: false });
    await clock.advance(60_000);
    expect((await running).outcome).toBe("auth_required");
  });

  test("uninstalled while it runs, a run crashes at its end, saying the engine is gone", async () => {
    const { clock, engines } = still();
    engines.scriptFind(WORKTREE, { ...NOTHING, tookMs: 90_000 });
    const running = engines.run({ ...spec, timeoutMs: 600_000 }, go());
    await clock.advance(30_000);
    engines.setHealth("claude", { installed: false, version: null, signedIn: false });
    await clock.advance(60_000);
    const result = await running;
    expect(result.outcome).toBe("crashed");
    expect(result.text).toBe("claude is not installed");
  });
});

describe("ScriptedEngines: self-tests", () => {
  test("a self-test passes by default, and names a program when installed", async () => {
    const { engines } = still();
    expect(engines.program("claude")).toBe("scripted/claude");
    expect(engines.program("codex")).toBeNull();
    const report = await engines.selfTest("claude", "/tmp/self-test", go());
    expect(report).toEqual({
      verdict: "passed",
      failures: [],
      missingFlags: [],
      outcome: "ok",
      usage: null,
      tookMs: 0,
    });
    expect(engines.selfTests).toEqual([{ engine: "claude", dir: "/tmp/self-test" }]);
  });

  test("a version told to fail fails on the wall; another version passes", async () => {
    const { engines } = still();
    engines.failSelfTest("claude", "2.1.290");
    expect(await engines.selfTest("claude", "/tmp/a", go())).toMatchObject({
      verdict: "failed",
      failures: ["wall"],
    });
    engines.setHealth("claude", { ...READY, version: "2.1.291" });
    expect(await engines.selfTest("claude", "/tmp/b", go())).toMatchObject({ verdict: "passed" });
  });

  test("not installed, signed out or cancelled, a self-test is inconclusive", async () => {
    const { engines } = still(null);
    expect(await engines.selfTest("claude", "/tmp/a", go())).toMatchObject({
      verdict: "inconclusive",
      outcome: null,
    });
    engines.setHealth("claude", { ...READY, signedIn: false });
    expect(await engines.selfTest("claude", "/tmp/b", go())).toMatchObject({
      verdict: "inconclusive",
      outcome: "auth_required",
    });
    engines.setHealth("claude", READY);
    const aborted = new AbortController();
    aborted.abort();
    expect(await engines.selfTest("claude", "/tmp/c", aborted.signal)).toMatchObject({
      verdict: "inconclusive",
      outcome: null,
    });
  });
});
