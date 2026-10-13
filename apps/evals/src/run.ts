// The runner (ADR 0050): a case's five sessions on the engines it is given, each stored the moment it ends, so a
// stopped run resumes and never pays twice. Per case, the finds run in parallel (one per engine), then the confirms,
// one lane per engine; each confirm judges the candidates `core` would ask about (`toConfirm` on an empty ledger at
// round 1, after `mergeFinds` when it confirms two finds), read back from the stored finds through `review`'s own
// reader. An engine signed out or at its limit stops the whole run; a session that crashed, timed out or came back
// unreadable is stored with its reason and the run goes on. Everything it touches comes in as a parameter (engines,
// `prepare`, lock, clock, folders), so its tests run it with no process and no git. `readRun` reads a stored run
// with the same checks and nothing else: the replay and `--keep` read through it.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type {
  Clock,
  EngineId,
  EngineRunOutcome,
  EngineRunResult,
  Engines,
  Prepared,
  PromptRulesFile,
  ReviewJob,
  RoundOutcome,
  RulesFile,
} from "@lookover/contracts";
import { mergeFinds, toConfirm } from "@lookover/core";
import { createConfirm, createReview } from "@lookover/review";
import { lf } from "./cases.ts";
import { answering, caseRules, jobOn, type RuleSwitch } from "./reading.ts";
import { artefactsOf, caseHash, readCase, type StoredCase, writeInputs, writeSession } from "./store.ts";
import {
  type CaseInputs,
  type EvalCase,
  isRead,
  isUsable,
  type PrepareCase,
  type PreparedCase,
  SESSION_NAMES,
  SESSIONS,
  type SessionCli,
  type SessionFailure,
  type SessionName,
  type SessionRecord,
} from "./types.ts";

/** Which sessions a run spends: some cases, some sessions; all of either when left out. */
export interface RunScope {
  cases?: readonly string[];
  sessions?: readonly SessionName[];
}

export interface RunCorpusOptions {
  cases: readonly EvalCase[];
  /**
   * The corpus' `REVIEW.md`, which every case's commits carry: hashed with each case, so answers stored under other
   * rules are refused.
   */
  review: string;
  /** The engines the finds run on. */
  findEngines: Engines;
  /** The engines the confirms run on (Codex at `medium` effort, as the service runs it). */
  confirmEngines: Engines;
  /** Gets a case ready: built and prepared through `retrieval`, or, in the replay, its stored inputs. */
  prepare: PrepareCase;
  /** Takes the machine's live lock; throws when another run holds it. */
  lock: () => { release(): void };
  /** Times each session's wall time. */
  clock: Clock;
  /** Where the sessions are stored: never inside `buildRoot`. */
  runFolder: string;
  /** Where `prepare` builds the repositories and worktrees, and nothing else: every case's worktree is in it. */
  buildRoot: string;
  /** The cap: a run that would spend more sessions refuses before any. */
  maxSessions: number;
  only?: RunScope;
  /** Each session's limit; the service's 20 minutes by default. */
  timeoutMs?: number;
  /** Each engine's input limit in characters, as the service gives `review` (`engines`' `INPUT_LIMITS`). */
  inputLimits?: Partial<Record<EngineId, number>>;
  /** Aborting it cancels the sessions running and starts no other. */
  signal?: AbortSignal;
  /** Told of each session the moment it is stored. */
  onSession?: (caseId: string, record: SessionRecord) => void;
}

/** What a run kept of one case: what its sessions saw (null when never prepared) and every session stored. */
export interface CaseRun {
  caseId: string;
  inputs: CaseInputs | null;
  sessions: Partial<Record<SessionName, SessionRecord>>;
}

/** The session whose outcome stopped the run: signed out, at its limit, or cancelled. */
export interface RunStop {
  caseId: string;
  session: SessionName;
  outcome: Extract<EngineRunOutcome, "auth_required" | "quota_exhausted" | "cancelled">;
}

export type CorpusRun =
  | { kind: "refused"; reason: "over_cap"; planned: number; maxSessions: number }
  | { kind: "refused"; reason: "locked" | "folders"; message: string }
  | { kind: "ran"; cases: CaseRun[]; spent: number; stopped: RunStop | null };

/** The service's limit on one review session. */
const TIMEOUT_MS = 20 * 60_000;

const STOPS = { auth_required: true, quota_exhausted: true, cancelled: true } satisfies Partial<
  Record<EngineRunOutcome, true>
>;
const stops = (outcome: string): outcome is RunStop["outcome"] => Object.hasOwn(STOPS, outcome);

const FINDS = SESSION_NAMES.filter((s) => SESSIONS[s].pass === "find");
const CONFIRMS = SESSION_NAMES.filter((s) => SESSIONS[s].pass === "confirm");

type Sessions = Partial<Record<SessionName, SessionRecord>>;

const usable = (record: SessionRecord | undefined): boolean => record !== undefined && isUsable(record);

/** The finds a session needs stored first: none for a find. */
const needs = (name: SessionName): readonly SessionName[] => {
  const session = SESSIONS[name];
  return session.pass === "confirm" ? session.of : [];
};

/** The sessions of a case a run would start: in scope, not stored usable, and (a confirm) with its finds there. */
function toRun(stored: Sessions, only: RunScope | undefined): SessionName[] {
  const wanted = SESSION_NAMES.filter(
    (s) => (only?.sessions === undefined || only.sessions.includes(s)) && !usable(stored[s]),
  );
  return wanted.filter((name) => needs(name).every((f) => usable(stored[f]) || wanted.includes(f)));
}

const casesIn = (cases: readonly EvalCase[], only: RunScope | undefined): EvalCase[] => {
  const unknown = only?.cases?.find((id) => !cases.some((c) => c.id === id));
  if (unknown !== undefined) throw new Error(`No eval case is called ${unknown}.`);
  return cases.filter((c) => only?.cases === undefined || only.cases.includes(c.id));
};

/**
 * A case as the run folder holds it, refused (thrown) when it was run for another version of the case: its stored
 * hash isn't the case's now, or it has sessions and no inputs to say what they were for.
 */
function storedCase(runFolder: string, evalCase: EvalCase, review: string): StoredCase {
  const stored = readCase(runFolder, evalCase.id);
  const folder = join(runFolder, evalCase.id);
  if (stored.caseHash === null && Object.keys(stored.sessions).length > 0)
    throw new Error(`${folder} holds sessions but no inputs.json: remove it to run the case again.`);
  if (stored.caseHash !== null && stored.caseHash !== caseHash(evalCase, review))
    throw new Error(
      `${evalCase.id} or the corpus' REVIEW.md was edited since its sessions in ${folder} ran: ` +
        "remove that folder to run it again.",
    );
  return stored;
}

/** What a run would spend: how many sessions at most, and the engines they run on, in `SESSIONS`' order. */
export interface Planned {
  sessions: number;
  engines: EngineId[];
}

/**
 * What a run would spend at most: every session in scope not stored usable, a confirm only when its finds are
 * stored or run too (one with nothing to judge spends none, which is only known once its finds are read).
 */
export function plannedSessions(
  o: Pick<RunCorpusOptions, "cases" | "review" | "runFolder" | "only">,
): Planned {
  const todo = casesIn(o.cases, o.only).flatMap((c) =>
    toRun(storedCase(o.runFolder, c, o.review).sessions, o.only),
  );
  const engines = SESSION_NAMES.filter((s) => todo.includes(s)).map((s) => SESSIONS[s].engine);
  return { sessions: todo.length, engines: [...new Set(engines)] };
}

/**
 * A stored run as it is, spending nothing (the replay, `--keep`): no lock, no `prepare`, no engine; a failed session
 * comes back as stored, never as one to run, and a case never run with no inputs and no session. Throws what the
 * run throws on reading the store: a file it can't read or that isn't its session's, a case or `REVIEW.md` edited
 * since its sessions ran, a case in scope that isn't in `cases`.
 */
export function readRun(o: Pick<RunCorpusOptions, "cases" | "review" | "runFolder" | "only">): CaseRun[] {
  return casesIn(o.cases, o.only).map((c) => {
    const { inputs, sessions } = storedCase(o.runFolder, c, o.review);
    return { caseId: c.id, inputs, sessions };
  });
}

const inside = (folder: string, path: string): boolean => {
  const rel = relative(resolve(folder), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** Waits for every piece of work, then throws the first that failed: nothing paid for is left running. */
async function settled(work: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(work);
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed === undefined) return;
  throw failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason));
}

/** An `Engines` that keeps the one run it is asked for, timed on the clock: the record is made from it. */
function recorded(engines: Engines, clock: Clock) {
  const kept: { result: EngineRunResult | null; wallMs: number } = { result: null, wallMs: 0 };
  const port: Engines = {
    health: (engine) => engines.health(engine),
    run: async (spec, signal) => {
      const started = clock.now();
      const result = await engines.run(spec, signal);
      kept.result = result;
      kept.wallMs = clock.now() - started;
      return result;
    },
  };
  return { port, kept };
}

/** A string field of a JSON object's text; null when the text isn't one, or the field isn't a string. */
function fieldOf(text: string, field: string): string | null {
  try {
    const value: unknown = JSON.parse(text);
    const found = typeof value === "object" && value !== null ? Reflect.get(value, field) : null;
    return typeof found === "string" ? found : null;
  } catch {
    // Not JSON (a line cut short, a stray print): nothing to read in it.
    return null;
  }
}

/** A file of the run folder; null when there is none (an in-memory engine leaves nothing on disk). */
function fileIn(artefactsDir: string, name: string): string | null {
  const file = join(artefactsDir, name);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

/**
 * The model that answered, as the session's own run folder says it; null when it doesn't. Claude is run on an alias
 * (`opus`, as the service runs it), so its model is the one its stream's `system` `init` event names. Codex's stream
 * names none, but it is run on an explicit model identifier, which `run.json` keeps.
 */
function modelIn(engine: EngineId, artefactsDir: string): string | null {
  if (engine === "codex") return fieldOf(fileIn(artefactsDir, "run.json") ?? "", "model");
  const lines = (fileIn(artefactsDir, "stdout.jsonl") ?? "").split("\n");
  const init = lines.find(
    (line) => fieldOf(line, "type") === "system" && fieldOf(line, "subtype") === "init",
  );
  return init === undefined ? null : fieldOf(init, "model");
}

/** Each engine's CLI version, asked of each engines module once, before the first session. */
async function versionsOf(o: RunCorpusOptions) {
  const ask = async (engines: Engines, sessions: SessionName[]) => {
    const ids = [...new Set(sessions.map((s) => SESSIONS[s].engine))];
    const health = await Promise.all(ids.map((id) => engines.health(id)));
    return new Map(ids.map((id, i) => [id, health[i]?.version ?? null]));
  };
  const [find, confirm] = await Promise.all([ask(o.findEngines, FINDS), ask(o.confirmEngines, CONFIRMS)]);
  return { find, confirm };
}

/** One case's sessions, as the run spends them. */
interface CaseContext {
  caseId: string;
  job: ReviewJob;
  prepared: Prepared;
  diffFile: string;
  rules: PromptRulesFile[];
  switches: RuleSwitch[];
  sessions: Sessions;
}

/** Runs a corpus' sessions, stores each as it ends, and says what it kept. See the module's header. */
export async function runCorpus(o: RunCorpusOptions): Promise<CorpusRun> {
  const cases = casesIn(o.cases, o.only);
  if (inside(o.buildRoot, o.runFolder) || inside(o.runFolder, o.buildRoot))
    return {
      kind: "refused",
      reason: "folders",
      message: `The run folder ${o.runFolder} and the build root ${o.buildRoot} must not hold each other.`,
    };
  const planned = plannedSessions(o).sessions;
  if (planned > o.maxSessions)
    return { kind: "refused", reason: "over_cap", planned, maxSessions: o.maxSessions };
  let lock: { release(): void };
  try {
    lock = o.lock();
  } catch (error) {
    return {
      kind: "refused",
      reason: "locked",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    return await runCases(o, cases, planned > 0 ? await versionsOf(o) : null);
  } finally {
    lock.release();
  }
}

type Versions = Awaited<ReturnType<typeof versionsOf>>;

async function runCases(
  o: RunCorpusOptions,
  cases: EvalCase[],
  versions: Versions | null,
): Promise<CorpusRun> {
  const signal = o.signal ?? new AbortController().signal;
  const timeoutMs = o.timeoutMs ?? TIMEOUT_MS;
  const run: { spent: number; stopped: RunStop | null } = { spent: 0, stopped: null };
  const out: CaseRun[] = [];

  const store = (ctx: CaseContext, record: SessionRecord) => {
    ctx.sessions[record.session] = record;
    writeSession(o.runFolder, ctx.caseId, record);
    o.onSession?.(ctx.caseId, record);
    if (record.outcome !== "no_candidates" && stops(record.outcome) && run.stopped === null)
      run.stopped = { caseId: ctx.caseId, session: record.session, outcome: record.outcome };
  };
  const mayStart = () => run.stopped === null && !signal.aborted;

  /** The record of a session the engine ran, from what it answered and what `review` made of it. */
  const recordOf = (
    ctx: CaseContext,
    session: SessionName,
    kept: { result: EngineRunResult | null; wallMs: number },
    failure: SessionFailure | null,
  ): SessionRecord => {
    const engine = SESSIONS[session].engine;
    const pass = SESSIONS[session].pass;
    const cli: SessionCli = {
      name: engine,
      version: versions?.[pass].get(engine) ?? null,
      model: modelIn(engine, artefactsOf(o.runFolder, ctx.caseId, session)),
    };
    const result = kept.result;
    const answer = {
      session,
      text: result?.text ?? "",
      json: result?.json ?? null,
      usage: result?.usage ?? null,
      wallMs: kept.wallMs,
      cli,
    };
    if (failure === null) return { ...answer, outcome: "ok", failure: null };
    return { ...answer, outcome: result?.outcome ?? "crashed", failure };
  };

  // Each find session of a case stands alone: none is a round's second find.
  const policyOf = (ctx: CaseContext, session: SessionName) => ({
    engine: SESSIONS[session].engine,
    pass: "find" as const,
    round: 1,
    timeoutMs,
    artefactsDir: artefactsOf(o.runFolder, ctx.caseId, session),
    rules: ctx.rules,
  });

  const find = async (ctx: CaseContext, session: SessionName) => {
    if (!mayStart()) return;
    const { port, kept } = recorded(o.findEngines, o.clock);
    run.spent += 1;
    const policy = { ...policyOf(ctx, session), earlier: [], diffFile: ctx.diffFile };
    const review = await createReview({ engines: port, inputLimits: o.inputLimits ?? {} }).run(
      ctx.job,
      ctx.prepared,
      policy,
      signal,
    );
    store(ctx, recordOf(ctx, session, kept, review.kind === "reviewed" ? null : review.reason));
  };

  /** A stored find's round, read back through `review`'s reader; null when it isn't usable. */
  const roundOf = async (ctx: CaseContext, session: SessionName): Promise<RoundOutcome | null> => {
    const record = ctx.sessions[session];
    if (record === undefined || !isRead(record)) return null;
    const policy = { ...policyOf(ctx, session), earlier: [] };
    const read = await createReview({ engines: answering(record) }).run(
      ctx.job,
      ctx.prepared,
      policy,
      signal,
    );
    return read.kind === "reviewed" ? read.round : null;
  };

  const confirm = async (ctx: CaseContext, session: SessionName) => {
    if (!mayStart()) return;
    const rounds = await Promise.all(needs(session).map((f) => roundOf(ctx, f)));
    const passes = rounds.filter((r): r is RoundOutcome => r !== null);
    const [first, ...rest] = passes;
    if (first === undefined || passes.length !== rounds.length) return;
    const merged = rest.length === 0 ? first : mergeFinds([first, ...rest]);
    const asked = toConfirm([], merged.candidates, { round: 1, rules: ctx.switches });
    if (asked.length === 0) return store(ctx, { session, outcome: "no_candidates" });
    const { port, kept } = recorded(o.confirmEngines, o.clock);
    run.spent += 1;
    const answer = await createConfirm({ engines: port, inputLimits: o.inputLimits ?? {} }).run(
      ctx.job,
      ctx.prepared,
      asked,
      policyOf(ctx, session),
      signal,
    );
    store(ctx, recordOf(ctx, session, kept, answer.failure));
  };

  const spend = async (ctx: CaseContext, todo: SessionName[]) => {
    await settled(FINDS.filter((s) => todo.includes(s)).map((s) => find(ctx, s)));
    const confirms = CONFIRMS.filter((s) => todo.includes(s));
    const engines = new Set(confirms.map((s) => SESSIONS[s].engine));
    const lanes = [...engines].map((engine) => confirms.filter((s) => SESSIONS[s].engine === engine));
    await settled(
      lanes.map(async (lane) => {
        for (const s of lane) await confirm(ctx, s);
      }),
    );
  };

  for (const evalCase of cases) {
    if (!mayStart()) break;
    const stored = storedCase(o.runFolder, evalCase, o.review);
    const todo = toRun(stored.sessions, o.only);
    if (todo.length === 0) {
      out.push({ caseId: evalCase.id, inputs: stored.inputs, sessions: stored.sessions });
      continue;
    }
    const prepared = await o.prepare(evalCase, signal);
    try {
      const inputs = checked(o, evalCase, prepared, stored.inputs);
      const ctx: CaseContext = {
        caseId: evalCase.id,
        job: jobOn(inputs.head),
        prepared: { cwd: prepared.cwd, diff: inputs.diff },
        diffFile: prepared.diffFile,
        ...caseRules(inputs),
        sessions: { ...stored.sessions },
      };
      await spend(ctx, todo);
      out.push({ caseId: evalCase.id, inputs, sessions: ctx.sessions });
    } finally {
      await prepared.dispose();
    }
  }
  return { kind: "ran", cases: out, spent: run.spent, stopped: run.stopped };
}

/**
 * A prepared case's inputs, stored the first time: its worktree must be in the build root, its rules must hold the
 * corpus' `REVIEW.md` as it is, and a case already stored must give the same inputs (head, diff and rules), or its
 * stored sessions answered another change.
 */
function checked(
  o: RunCorpusOptions,
  evalCase: EvalCase,
  prepared: PreparedCase,
  stored: CaseInputs | null,
): CaseInputs {
  if (!inside(o.buildRoot, prepared.cwd))
    throw new Error(`${evalCase.id}: its worktree ${prepared.cwd} is outside the build root ${o.buildRoot}.`);
  const inputs: CaseInputs = { head: prepared.head, diff: prepared.diff, rules: prepared.rules };
  // `retrieval` reads the rules on its own and gives none when it can't: a case is never run without the corpus'.
  const review = lf(o.review);
  if (review !== "" && !inputs.rules.some((file) => file.path === "REVIEW.md" && file.text === review))
    throw new Error(
      `${evalCase.id}: its rules came back without the corpus' REVIEW.md, so no session is run: ` +
        "see what retrieval logged of the rules, and run it again.",
    );
  if (stored === null) {
    writeInputs(o.runFolder, evalCase, o.review, inputs);
    return inputs;
  }
  const folder = join(o.runFolder, evalCase.id);
  if (stored.head !== inputs.head || stored.diff !== inputs.diff)
    throw new Error(
      `${evalCase.id}: its stored sessions answered commit ${stored.head}, the case is now ${inputs.head}: ` +
        `remove ${folder} to run it again.`,
    );
  if (!sameRules(stored.rules, inputs.rules))
    throw new Error(
      `${evalCase.id}: its stored sessions were given other rules than the case's prepared now: ` +
        `remove ${folder} to run it again.`,
    );
  return inputs;
}

/** Whether two cases' rules files are the same files: path, text and commit, whatever their order. */
function sameRules(a: readonly RulesFile[], b: readonly RulesFile[]): boolean {
  const key = (files: readonly RulesFile[]) =>
    files.map((f) => JSON.stringify([f.path, f.text, f.commit])).toSorted();
  return JSON.stringify(key(a)) === JSON.stringify(key(b));
}
