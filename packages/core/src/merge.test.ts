// Merging a Deep round's two find passes (ADR 0044, I-159): one outcome, each bug once whatever each pass named
// it, the earlier findings' verdicts merged conservatively, each pass's session kept apart and the notes joined. Expected values
// are written by hand from the record, never recomputed the way the code does it.
import { expect, test } from "bun:test";
import {
  type CandidateFinding,
  commitSha,
  type EarlierVerdict,
  type EngineId,
  findingId,
  type RoundOutcome,
} from "@lookover/contracts";
import { mergeFinds } from "./index.ts";

const SHA = commitSha("a".repeat(40));

/**
 * A candidate on `line` of `src/app.ts`: `key` is the pass's kind key (the meaning), `text` the line's text as
 * copied (the location hashes the category and it; null when not copied, the location then hashing the line).
 */
function candidate(
  key: string,
  line: number,
  text: string | null,
  foundBy: EngineId = "claude",
  category = "correctness",
): CandidateFinding {
  return {
    severity: "should_fix",
    category,
    title: `Title of ${key}`,
    body: `Body of ${key}`,
    location: { path: "src/app.ts", side: "head", line, endLine: null },
    lineText: text,
    anchoring: "reported",
    foundBy,
    defectKey: key,
    suggestion: null,
    preExisting: false,
    rule: null,
    fingerprints: {
      location: `${category}|src/app.ts|head|${text ?? line}`,
      meaning: `${category}|src/app.ts|${key}`,
    },
  };
}

function outcome(engine: EngineId, more: Partial<RoundOutcome> = {}): RoundOutcome {
  return {
    sha: SHA,
    engine,
    notes: "",
    candidates: [],
    earlier: [],
    emptyReason: null,
    problems: [],
    sessions: [],
    ...more,
  };
}

const verdict = (id: string, v: EarlierVerdict["verdict"], why = ""): EarlierVerdict => ({
  id: findingId(id),
  verdict: v,
  why,
});

test("two passes naming one bug differently merge into one finding: the first pass's", () => {
  const claude = candidate("null_deref", 12, "return user.name;");
  const codex = candidate("missing_null_check", 12, "return user.name;", "codex");
  const merged = mergeFinds([
    outcome("claude", { candidates: [claude] }),
    outcome("codex", { candidates: [codex] }),
  ]);
  expect(merged.candidates).toEqual([claude]);
});

test("the same category on the same line is one finding without the line's text too", () => {
  const first = candidate("null_deref", 12, null);
  const second = candidate("missing_null_check", 12, null, "codex");
  const otherCategory = candidate("slow_lookup", 12, null, "codex", "performance");
  const merged = mergeFinds([
    outcome("claude", { candidates: [first] }),
    outcome("codex", { candidates: [second, otherCategory] }),
  ]);
  expect(merged.candidates).toEqual([first, otherCategory]);
});

test("the same category on the same line is one finding when only one pass copied the line's text", () => {
  const withText = candidate("null_deref", 12, "return user.name;");
  const without = candidate("missing_null_check", 12, null, "codex");
  const nextLine = candidate("unchecked_index", 13, null, "codex");
  const merged = mergeFinds([
    outcome("claude", { candidates: [withText] }),
    outcome("codex", { candidates: [without, nextLine] }),
  ]);
  expect(merged.candidates).toEqual([withText, nextLine]);
});

test("two bugs of the same kind stay two, and a bug found by one pass only is kept", () => {
  const a = candidate("sql_injection", 10, 'db.query("SELECT " + id);');
  const b = candidate("sql_injection", 20, 'db.query("DELETE " + id);', "codex");
  const onlyCodex = candidate("eval_use", 30, "return eval(code);", "codex");
  const merged = mergeFinds([
    outcome("claude", { candidates: [a] }),
    outcome("codex", { candidates: [b, onlyCodex] }),
  ]);
  expect(merged.candidates).toEqual([a, b, onlyCodex]);
});

test("earlier verdicts merge conservatively: any present wins, gone only when no pass says present", () => {
  const merged = mergeFinds([
    outcome("claude", {
      earlier: [
        verdict("F1", "gone", "fixed"),
        verdict("F2", "present", "still there"),
        verdict("F3", "unknown"),
        verdict("F4", "unknown"),
      ],
    }),
    outcome("codex", {
      earlier: [
        verdict("F1", "present", "the null check is missing on line 9"),
        verdict("F2", "gone", "removed"),
        verdict("F3", "gone", "removed with the loop"),
        verdict("F4", "unknown"),
      ],
    }),
  ]);
  expect(merged.earlier).toEqual([
    verdict("F1", "present", "the null check is missing on line 9"),
    verdict("F2", "present", "still there"),
    verdict("F3", "gone", "removed with the loop"),
    verdict("F4", "unknown"),
  ]);
});

test("`wrong` merges after present and gone, before unknown, from either pass (ADR 0052)", () => {
  const merged = mergeFinds([
    outcome("claude", {
      earlier: [
        verdict("F1", "present", "line 9 still reads it"),
        verdict("F2", "wrong", "the client sets a timeout"),
        verdict("F3", "gone", "removed"),
        verdict("F4", "unknown"),
        verdict("F5", "wrong", "intended"),
        verdict("F6", "wrong", "the caller checks it"),
      ],
    }),
    outcome("codex", {
      earlier: [
        verdict("F1", "wrong", "the caller checks it"),
        verdict("F2", "gone", "removed with the client"),
        verdict("F3", "wrong", "the header is needed"),
        verdict("F4", "wrong", "a test covers it"),
        verdict("F5", "unknown"),
        verdict("F6", "present", "line 3 still reads it"),
      ],
    }),
  ]);
  expect(merged.earlier).toEqual([
    verdict("F1", "present", "line 9 still reads it"),
    // Code now gone is verified fixed, disputed or not.
    verdict("F2", "gone", "removed with the client"),
    verdict("F3", "gone", "removed"),
    verdict("F4", "wrong", "a test covers it"),
    verdict("F5", "wrong", "intended"),
    verdict("F6", "present", "line 3 still reads it"),
  ]);
});

test("the merged outcome is the first pass's commit and engine, each pass's session apart, its notes and problems joined", () => {
  const merged = mergeFinds([
    outcome("claude", {
      notes: "Claude's notes.",
      problems: ["finding 3: no title"],
      sessions: [
        { pass: "find", engine: "claude", ms: 41_000, usage: { inputTokens: 1000, outputTokens: 200 } },
      ],
      emptyReason: "Nothing stood out.",
    }),
    outcome("codex", {
      notes: "Codex's notes.",
      candidates: [candidate("eval_use", 30, "return eval(code);", "codex")],
      sessions: [
        { pass: "find-2", engine: "codex", ms: 63_000, usage: { inputTokens: 3000, outputTokens: 50 } },
      ],
    }),
  ]);
  expect({ ...merged, candidates: merged.candidates.length }).toEqual({
    sha: SHA,
    engine: "claude",
    notes: "Claude's notes.\n\nCodex's notes.",
    candidates: 1,
    earlier: [],
    // A pass found something: nobody found nothing.
    emptyReason: null,
    problems: ["finding 3: no title"],
    // Not summed (ADR 0055): the round shows what each session used.
    sessions: [
      { pass: "find", engine: "claude", ms: 41_000, usage: { inputTokens: 1000, outputTokens: 200 } },
      { pass: "find-2", engine: "codex", ms: 63_000, usage: { inputTokens: 3000, outputTokens: 50 } },
    ],
  });
});

test("two passes that found nothing keep why; a session whose CLI said no tokens stays without them", () => {
  const merged = mergeFinds([
    outcome("claude", {
      emptyReason: "Nothing stood out.",
      sessions: [{ pass: "find", engine: "claude", ms: 9_000, usage: { inputTokens: 10, outputTokens: 1 } }],
    }),
    outcome("claude", {
      emptyReason: "Only a rename.",
      sessions: [{ pass: "find-2", engine: "claude", ms: 7_000, usage: null }],
    }),
  ]);
  expect([merged.emptyReason, merged.sessions]).toEqual([
    "Nothing stood out.\n\nOnly a rename.",
    [
      { pass: "find", engine: "claude", ms: 9_000, usage: { inputTokens: 10, outputTokens: 1 } },
      { pass: "find-2", engine: "claude", ms: 7_000, usage: null },
    ],
  ]);
});
