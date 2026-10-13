// The runner through the package's entry, on `FakeEngines` and a prepare that gives a case's inputs by hand: no
// process, no git. The run folder is a real temporary folder, since keeping each session on disk is the point.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
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
import { type Clock, commitSha, type EngineHealth, type Engines } from "@lookover/contracts";
import { FakeEngines, type ScriptedRun } from "@lookover/testkit";
import {
  type EvalCase,
  type PreparedCase,
  plannedSessions,
  type RunCorpusOptions,
  readRun,
  runCorpus,
  type SessionRecord,
  sameRun,
  sameRunRefusal,
} from "./index.ts";

const temp = realpathSync.native(mkdtempSync(join(tmpdir(), "lookover-evals-run-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const HEAD = commitSha("6d3a5dbf54b0f0be40b104b4f764b8b254640cfd");
const BUG = "The loop stops one order short, so the last order is never charged.";

const evalCase = (id: string): EvalCase => ({
  id,
  language: "typescript",
  summary: "Charges several orders at once.",
  base: [{ path: "src/charge.ts", content: "export const one = 1;\n" }],
  change: [
    { path: "src/charge.ts", content: "for (let i = 0; i < orders.length - 1; i++) charge(orders[i]);\n" },
  ],
  planted: { path: "src/charge.ts", ranges: [[1, 1]], what: BUG },
});

const DIFF = [
  "diff --git a/src/charge.ts b/src/charge.ts",
  "--- a/src/charge.ts",
  "+++ b/src/charge.ts",
  "@@ -1 +1,2 @@",
  "-export const one = 1;",
  "+export function chargeAll(orders: Order[]) {",
  "+  for (let i = 0; i < orders.length - 1; i++) charge(orders[i]);",
  "",
].join("\n");

const REVIEW = { path: "REVIEW.md" as const, text: "- Money is integer cents.\n", commit: HEAD };

/** Free notes, then the one JSON block the prompt asks for. */
const block = (value: unknown) =>
  `I read the change.\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;

const finding = (title: string, key: string, line: number) => ({
  path: "src/charge.ts",
  side: "head",
  line,
  end_line: null,
  severity: "blocking",
  category: "correctness",
  title,
  body: "The loop's bound leaves an order out.",
  defect_key: key,
  suggestion: null,
  pre_existing: false,
});

const found = (...findings: unknown[]): ScriptedRun => ({
  outcome: "ok",
  text: block({ findings, earlier: [] }),
  usage: { inputTokens: 100, outputTokens: 10 },
});
const confirmed = (...ids: string[]): ScriptedRun => ({
  outcome: "ok",
  text: block({
    verdicts: ids.map((id) => ({
      id,
      verdict: "confirmed",
      reason: "It skips one.",
      evidence: [],
      severity: "blocking",
    })),
  }),
  usage: { inputTokens: 50, outputTokens: 5 },
});

const CLAUDE_FIND = finding("The last order is never charged", "off_by_one", 2);
const CODEX_FIND = finding("Orders are charged one short", "loop_bound_short", 1);

const HEALTH = (version: string): EngineHealth => ({ installed: true, version, signedIn: true });

let n = 0;
let runFolder = "";
let buildRoot = "";
let prepared: string[] = [];
let disposed: string[] = [];
beforeEach(() => {
  n += 1;
  runFolder = join(temp, `run-${n}`);
  buildRoot = join(temp, `build-${n}`);
  prepared = [];
  disposed = [];
});

/** The prepare of a case whose inputs are written by hand: its worktree's path in the build root, never made. */
const prepare = (c: EvalCase): Promise<PreparedCase> => {
  prepared.push(c.id);
  return Promise.resolve({
    head: HEAD,
    diff: DIFF,
    rules: [REVIEW],
    cwd: join(buildRoot, "worktrees", "case-1234abcd"),
    diffFile: ".lookover-change.diff",
    dispose: () => {
      disposed.push(c.id);
      return Promise.resolve();
    },
  });
};

const STILL: Clock = { now: () => 0 };

function engines() {
  const find = new FakeEngines();
  const confirm = new FakeEngines();
  for (const e of [find, confirm]) {
    e.setHealth("claude", HEALTH("2.1.0"));
    e.setHealth("codex", HEALTH("0.50.0"));
  }
  return { find, confirm };
}

/** Every engine answers a whole case well: both finds, then the three confirms. */
function answerCase(e: ReturnType<typeof engines>) {
  e.find.answerFor("claude", found(CLAUDE_FIND));
  e.find.answerFor("codex", found(CODEX_FIND));
  e.confirm.answerFor("claude", confirmed("C1"));
  e.confirm.answerFor("codex", confirmed("C1"), confirmed("C1", "C2"));
}

const options = (e: ReturnType<typeof engines>, more: Partial<RunCorpusOptions> = {}): RunCorpusOptions => ({
  cases: [evalCase("ts-charge-all")],
  review: REVIEW.text,
  findEngines: e.find,
  confirmEngines: e.confirm,
  prepare,
  lock: () => ({ release: () => undefined }),
  clock: STILL,
  runFolder,
  buildRoot,
  maxSessions: 100,
  ...more,
});

const stored = (caseId: string, session: string): SessionRecord =>
  JSON.parse(readFileSync(join(runFolder, caseId, `${session}.json`), "utf8"));

const promptsOf = (e: ReturnType<typeof engines>) => [...e.find.runs, ...e.confirm.runs].map((r) => r.prompt);

describe("runCorpus", () => {
  test("runs a case's five sessions: the finds on each engine, the confirms on the confirm engines", async () => {
    const e = engines();
    answerCase(e);
    const run = await runCorpus(options(e));
    expect(run.kind).toBe("ran");
    if (run.kind !== "ran") return;
    expect(run.spent).toBe(5);
    expect(run.stopped).toBeNull();
    expect(e.find.runs.map((r) => r.engine).toSorted()).toEqual(["claude", "codex"]);
    expect(e.confirm.runs.map((r) => r.engine)).toEqual(["claude", "codex", "codex"]);
    // Claude's candidate alone for the two confirms of Claude's find, both finds merged for the third.
    const [claudeConfirm, codexConfirm, bothConfirm] = e.confirm.runs.map((r) => r.prompt);
    expect(claudeConfirm).toContain("C1");
    expect(claudeConfirm).not.toContain("C2");
    expect(codexConfirm).not.toContain("C2");
    expect(bothConfirm).toContain("C2");
    expect(bothConfirm).toContain("Orders are charged one short");
    for (const r of [...e.find.runs, ...e.confirm.runs])
      expect(r.cwd).toBe(join(buildRoot, "worktrees", "case-1234abcd"));
    expect(disposed).toEqual(["ts-charge-all"]);
  });

  test("keeps each session on disk with its answer, usage, wall time and CLI, and the case's inputs once", async () => {
    const e = engines();
    answerCase(e);
    let now = 0;
    const clock: Clock = { now: () => (now += 1500) };
    await runCorpus(options(e, { clock, only: { sessions: ["claude-find"] } }));
    expect(stored("ts-charge-all", "claude-find")).toEqual({
      session: "claude-find",
      text: block({ findings: [CLAUDE_FIND], earlier: [] }),
      json: null,
      usage: { inputTokens: 100, outputTokens: 10 },
      wallMs: 1500,
      cli: { name: "claude", version: "2.1.0", model: null },
      outcome: "ok",
      failure: null,
    });
    expect(JSON.parse(readFileSync(join(runFolder, "ts-charge-all", "inputs.json"), "utf8"))).toEqual({
      caseHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      head: HEAD,
      diff: DIFF,
      rules: [REVIEW],
    });
    // A confirm out of scope isn't run, nor counted.
    expect(e.confirm.runs).toEqual([]);
  });

  test("a rerun skips every session stored usable, and runs again one that wasn't", async () => {
    const first = engines();
    first.find.answerFor("claude", found(CLAUDE_FIND));
    first.find.answerFor("codex", found(CODEX_FIND));
    first.confirm.answerFor("claude", confirmed("C1"));
    // codex-confirms-claude times out; codex-confirms-both answers.
    first.confirm.answerFor("codex", { outcome: "timeout", text: "" }, confirmed("C1", "C2"));
    const ran = await runCorpus(options(first));
    expect(ran.kind === "ran" && ran.spent).toBe(5);
    expect(stored("ts-charge-all", "codex-confirms-claude")).toMatchObject({
      outcome: "timeout",
      failure: "timeout",
    });
    expect(plannedSessions({ review: REVIEW.text, cases: [evalCase("ts-charge-all")], runFolder })).toEqual({
      sessions: 1,
      engines: ["codex"],
    });

    const second = engines();
    second.confirm.answerFor("codex", confirmed("C1"));
    prepared = [];
    const again = await runCorpus(options(second));
    expect(again.kind === "ran" && again.spent).toBe(1);
    expect(second.find.runs).toEqual([]);
    expect(second.confirm.runs.map((r) => r.engine)).toEqual(["codex"]);
    expect(stored("ts-charge-all", "codex-confirms-claude")).toMatchObject({ outcome: "ok", failure: null });

    // Everything stored: nothing to spend, nothing prepared, the stored sessions and inputs come back.
    prepared = [];
    const third = engines();
    const done = await runCorpus(options(third));
    expect(prepared).toEqual([]);
    expect(done.kind === "ran" && done.spent).toBe(0);
    if (done.kind !== "ran") return;
    expect(Object.keys(done.cases[0]?.sessions ?? {}).toSorted()).toEqual([
      "claude-confirms-claude",
      "claude-find",
      "codex-confirms-both",
      "codex-confirms-claude",
      "codex-find",
    ]);
    expect(done.cases[0]?.inputs?.diff).toBe(DIFF);
  });

  test("an engine at its limit stops the whole run: no other session starts, no other case is prepared", async () => {
    const e = engines();
    e.find.answerFor("claude", found(CLAUDE_FIND));
    e.find.answerFor("codex", { outcome: "quota_exhausted", text: "" });
    const run = await runCorpus(options(e, { cases: [evalCase("ts-charge-all"), evalCase("py-two")] }));
    expect(run).toMatchObject({
      kind: "ran",
      spent: 2,
      stopped: { caseId: "ts-charge-all", session: "codex-find", outcome: "quota_exhausted" },
    });
    expect(e.confirm.runs).toEqual([]);
    expect(prepared).toEqual(["ts-charge-all"]);
    expect(stored("ts-charge-all", "codex-find")).toMatchObject({
      outcome: "quota_exhausted",
      failure: "quota_exhausted",
    });
  });

  test("signed out stops the run too", async () => {
    const e = engines();
    e.find.answerFor("claude", { outcome: "auth_required", text: "" });
    e.find.answerFor("codex", found(CODEX_FIND));
    const run = await runCorpus(options(e));
    expect(run).toMatchObject({ kind: "ran", stopped: { session: "claude-find", outcome: "auth_required" } });
    expect(e.confirm.runs).toEqual([]);
  });

  test("a crashed find and an unreadable confirm are stored with their reasons, and the run goes on", async () => {
    const e = engines();
    e.find.answerFor("claude", { outcome: "crashed", text: "" }, found(CLAUDE_FIND));
    e.find.answerFor("codex", found(CODEX_FIND), found(CODEX_FIND));
    e.confirm.answerFor("claude", { outcome: "ok", text: "Looks fine to me." });
    e.confirm.answerFor("codex", confirmed("C1"), confirmed("C1", "C2"));
    const run = await runCorpus(options(e, { cases: [evalCase("ts-charge-all"), evalCase("py-two")] }));
    expect(run).toMatchObject({ kind: "ran", stopped: null });
    expect(stored("ts-charge-all", "claude-find")).toMatchObject({ outcome: "crashed", failure: "crashed" });
    // Its find failed: the confirms of Claude's find have nothing to run on, and aren't run.
    expect(existsSync(join(runFolder, "ts-charge-all", "claude-confirms-claude.json"))).toBe(false);
    expect(existsSync(join(runFolder, "ts-charge-all", "codex-confirms-both.json"))).toBe(false);
    expect(stored("py-two", "claude-confirms-claude")).toMatchObject({
      outcome: "ok",
      failure: "unreadable",
    });
    expect(stored("py-two", "codex-confirms-both")).toMatchObject({ outcome: "ok", failure: null });
    expect(run.kind === "ran" && run.spent).toBe(2 + 5);
  });

  test("a find with nothing found leaves its confirms nothing to judge: stored, no session spent", async () => {
    const e = engines();
    e.find.answerFor("claude", found());
    e.find.answerFor("codex", found());
    const run = await runCorpus(options(e));
    expect(run.kind === "ran" && run.spent).toBe(2);
    expect(e.confirm.runs).toEqual([]);
    expect(stored("ts-charge-all", "codex-confirms-both")).toEqual({
      session: "codex-confirms-both",
      outcome: "no_candidates",
    });
  });

  test("no prompt carries the case's planted bug or its id", async () => {
    const e = engines();
    answerCase(e);
    await runCorpus(options(e));
    expect(promptsOf(e)).toHaveLength(5);
    for (const prompt of promptsOf(e)) {
      expect(prompt).not.toContain(BUG);
      expect(prompt).not.toContain("ts-charge-all");
    }
  });

  test("above its cap, the run refuses before any session, any prepare or the lock", async () => {
    const e = engines();
    let locked = false;
    const cases = [evalCase("ts-charge-all"), evalCase("py-two")];
    expect(plannedSessions({ review: REVIEW.text, cases, runFolder })).toEqual({
      sessions: 10,
      engines: ["claude", "codex"],
    });
    expect(
      plannedSessions({
        review: REVIEW.text,
        cases,
        runFolder,
        only: { cases: ["py-two"], sessions: ["codex-find"] },
      }),
    ).toEqual({ sessions: 1, engines: ["codex"] });
    // Codex's confirm of Claude's find, with that find not stored: the find runs too, on Claude.
    expect(
      plannedSessions({
        review: REVIEW.text,
        cases,
        runFolder,
        only: { cases: ["py-two"], sessions: ["claude-find", "codex-confirms-claude"] },
      }),
    ).toEqual({ sessions: 2, engines: ["claude", "codex"] });
    const run = await runCorpus(
      options(e, {
        cases,
        maxSessions: 9,
        lock: () => {
          locked = true;
          return { release: () => undefined };
        },
      }),
    );
    expect(run).toEqual({ kind: "refused", reason: "over_cap", planned: 10, maxSessions: 9 });
    expect({ locked, prepared, runs: e.find.runs.length }).toEqual({ locked: false, prepared: [], runs: 0 });
  });

  test("a held lock refuses to start; a run releases the lock it took", async () => {
    const e = engines();
    answerCase(e);
    const held = await runCorpus(
      options(e, {
        lock: () => {
          throw new Error("Another live run holds the lock.");
        },
      }),
    );
    expect(held).toEqual({ kind: "refused", reason: "locked", message: "Another live run holds the lock." });
    expect(prepared).toEqual([]);
    let released = 0;
    await runCorpus(options(e, { lock: () => ({ release: () => (released += 1) }) }));
    expect(released).toBe(1);
  });

  test("the run folder is never in the build root, and a case's worktree always is", async () => {
    const e = engines();
    answerCase(e);
    expect(await runCorpus(options(e, { runFolder: join(buildRoot, "runs") }))).toMatchObject({
      kind: "refused",
      reason: "folders",
    });
    const elsewhere = (c: EvalCase) => prepare(c).then((p) => ({ ...p, cwd: join(temp, "elsewhere") }));
    expect(runCorpus(options(e, { prepare: elsewhere }))).rejects.toThrow("outside the build root");
  });

  test("a stored case whose head moved is refused rather than mixed with a new answer", async () => {
    const e = engines();
    answerCase(e);
    await runCorpus(options(e, { only: { sessions: ["claude-find"] } }));
    const file = join(runFolder, "ts-charge-all", "inputs.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), head: "1111111" }));
    expect(runCorpus(options(e))).rejects.toThrow("answered commit 1111111");
  });

  test("a resumed case whose rules come back different is refused before any session: inputs are never mixed", async () => {
    const e = engines();
    answerCase(e);
    await runCorpus(options(e, { only: { sessions: ["claude-find"] } }));
    const agents = { path: "AGENTS.md" as const, text: "- Run the tests.\n", commit: HEAD };
    const moreRules = (c: EvalCase) => prepare(c).then((p) => ({ ...p, rules: [REVIEW, agents] }));
    const resumed = engines();
    answerCase(resumed);
    expect(runCorpus(options(resumed, { prepare: moreRules }))).rejects.toThrow(
      "its stored sessions were given other rules",
    );
    await Bun.sleep(0);
    expect(resumed.find.runs).toEqual([]);
    expect(JSON.parse(readFileSync(join(runFolder, "ts-charge-all", "inputs.json"), "utf8")).rules).toEqual([
      REVIEW,
    ]);
  });

  test("a case prepared without the corpus' REVIEW.md is refused before any session, nothing stored", async () => {
    const e = engines();
    answerCase(e);
    const noRules = (c: EvalCase) => prepare(c).then((p) => ({ ...p, rules: [] }));
    expect(runCorpus(options(e, { prepare: noRules }))).rejects.toThrow(
      "ts-charge-all: its rules came back without the corpus' REVIEW.md",
    );
    const otherText = (c: EvalCase) =>
      prepare(c).then((p) => ({ ...p, rules: [{ ...REVIEW, text: "- Something else.\n" }] }));
    expect(runCorpus(options(e, { prepare: otherText }))).rejects.toThrow("without the corpus' REVIEW.md");
    await Bun.sleep(0);
    expect(e.find.runs).toEqual([]);
    expect(existsSync(join(runFolder, "ts-charge-all", "inputs.json"))).toBe(false);
  });

  test("an edited case is refused even when every session is stored: its old answers never pass for current", async () => {
    const e = engines();
    answerCase(e);
    await runCorpus(options(e));
    const edited = { ...evalCase("ts-charge-all"), summary: "Charges orders." };
    expect(runCorpus(options(engines(), { cases: [edited] }))).rejects.toThrow(
      "ts-charge-all or the corpus' REVIEW.md was edited",
    );
    expect(() => readRun({ review: REVIEW.text, cases: [edited], runFolder })).toThrow("was edited");
    expect(() => plannedSessions({ review: REVIEW.text, cases: [edited], runFolder })).toThrow("was edited");
    expect(prepared).toEqual(["ts-charge-all"]);
  });

  test("the corpus' REVIEW.md edited after a complete run is refused: no answer under the old rules passes for current", async () => {
    const e = engines();
    answerCase(e);
    await runCorpus(options(e));
    const rules = `${REVIEW.text}- Never log a card number.\n`;
    expect(runCorpus(options(engines(), { review: rules }))).rejects.toThrow(
      "ts-charge-all or the corpus' REVIEW.md was edited",
    );
    expect(() => readRun({ review: rules, cases: [evalCase("ts-charge-all")], runFolder })).toThrow(
      "was edited",
    );
    expect(() => plannedSessions({ review: rules, cases: [evalCase("ts-charge-all")], runFolder })).toThrow(
      "was edited",
    );
    // Line endings aren't an edit: the builder writes REVIEW.md as LF whatever the checkout gave.
    const crlf = readRun({
      review: REVIEW.text.replaceAll("\n", "\r\n"),
      cases: [evalCase("ts-charge-all")],
      runFolder,
    });
    expect(crlf.map((c) => c.caseId)).toEqual(["ts-charge-all"]);
    expect(prepared).toEqual(["ts-charge-all"]);
  });

  test("a stored session file that can't be read, or isn't its session's, is refused, naming it", async () => {
    const e = engines();
    answerCase(e);
    await runCorpus(options(e));
    const file = join(runFolder, "ts-charge-all", "codex-find.json");
    const good = readFileSync(file, "utf8");
    const again = () => runCorpus(options(engines()));
    writeFileSync(file, "{ cut short");
    expect(again()).rejects.toThrow(`${file} can't be read`);
    writeFileSync(file, JSON.stringify({ session: "codex-find", outcome: "ok" }));
    expect(again()).rejects.toThrow(`${file} isn't what the runner stores`);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(good), session: "claude-find" }));
    expect(again()).rejects.toThrow(`${file} holds the session claude-find`);
    const onClaude = JSON.parse(good);
    writeFileSync(file, JSON.stringify({ ...onClaude, cli: { ...onClaude.cli, name: "claude" } }));
    expect(again()).rejects.toThrow(`${file} ran on claude, but codex-find runs on codex`);
  });

  test("readRun gives a stored run back as it is, its failed sessions included: nothing prepared, nothing spent", async () => {
    const e = engines();
    e.find.answerFor("claude", found(CLAUDE_FIND));
    e.find.answerFor("codex", { outcome: "timeout", text: "" });
    e.confirm.answerFor("claude", confirmed("C1"));
    e.confirm.answerFor("codex", confirmed("C1"));
    await runCorpus(options(e));
    prepared = [];
    const read = readRun({
      review: REVIEW.text,
      cases: [evalCase("ts-charge-all"), evalCase("py-two")],
      runFolder,
    });
    expect(read.map((c) => c.caseId)).toEqual(["ts-charge-all", "py-two"]);
    expect(read[0]?.inputs?.head).toBe(HEAD);
    expect(read[0]?.sessions["codex-find"]).toMatchObject({ outcome: "timeout", failure: "timeout" });
    expect(Object.keys(read[0]?.sessions ?? {}).toSorted()).toEqual([
      "claude-confirms-claude",
      "claude-find",
      "codex-confirms-claude",
      "codex-find",
    ]);
    // A case never run comes back with nothing stored.
    expect(read[1]).toEqual({ caseId: "py-two", inputs: null, sessions: {} });
    expect(
      readRun({
        review: REVIEW.text,
        cases: [evalCase("ts-charge-all"), evalCase("py-two")],
        runFolder,
        only: { cases: ["py-two"] },
      }).map((c) => c.caseId),
    ).toEqual(["py-two"]);
    expect(() => readRun({ review: REVIEW.text, cases: [], runFolder, only: { cases: ["nope"] } })).toThrow(
      "No eval case is called nope.",
    );
    expect(prepared).toEqual([]);
  });

  test("a session that throws is rethrown only once the other engine's session has ended and been stored", async () => {
    const order: string[] = [];
    const codex = new FakeEngines();
    codex.answerFor("codex", found(CODEX_FIND));
    const find: Engines = {
      health: () => Promise.resolve(HEALTH("1.0.0")),
      run: async (spec, signal) => {
        if (spec.engine === "claude") throw new Error("the engine broke");
        await Bun.sleep(20);
        const result = await codex.run(spec, signal);
        order.push("codex answered");
        return result;
      },
    };
    const disposing = (c: EvalCase) =>
      prepare(c).then((p) => ({
        ...p,
        dispose: () => {
          order.push("disposed");
          return Promise.resolve();
        },
      }));
    const e = engines();
    expect(runCorpus(options(e, { findEngines: find, prepare: disposing }))).rejects.toThrow(
      "the engine broke",
    );
    await Bun.sleep(60);
    expect(order).toEqual(["codex answered", "disposed"]);
    expect(stored("ts-charge-all", "codex-find")).toMatchObject({ outcome: "ok", failure: null });
  });

  test("each engine's version is asked once, before the first session: no health check between an answer and its record", async () => {
    const events: string[] = [];
    const watched = (inner: FakeEngines, role: string): Engines => ({
      health: (engine) => {
        events.push(`${role} health ${engine}`);
        return inner.health(engine);
      },
      run: (spec, signal) => {
        events.push(`${role} run ${spec.engine}`);
        return inner.run(spec, signal);
      },
    });
    const e = engines();
    answerCase(e);
    await runCorpus(
      options(e, { findEngines: watched(e.find, "find"), confirmEngines: watched(e.confirm, "confirm") }),
    );
    const firstRun = events.findIndex((x) => x.includes(" run "));
    expect(events.slice(0, firstRun).toSorted()).toEqual([
      "confirm health claude",
      "confirm health codex",
      "find health claude",
      "find health codex",
    ]);
    expect(events.slice(firstRun).every((x) => x.includes(" run "))).toBe(true);
    expect(stored("ts-charge-all", "codex-confirms-both")).toMatchObject({
      cli: { name: "codex", version: "0.50.0" },
    });
  });

  test("an unknown case in scope is an error", () => {
    expect(() =>
      plannedSessions({
        review: REVIEW.text,
        cases: [evalCase("ts-charge-all")],
        runFolder,
        only: { cases: ["nope"] },
      }),
    ).toThrow("No eval case is called nope.");
  });
});

describe("sameRun", () => {
  const ran = (
    session: SessionRecord["session"],
    name: "claude" | "codex",
    version: string,
    model: string | null,
  ) =>
    ({
      session,
      text: "",
      json: null,
      usage: null,
      wallMs: 0,
      cli: { name, version, model },
      outcome: "ok",
      failure: null,
    }) satisfies SessionRecord;

  test("every engine's sessions on one version and one model are one run, whatever the other engine ran", () => {
    expect(
      sameRun([
        ran("claude-find", "claude", "2.1.0", "claude-opus-5-5"),
        ran("claude-confirms-claude", "claude", "2.1.0", "claude-opus-5-5"),
        ran("codex-find", "codex", "0.50.0", "gpt-6-astra"),
        { session: "codex-confirms-both", outcome: "no_candidates" },
      ]),
    ).toEqual({ kind: "same" });
  });

  test("two versions or two models of one engine are refused, naming them", () => {
    expect(
      sameRun([
        ran("claude-find", "claude", "2.1.0", "claude-opus-5-5"),
        ran("claude-confirms-claude", "claude", "2.2.0", "claude-opus-5-5"),
      ]),
    ).toEqual({ kind: "mixed", engine: "claude", on: "version", values: ["2.1.0", "2.2.0"] });
    expect(
      sameRun([
        ran("claude-find", "claude", "2.1.0", "claude-opus-5-5"),
        ran("claude-confirms-claude", "claude", "2.1.0", "claude-opus-5-6"),
      ]),
    ).toEqual({
      kind: "mixed",
      engine: "claude",
      on: "model",
      values: ["claude-opus-5-5", "claude-opus-5-6"],
    });
  });

  test("a used session whose version or model is unknown is refused: it can't be shown to be the same run", () => {
    expect(
      sameRun([
        ran("codex-find", "codex", "0.50.0", "gpt-6-astra"),
        ran("codex-confirms-both", "codex", "0.50.0", null),
      ]),
    ).toEqual({ kind: "unknown", engine: "codex", on: "model", sessions: ["codex-confirms-both"] });
    expect(
      sameRun([
        {
          ...ran("claude-find", "claude", "2.1.0", "claude-opus-5-5"),
          cli: { name: "claude", version: null, model: "claude-opus-5-5" },
        },
      ]),
    ).toEqual({
      kind: "unknown",
      engine: "claude",
      on: "version",
      sessions: ["claude-find"],
    });
  });

  test("sameRunRefusal says why sessions aren't one run, naming the engine and what differs; nothing when they are", () => {
    expect(sameRunRefusal({ kind: "same" })).toBeNull();
    expect(
      sameRunRefusal({
        kind: "mixed",
        engine: "claude",
        on: "model",
        values: ["claude-opus-5-5", "claude-opus-5-6"],
      }),
    ).toBe(
      "The sessions ran on more than one model of claude: claude-opus-5-5, claude-opus-5-6. A report is made from one run.",
    );
    expect(
      sameRunRefusal({
        kind: "unknown",
        engine: "codex",
        on: "version",
        sessions: ["codex-find", "codex-confirms-both"],
      }),
    ).toBe(
      "The version of codex isn't known for codex-find, codex-confirms-both: a report is made from one run, every session on a known version and model.",
    );
  });

  test("a failed session's CLI says nothing of the answers kept: it is left out", () => {
    const crashed: SessionRecord = {
      ...ran("codex-find", "codex", "0.50.0", null),
      outcome: "crashed",
      failure: "crashed",
    };
    expect(sameRun([ran("claude-find", "claude", "2.1.0", "claude-opus-5-5"), crashed])).toEqual({
      kind: "same",
    });
  });
});

describe("the model a session records", () => {
  /** Engines that leave a run folder on disk as `engines` does: `run.json` with the model asked for, and the stream. */
  const onDisk = (
    inner: FakeEngines,
    stream: Record<"claude" | "codex", string[]>,
    asked: Record<"claude" | "codex", string>,
  ): Engines => ({
    health: (engine) => inner.health(engine),
    run: async (spec, signal) => {
      const result = await inner.run(spec, signal);
      mkdirSync(spec.artefactsDir, { recursive: true });
      writeFileSync(
        join(spec.artefactsDir, "run.json"),
        JSON.stringify({ engine: spec.engine, model: asked[spec.engine] }),
      );
      writeFileSync(
        join(spec.artefactsDir, "stdout.jsonl"),
        stream[spec.engine].map((l) => `${l}\n`).join(""),
      );
      return result;
    },
  });

  test("Claude's is the model its stream's init event names, not the alias it was asked for; Codex's is the one it was given", async () => {
    const e = engines();
    answerCase(e);
    const stream = {
      claude: [
        JSON.stringify({
          type: "system",
          subtype: "init",
          model: "claude-opus-5-5",
          claude_code_version: "2.1.283",
        }),
        JSON.stringify({ type: "result", subtype: "success", result: "..." }),
      ],
      codex: [
        JSON.stringify({ type: "thread.started", thread_id: "t" }),
        JSON.stringify({ type: "turn.started" }),
      ],
    };
    const asked = { claude: "opus", codex: "gpt-6-astra" };
    await runCorpus(
      options(e, {
        findEngines: onDisk(e.find, stream, asked),
        confirmEngines: onDisk(e.confirm, stream, asked),
      }),
    );
    for (const session of ["claude-find", "claude-confirms-claude"])
      expect(stored("ts-charge-all", session)).toMatchObject({
        cli: { name: "claude", model: "claude-opus-5-5" },
      });
    expect(stored("ts-charge-all", "codex-confirms-both")).toMatchObject({
      cli: { name: "codex", model: "gpt-6-astra" },
    });
  });

  test("a Claude stream with no init event, or none at all, leaves the model unknown", async () => {
    const e = engines();
    answerCase(e);
    const stream = { claude: ["not json", JSON.stringify({ type: "result", result: "..." })], codex: [] };
    const asked = { claude: "opus", codex: "gpt-6-astra" };
    await runCorpus(options(e, { findEngines: onDisk(e.find, stream, asked), confirmEngines: e.confirm }));
    expect(stored("ts-charge-all", "claude-find")).toMatchObject({ cli: { name: "claude", model: null } });
    // The confirm engines leave no run folder: unknown too.
    expect(stored("ts-charge-all", "codex-confirms-both")).toMatchObject({
      cli: { name: "codex", model: null },
    });
  });
});
