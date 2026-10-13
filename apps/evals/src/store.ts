// The run folder (ADR 0050): each case's inputs, written once, and each session's record, written the moment it
// ends, as JSON files a rerun reads back to never pay twice. Layout: `<run folder>/<case id>/inputs.json` (the
// `CaseInputs`), `<run folder>/<case id>/<session>.json` (a `SessionRecord`), and the engines' raw run folders
// under `<run folder>/<case id>/runs/<session>/`. `inputs.json` also holds the hash of the case it was run for, so an
// edited case never passes its old answers for current. A file is written whole or not at all (a temporary file
// renamed); one that is there but can't be read back, or doesn't say what its name says, is refused loudly, naming it:
// never taken for absent and paid for again.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CommitSha,
  commitSha,
  type EngineId,
  type EngineRunOutcome,
  enumOf,
  RULES_FILES,
  type RulesFileName,
} from "@lookover/contracts";
import { z } from "zod";
import { lf } from "./cases.ts";
import {
  type CaseInputs,
  type EvalCase,
  SESSIONS,
  type SessionFailure,
  type SessionName,
  type SessionRecord,
} from "./types.ts";

const sha = z.string().transform((value): CommitSha => commitSha(value));
const sessionName = enumOf<SessionName>()([
  "claude-find",
  "codex-find",
  "claude-confirms-claude",
  "codex-confirms-claude",
  "codex-confirms-both",
]);
const engine = enumOf<EngineId>()(["claude", "codex"]);
const outcome = enumOf<EngineRunOutcome>()([
  "ok",
  "invalid_output",
  "auth_required",
  "quota_exhausted",
  "timeout",
  "crashed",
  "cancelled",
]);
const failure = enumOf<SessionFailure>()([
  "invalid_output",
  "auth_required",
  "quota_exhausted",
  "timeout",
  "crashed",
  "cancelled",
  "missing_block",
  "malformed_block",
  "invalid_block",
  "unreadable",
]);
const rulesFileName = enumOf<RulesFileName>()(RULES_FILES);

const run = {
  session: sessionName,
  text: z.string(),
  json: z.object({ value: z.unknown() }).nullable(),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).nullable(),
  wallMs: z.number(),
  cli: z.object({ name: engine, version: z.string().nullable(), model: z.string().nullable() }),
};

const sessionRecord = z.union([
  z.object({ session: sessionName, outcome: z.literal("no_candidates") }),
  z.object({ ...run, outcome: z.literal("ok"), failure: z.null() }),
  z.object({ ...run, outcome, failure }),
]);

const caseInputs = z.object({
  caseHash: z.string(),
  head: sha,
  diff: z.string(),
  rules: z.array(z.object({ path: rulesFileName, text: z.string(), commit: sha })),
});

/** A case's folder in the run folder. */
const caseFolder = (runFolder: string, caseId: string): string => join(runFolder, caseId);

/** Where the engine keeps a session's raw run (its prompt, its output, `run.json`). */
export const artefactsOf = (runFolder: string, caseId: string, session: SessionName): string =>
  join(caseFolder(runFolder, caseId), "runs", session);

/** The file's JSON read through `schema`; null when it is absent. Throws, naming the file, when it can't be read. */
function readJson<T>(file: string, schema: z.ZodType<T>): T | null {
  if (!existsSync(file)) return null;
  let parsed: z.ZodSafeParseResult<T>;
  try {
    parsed = schema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    throw new Error(`${file} can't be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed.success)
    throw new Error(`${file} isn't what the runner stores: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** Writes `value` as JSON, whole or not at all: to a temporary file first, then renamed over the old one. */
function writeJson(file: string, value: unknown): void {
  const temporary = `${file}.writing`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, file);
}

/**
 * The hash of a case as it is now, with the corpus' `REVIEW.md` its commits carry (LF, as the builder writes it):
 * the whole input that fixes the case's commits, so any edit to either (the case's files, its planted bug, its
 * summary, the shared rules) changes it.
 */
export function caseHash(evalCase: EvalCase, review: string): string {
  const input = JSON.stringify({ case: evalCase, review: lf(review) });
  return createHash("sha256").update(input).digest("hex");
}

/** What the run folder holds of one case: its inputs and the hash of the case they were for, and each session. */
export interface StoredCase {
  inputs: CaseInputs | null;
  caseHash: string | null;
  sessions: Partial<Record<SessionName, SessionRecord>>;
}

/**
 * Reads one case's stored inputs and sessions; a file not there is absent. Throws, naming the file, for one that
 * can't be read, holds another session than its name, or names a CLI other than its session's engine.
 */
export function readCase(runFolder: string, caseId: string): StoredCase {
  const folder = caseFolder(runFolder, caseId);
  const sessions: Partial<Record<SessionName, SessionRecord>> = {};
  for (const name of sessionName.options) {
    const file = join(folder, `${name}.json`);
    const record = readJson(file, sessionRecord);
    if (record === null) continue;
    if (record.session !== name) throw new Error(`${file} holds the session ${record.session}.`);
    const engine = SESSIONS[name].engine;
    if (record.outcome !== "no_candidates" && record.cli.name !== engine)
      throw new Error(`${file} ran on ${record.cli.name}, but ${name} runs on ${engine}.`);
    sessions[name] = record;
  }
  const stored = readJson(join(folder, "inputs.json"), caseInputs);
  if (stored === null) return { inputs: null, caseHash: null, sessions };
  const { caseHash: hash, ...inputs } = stored;
  return { inputs, caseHash: hash, sessions };
}

/** Stores a case's inputs, what its sessions saw, with the hash of the case and the rules they are for. */
export function writeInputs(runFolder: string, evalCase: EvalCase, review: string, inputs: CaseInputs): void {
  const folder = caseFolder(runFolder, evalCase.id);
  mkdirSync(folder, { recursive: true });
  const stored = {
    caseHash: caseHash(evalCase, review),
    head: inputs.head,
    diff: inputs.diff,
    rules: inputs.rules,
  };
  writeJson(join(folder, "inputs.json"), stored);
}

/** Stores one session's record, the moment it ends. */
export function writeSession(runFolder: string, caseId: string, record: SessionRecord): void {
  const folder = caseFolder(runFolder, caseId);
  mkdirSync(folder, { recursive: true });
  writeJson(join(folder, `${record.session}.json`), record);
}
