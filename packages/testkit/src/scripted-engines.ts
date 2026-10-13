// Engines from a script (ADR 0046): the `Engines` port, and structurally `engines`' `SelfTests` (the shape
// `packages/engines` declares; it is not imported: testkit may reach only contracts), with a sign-in the demo's
// terminal opener calls (`signIn`). A run is
// answered by the worktree it runs in (the scripted retrieval gives each commit of each change its own,
// `<root>/<change>/<sha>`) and the pass the prompt is for, find or confirm, told apart by the marker line each of
// `review`'s prompts carries (`passOf`: the one place that knows the prompts' words). An answer is written as
// data (findings, verdicts on earlier findings, confirm verdicts) and rendered here into the exact text `review`
// reads: free notes, then one fenced `json` block. A script is kept, not consumed: the same commit reviewed twice
// reads the same answer. A run's duration elapses on the timers given (the demo clock), never on a real timer;
// an answer's activities (ADR 0055) play to the run's listener on those timers, each at its `afterMs`, before the
// answer, none after it, a cancel or the limit; health, the wait and the run folder are `EngineDouble`'s, which `FakeEngines` shares. An engine signed out while a run waits ends that run
// `auth_required`, as a real session whose sign-in has expired answers its next call; one uninstalled ends it
// `crashed`. Nothing scripted for a worktree or a pass, or a prompt with no marker, ends the run `crashed` with a
// text saying what was missing: a silent default would let a scenario pass by accident.
import type {
  ConfirmVerdict,
  DiffSide,
  EngineId,
  EngineRunOutcome,
  EngineRunResult,
  EngineRunSpec,
  Engines,
  EngineUsage,
  Severity,
} from "@lookover/contracts";
import { EngineDouble, type EngineTimers, type ScriptedActivity } from "./engine-double.ts";

interface ScriptedEnginesOptions {
  /** What a run's duration and a sign-in elapse on: the demo clock. */
  timers: EngineTimers;
}

/** One finding of a find answer, in contracts' words; rendered in the block's (`line_text`, `defect_key`…). */
export interface ScriptedFinding {
  path: string;
  /** `head` unless said. */
  side?: DiffSide;
  line: number;
  /** The last line of its range; none: one line. */
  endLine?: number;
  /** The text of `line` as the diff shows it: what `review` anchors by. */
  lineText: string;
  severity: Severity;
  category: string;
  title: string;
  body: string;
  defectKey: string;
  /** Replacement code; none: null. */
  suggestion?: string;
  /** False unless said. */
  preExisting?: boolean;
  /** The label of the repository's rule it follows, as the prompt gives it (ADR 0048); none: it follows none. */
  rule?: `R${number}`;
}

/** The engine's verdict on an earlier finding the prompt asked about, by that finding's id. */
export interface ScriptedEarlierVerdict {
  id: string;
  present: boolean;
  /** The finding was a mistake: the answer to its author's dispute (ADR 0052), read only on a disputed one. */
  wrong?: boolean;
  why: string;
}

/** What a find pass answers: the notes before the block, and the block's lists. */
export interface ScriptedFindAnswer {
  /** The free notes before the block; none unless said. */
  notes?: string;
  findings: ScriptedFinding[];
  earlier?: ScriptedEarlierVerdict[];
  /** Why nothing was found, when the engine says so. */
  emptyReason?: string;
  usage?: EngineUsage;
  /** How long the run takes on the timers; none: the answer comes at once. */
  tookMs?: number;
  /** What the engine reports while it runs, each at its `afterMs` (ADR 0055); one due after the answer never. */
  activity?: ScriptedActivity[];
}

/** One verdict of a confirm answer, by the claim's id in the prompt (`C1`, `C2`…). */
export interface ScriptedConfirmVerdict {
  id: string;
  verdict: ConfirmVerdict;
  reason: string;
  /** The lines that show it, `path:line`; none unless said. */
  evidence?: string[];
  severity: Severity;
}

/** What a confirm pass answers. */
export interface ScriptedConfirmAnswer {
  notes?: string;
  verdicts: ScriptedConfirmVerdict[];
  usage?: EngineUsage;
  tookMs?: number;
  /** What the engine reports while it runs, each at its `afterMs` (ADR 0055); one due after the answer never. */
  activity?: ScriptedActivity[];
}

/** The pass a prompt is for: the find pass of a round, or the confirm pass on its candidates. */
type ScriptedPass = "find" | "confirm";

/**
 * How a run can end on the program's side without an answer: signed out, at the plan's limit, the error flag,
 * or a crash. (`timeout` and `cancelled` are the limit's and the signal's, never scripted.)
 */
export type ScriptedFailure = "auth_required" | "quota_exhausted" | "invalid_output" | "crashed";

/** A self-test's report: `engines`' `SelfTestReport`, by shape. The one rule a scripted self-test breaks is the wall. */
interface ScriptedSelfTestReport {
  verdict: "passed" | "failed" | "inconclusive";
  failures: "wall"[];
  missingFlags: string[];
  outcome: EngineRunOutcome | null;
  usage: EngineUsage | null;
  tookMs: number;
}

/** How long a sign-in takes on the clock before health says signed in. */
const SIGN_IN_MS = 5_000;

/**
 * The pass `prompt` is for, from the marker line `review` writes in each: the find prompt says "round N of this
 * pull request's review", the confirm prompt "the confirm pass of round N". Null when neither is there: the
 * prompt changed, and the scenarios' tests say so.
 */
function passOf(prompt: string): ScriptedPass | null {
  if (/\bthe confirm pass of round \d+\b/.test(prompt)) return "confirm";
  if (/\bround \d+ of this pull request's review\b/.test(prompt)) return "find";
  return null;
}

/** The find answer as the engine would write it: the block in the shape the find prompt asks for. */
function renderFind(answer: ScriptedFindAnswer): string {
  const block = {
    findings: answer.findings.map((f) => ({
      path: f.path,
      side: f.side ?? "head",
      line: f.line,
      end_line: f.endLine ?? null,
      line_text: f.lineText,
      severity: f.severity,
      category: f.category,
      title: f.title,
      body: f.body,
      defect_key: f.defectKey,
      suggestion: f.suggestion ?? null,
      pre_existing: f.preExisting ?? false,
      ...(f.rule ? { rule: f.rule } : {}),
    })),
    earlier: (answer.earlier ?? []).map((v) => ({
      id: v.id,
      present: v.present,
      ...(v.wrong ? { wrong: true } : {}),
      why: v.why,
    })),
    empty_reason: answer.emptyReason ?? null,
  };
  return renderAnswer(answer.notes, block);
}

/** The confirm answer as the engine would write it: the block in the shape the confirm prompt asks for. */
function renderConfirm(answer: ScriptedConfirmAnswer): string {
  const block = {
    verdicts: answer.verdicts.map((v) => ({
      id: v.id,
      verdict: v.verdict,
      reason: v.reason,
      evidence: v.evidence ?? [],
      severity: v.severity,
    })),
  };
  return renderAnswer(answer.notes, block);
}

/** Free notes (when any), a blank line, then the one fenced `json` block, the last thing in the answer. */
function renderAnswer(notes: string | undefined, block: unknown): string {
  const head = notes ? [notes, ""] : [];
  return [...head, "```json", JSON.stringify(block, null, 2), "```", ""].join("\n");
}

/** What a scripted answer gives a run once its time has passed. */
interface Scripted {
  text: string;
  usage: EngineUsage | null;
  tookMs: number;
  activity: ScriptedActivity[];
}

/**
 * Engines whose every run answers from the script: one answer per worktree and pass, health per engine set by
 * hand, failures told one run ahead, self-tests that pass unless a version is told to fail. It keeps every run
 * asked for and every self-test, in order.
 */
export class ScriptedEngines extends EngineDouble implements Engines {
  /** Every self-test asked for, in order: the engine and the folder it was given. */
  readonly selfTests: { engine: EngineId; dir: string }[] = [];
  private readonly answers = new Map<string, Scripted>();
  private readonly nextFailure: Partial<Record<EngineId, { failure: ScriptedFailure; limitUntil?: number }>> =
    {};
  private readonly failingVersions: Record<EngineId, Set<string>> = { claude: new Set(), codex: new Set() };

  constructor(options: ScriptedEnginesOptions) {
    super(options.timers);
  }

  /** From now on a find pass in `worktree` answers `answer` (replacing an earlier script of it). */
  scriptFind(worktree: string, answer: ScriptedFindAnswer): void {
    this.answers.set(keyOf(worktree, "find"), {
      text: renderFind(answer),
      usage: answer.usage ?? null,
      tookMs: answer.tookMs ?? 0,
      activity: answer.activity ?? [],
    });
  }

  /** From now on a confirm pass in `worktree` answers `answer` (replacing an earlier script of it). */
  scriptConfirm(worktree: string, answer: ScriptedConfirmAnswer): void {
    this.answers.set(keyOf(worktree, "confirm"), {
      text: renderConfirm(answer),
      usage: answer.usage ?? null,
      tookMs: answer.tookMs ?? 0,
      activity: answer.activity ?? [],
    });
  }

  /**
   * The user signs `engine` in: 5 s later on the timers its health says signed in (and nothing more to say).
   * Throws when it isn't installed: there is nothing to sign in to.
   */
  signIn(engine: EngineId): void {
    const health = this.healthOf(engine);
    if (!health.installed) throw new Error(`${engine} is not installed: nothing to sign in to`);
    this.timers.after(SIGN_IN_MS, () => {
      const now = this.healthOf(engine);
      this.healths[engine] = { installed: now.installed, version: now.version, signedIn: true };
    });
  }

  /**
   * The next run of `engine`, whatever its worktree and pass, ends `failure` instead of answering; the one after
   * answers again. At the limit, `limitUntil` is when it resets, as the run says (ADR 0055); none, it says no time.
   */
  nextRunAnswers(engine: EngineId, failure: ScriptedFailure, limitUntil?: number): void {
    this.nextFailure[engine] = { failure, ...(limitUntil === undefined ? {} : { limitUntil }) };
  }

  /** The self-test of `engine` at `version` fails (on the wall) from now on; every other version passes. */
  failSelfTest(engine: EngineId, version: string): void {
    this.failingVersions[engine].add(version);
  }

  async run(spec: EngineRunSpec, signal: AbortSignal): Promise<EngineRunResult> {
    this.runs.push(spec);
    // A run that ends before its scripted time says it took none: the fake keeps no clock of its own.
    const base = { text: "", json: null, usage: null, tookMs: 0, artefactsDir: spec.artefactsDir };
    const end = (outcome: EngineRunOutcome, text = "") => this.keep(spec, { ...base, outcome, text });
    if (signal.aborted) return end("cancelled");
    const health = this.healthOf(spec.engine);
    if (!health.installed) return end("crashed", `${spec.engine} is not installed`);
    const next = this.nextFailure[spec.engine];
    if (next) {
      delete this.nextFailure[spec.engine];
      if (next.failure === "quota_exhausted" && next.limitUntil !== undefined)
        return this.keep(spec, { ...base, outcome: next.failure, limitUntil: next.limitUntil });
      return end(next.failure);
    }
    if (!health.signedIn) return end("auth_required");
    const pass = passOf(spec.prompt);
    if (pass === null)
      return end(
        "crashed",
        "Nothing scripted: the prompt carries neither the find pass's marker nor the confirm pass's",
      );
    const scripted = this.answers.get(keyOf(spec.cwd, pass));
    if (!scripted) return end("crashed", `Nothing scripted for the ${pass} pass in ${spec.cwd}`);
    const took = scripted.tookMs;
    if (took > 0 && !(await this.playing(spec, scripted.activity, Math.min(took, spec.timeoutMs), signal)))
      return end("cancelled");
    if (took > spec.timeoutMs)
      return this.keep(spec, { ...base, outcome: "timeout", tookMs: spec.timeoutMs });
    // Uninstalled while it ran, the run crashes; signed out, the session's next call is refused, so the run asks
    // for a sign-in at its end.
    const after = this.healthOf(spec.engine);
    if (!after.installed) return end("crashed", `${spec.engine} is not installed`);
    if (!after.signedIn) return end("auth_required");
    return this.keep(spec, {
      ...base,
      outcome: "ok",
      text: scripted.text,
      usage: scripted.usage,
      tookMs: took,
    });
  }

  /** `engines`' `SelfTests`: the program a self-test's result is kept under; a path of the script's when installed. */
  program(engine: EngineId): string | null {
    return this.healthOf(engine).installed ? `scripted/${engine}` : null;
  }

  /**
   * `engines`' `SelfTests`: at once, passed, unless the version was told to fail (failed, on the wall); not
   * installed or already cancelled, inconclusive with no outcome (no run made), signed out, inconclusive with the
   * run's `auth_required`, as the real one.
   */
  selfTest(engine: EngineId, dir: string, signal: AbortSignal): Promise<ScriptedSelfTestReport> {
    this.selfTests.push({ engine, dir });
    const none = { failures: [], missingFlags: [], usage: null, tookMs: 0 };
    const health = this.healthOf(engine);
    const report = (
      r: Pick<ScriptedSelfTestReport, "verdict" | "outcome"> & Partial<ScriptedSelfTestReport>,
    ) => Promise.resolve({ ...none, ...r });
    if (!health.installed || signal.aborted) return report({ verdict: "inconclusive", outcome: null });
    if (!health.signedIn) return report({ verdict: "inconclusive", outcome: "auth_required" });
    if (health.version !== null && this.failingVersions[engine].has(health.version))
      return report({ verdict: "failed", failures: ["wall"], outcome: "ok" });
    return report({ verdict: "passed", outcome: "ok" });
  }
}

/** The script's key: one answer per worktree and pass. */
const keyOf = (worktree: string, pass: ScriptedPass) => `${pass}\0${worktree}`;
