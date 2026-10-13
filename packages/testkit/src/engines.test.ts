import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { EngineHealth, EngineRunSpec } from "@lookover/contracts";
import { DemoClock, describeEngines, FakeEngines, type ScriptedRun } from "./index.ts";

const spec: EngineRunSpec = {
  engine: "claude",
  prompt: "Review this diff.",
  cwd: "/tmp/review",
  timeoutMs: 10_000,
  artefactsDir: "/tmp/runs/1",
};

const READY: EngineHealth = { installed: true, version: "2.1.290", signedIn: true };

/** A fake with this health, answering `run` once; its run folder is read from the fake's memory. */
function fake(health: EngineHealth | null, run?: ScriptedRun) {
  const engines = new FakeEngines();
  if (health) engines.setHealth("claude", health);
  if (run) engines.answer(run);
  return Promise.resolve({ engines, spec, read: (path: string) => engines.file(path) });
}

describeEngines("FakeEngines", {
  ready: () =>
    fake(READY, {
      outcome: "ok",
      text: 'Looks fine.\n```json\n{"findings":[]}\n```',
    }),
  failing: () => fake(READY, { outcome: "invalid_output", text: "" }),
  signedOut: () => fake({ ...READY, signedIn: false }, { outcome: "auth_required", text: "" }),
  atLimit: () => fake(READY, { outcome: "quota_exhausted", text: "" }),
  crashing: () => fake(READY, { outcome: "crashed", text: "" }),
  slow: () => fake(READY, { outcome: "ok", text: "Late.", tookMs: 3_600_000 }),
  notInstalled: () => fake(null),
});

describe("FakeEngines on its own", () => {
  test("records every run's spec, in order", async () => {
    const engines = new FakeEngines();
    engines.answer({ outcome: "ok", text: "one" }, { outcome: "ok", text: "two" });
    await engines.run(spec, new AbortController().signal);
    await engines.run({ ...spec, prompt: "second" }, new AbortController().signal);
    expect(engines.runs.map((r) => r.prompt)).toEqual(["Review this diff.", "second"]);
  });

  test("answers scripted for one engine go to its runs only, whatever the order the engines run in", async () => {
    const engines = new FakeEngines();
    engines.answerFor("codex", { outcome: "ok", text: "codex one" }, { outcome: "ok", text: "codex two" });
    engines.answerFor("claude", { outcome: "quota_exhausted", text: "" });
    engines.answer({ outcome: "ok", text: "anyone" });
    const signal = new AbortController().signal;
    const codex = { ...spec, engine: "codex" } as const;
    const answers = [
      await engines.run(codex, signal),
      await engines.run(spec, signal),
      await engines.run(codex, signal),
      // Its own answers used up, an engine takes the shared ones; with none left, it crashes.
      await engines.run(codex, signal),
      await engines.run(spec, signal),
    ];
    expect(answers.map((a) => [a.outcome, a.text])).toEqual([
      ["ok", "codex one"],
      ["quota_exhausted", ""],
      ["ok", "codex two"],
      ["ok", "anyone"],
      ["crashed", ""],
    ]);
  });

  test("a run with nothing scripted crashes, so a test never passes on a silent default", async () => {
    const engines = new FakeEngines();
    const result = await engines.run(spec, new AbortController().signal);
    expect(result.outcome).toBe("crashed");
  });

  test("health is what the test set, not installed by default", async () => {
    const engines = new FakeEngines();
    expect(await engines.health("codex")).toEqual({ installed: false, version: null, signedIn: false });
    engines.setHealth("codex", { installed: true, version: "0.162.1", signedIn: true });
    expect(await engines.health("codex")).toEqual({ installed: true, version: "0.162.1", signedIn: true });
  });

  test("a scripted run takes its time: its answer and its folder come once it has", async () => {
    const engines = new FakeEngines();
    engines.answer({ outcome: "ok", text: "Done.", tookMs: 300 });
    const running = engines.run(spec, new AbortController().signal);
    await Bun.sleep(50);
    expect(engines.file(join(spec.artefactsDir, "run.json"))).toBeUndefined();
    expect((await running).text).toBe("Done.");
    expect(JSON.parse(engines.file(join(spec.artefactsDir, "run.json")) ?? "null")).toEqual({
      engine: "claude",
      outcome: "ok",
    });
  });

  test("on the timers given, a run's time passes only as they move: a held clock never waits on the wall", async () => {
    const clock = new DemoClock({ at: 0 });
    const engines = new FakeEngines({ timers: clock });
    engines.answer({ outcome: "ok", text: "Done.", tookMs: 90_000 });
    let answered = false;
    const running = engines.run({ ...spec, timeoutMs: 600_000 }, new AbortController().signal).then((r) => {
      answered = true;
      return r;
    });
    await clock.advance(89_999);
    expect(answered).toBe(false);
    await clock.advance(1);
    expect((await running).text).toBe("Done.");
  });

  test("a scripted run plays its activities on the timers while it takes its time, none after a cancel", async () => {
    const clock = new DemoClock({ at: 0 });
    const engines = new FakeEngines({ timers: clock });
    const activity = [
      { afterMs: 1_000, activity: { kind: "command", text: "rg --files" } },
      { afterMs: 5_000, activity: { kind: "read", path: "src/a.ts" } },
    ] as const;
    engines.answer({ outcome: "ok", text: "Done.", tookMs: 3_000, activity: [...activity] });
    engines.answer({ outcome: "ok", text: "Late.", tookMs: 9_000, activity: [...activity] });
    const heard: unknown[] = [];
    const listening = { ...spec, timeoutMs: 600_000, onActivity: (a: unknown) => heard.push(a) };
    const first = engines.run(listening, new AbortController().signal);
    await clock.advance(3_000);
    expect((await first).text).toBe("Done.");
    await clock.advance(5_000);
    expect(heard).toEqual([{ kind: "command", text: "rg --files" }]);

    const controller = new AbortController();
    const second = engines.run(listening, controller.signal);
    await clock.advance(2_000);
    controller.abort();
    expect((await second).outcome).toBe("cancelled");
    await clock.advance(10_000);
    expect(heard).toHaveLength(2);
  });

  test("a listener that throws is called no more, the clock's advance goes on, and so does the run", async () => {
    const clock = new DemoClock({ at: 0 });
    const engines = new FakeEngines({ timers: clock });
    const activity = [
      { afterMs: 1_000, activity: { kind: "command", text: "rg --files" } },
      { afterMs: 2_000, activity: { kind: "read", path: "src/a.ts" } },
    ] as const;
    engines.answer({ outcome: "ok", text: "Done.", tookMs: 3_000, activity: [...activity] });
    let calls = 0;
    const onActivity = () => {
      calls++;
      throw new Error("the listener broke");
    };
    const running = engines.run({ ...spec, timeoutMs: 600_000, onActivity }, new AbortController().signal);
    await clock.advance(3_000);
    expect((await running).text).toBe("Done.");
    expect(calls).toBe(1);
  });
});
