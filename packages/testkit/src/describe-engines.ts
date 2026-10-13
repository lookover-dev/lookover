// The `Engines` port suite: what every adapter must do, run against `FakeEngines` and the `engines` module on
// the fake `claude` in `bun run check`, and against the `engines` module on the real `claude` in `bun run live`
// (ADR 0039, ADR 0041). `setup` puts a fresh adapter in each state the port reports, with a run spec and run
// folder of its own; no case depends on another's runs. A state the adapter can't be brought to on demand is
// left out, and its case is skipped (the real `claude` can't be made to hit the plan's limit on purpose).
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineRunOutcome, EngineRunSpec, Engines } from "@lookover/contracts";

export interface EnginesFixture {
  engines: Engines;
  spec: EngineRunSpec;
  /** Reads a file a run left, by its path; undefined when there is none. On disk when not given. */
  read?: (path: string) => string | undefined;
  /**
   * Resolves once a run started on this fixture is under way: the program has its prompt and is working on it.
   * The cancel case aborts then, so the run is really cancelled mid-way. Not given: right after `run` is called.
   */
  started?: () => Promise<void>;
}

export interface EnginesSetup {
  /** Installed and signed in; the run answers `ok` in free text ending in a JSON block, well within its limit. */
  ready(): Promise<EnginesFixture>;
  /** Installed and signed in; the run ends on the program's error flag with no answer (a budget limit, say). */
  failing(): Promise<EnginesFixture>;
  /** Installed and signed out. */
  signedOut(): Promise<EnginesFixture>;
  /** Installed, signed in and at the plan's limit. */
  atLimit?: () => Promise<EnginesFixture>;
  /** Installed and signed in; the program ends without an answer. */
  crashing(): Promise<EnginesFixture>;
  /** Installed and signed in; the run takes far longer than any case waits, until its limit or its signal ends it. */
  slow(): Promise<EnginesFixture>;
  /** No program to run. */
  notInstalled(): Promise<EnginesFixture>;
  /**
   * Installed and signed in, with a run folder that can't be made or written. Left out by an adapter that keeps
   * its folder where nothing can refuse it (`FakeEngines`, in memory).
   */
  unwritable?: () => Promise<EnginesFixture>;
}

const go = () => new AbortController().signal;

const onDisk = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

/** The run folder, once `run` has resolved: the prompt as given, and how the run ended. */
function expectFolder(f: EnginesFixture, spec: EngineRunSpec, outcome: EngineRunOutcome): void {
  const read = f.read ?? onDisk;
  expect(read(join(spec.artefactsDir, "prompt.md"))).toBe(spec.prompt);
  const run: unknown = JSON.parse(read(join(spec.artefactsDir, "run.json")) ?? "null");
  expect(run).toMatchObject({ engine: spec.engine, outcome });
}

/**
 * `concurrent`: the cases run at once, for an adapter whose runs are programs to wait on (the fakes' bun
 * processes). Never on the real CLIs (`bun run live`): one real session at a time.
 */
export function describeEngines(
  name: string,
  setup: EnginesSetup,
  options: { concurrent?: boolean } = {},
): void {
  (options.concurrent ? describe.concurrent : describe)(`Engines port: ${name}`, () => {
    test("ready: installed, with a version, and signed in", async () => {
      const f = await setup.ready();
      const { engines, spec } = f;
      const health = await engines.health(spec.engine);
      expect(health.installed).toBe(true);
      expect(health.version).toBeString();
      expect(health.signedIn).toBe(true);
    });

    test("a run answers ok, with its text as written and its folder; a free-text run has no JSON", async () => {
      const f = await setup.ready();
      const { engines, spec } = f;
      const result = await engines.run(spec, go());
      expect(result.outcome).toBe("ok");
      expect(result.text).toContain("```");
      // The text's block is `review`'s to read (ADR 0028): JSON comes only from a structured-output run.
      expect(result.json).toBeNull();
      expect(result.artefactsDir).toBe(spec.artefactsDir);
      expectFolder(f, spec, "ok");
    });

    test("a run that ends on the program's error flag is invalid output, with no JSON", async () => {
      const f = await setup.failing();
      const { engines, spec } = f;
      const result = await engines.run(spec, go());
      expect(result.outcome).toBe("invalid_output");
      expect(result.json).toBeNull();
      expectFolder(f, spec, "invalid_output");
    });

    test("signed out: health says installed and signed out, and a run asks for a sign-in", async () => {
      const f = await setup.signedOut();
      const { engines, spec } = f;
      expect(await engines.health(spec.engine)).toMatchObject({ installed: true, signedIn: false });
      expect((await engines.run(spec, go())).outcome).toBe("auth_required");
      expectFolder(f, spec, "auth_required");
    });

    const atLimit = setup.atLimit;
    (atLimit ? test : test.skip)("at the plan's limit, a run is quota exhausted", async () => {
      if (!atLimit) return;
      const f = await atLimit();
      const { engines, spec } = f;
      expect((await engines.run(spec, go())).outcome).toBe("quota_exhausted");
      expectFolder(f, spec, "quota_exhausted");
    });

    test("a program that ends without an answer crashed", async () => {
      const f = await setup.crashing();
      const { engines, spec } = f;
      const result = await engines.run(spec, go());
      expect(result.outcome).toBe("crashed");
      expect(result.json).toBeNull();
      expectFolder(f, spec, "crashed");
    });

    test("not installed: health says so, a run crashed, and its folder says how it ended", async () => {
      const f = await setup.notInstalled();
      const { engines, spec } = f;
      expect(await engines.health(spec.engine)).toEqual({ installed: false, version: null, signedIn: false });
      expect((await engines.run(spec, go())).outcome).toBe("crashed");
      expectFolder(f, spec, "crashed");
    });

    const unwritable = setup.unwritable;
    (unwritable ? test : test.skip)(
      "a run whose folder can't be made or written crashed, never thrown",
      async () => {
        if (!unwritable) return;
        const { engines, spec } = await unwritable();
        const result = await engines.run(spec, go());
        expect(result.outcome).toBe("crashed");
        expect(result.text).toBe("");
        expect(result.json).toBeNull();
      },
    );

    test("a run whose signal is already aborted is cancelled", async () => {
      const f = await setup.ready();
      const { engines, spec } = f;
      const aborted = new AbortController();
      aborted.abort();
      expect((await engines.run(spec, aborted.signal)).outcome).toBe("cancelled");
      expectFolder(f, spec, "cancelled");
    });

    test("a run cancelled while it runs is cancelled", async () => {
      const f = await setup.slow();
      const { engines, spec } = f;
      const controller = new AbortController();
      const running = engines.run(spec, controller.signal);
      await f.started?.();
      controller.abort();
      expect((await running).outcome).toBe("cancelled");
      expectFolder(f, spec, "cancelled");
    });

    test("a run past its wall-clock limit times out", async () => {
      const f = await setup.slow();
      const { engines, spec } = f;
      const limited = { ...spec, timeoutMs: 500 };
      expect((await engines.run(limited, go())).outcome).toBe("timeout");
      expectFolder(f, limited, "timeout");
    });
  });
}
