// Reading the engine's answer: free notes, then one fenced block, the last thing it wrote. This is the only
// reader of the answer's text (ADR 0028): the engine gives it raw. The fences are tokenised line by line (a
// regex is wrong as soon as the notes hold a tagged fence): the last fence tagged `json` or untagged is the
// block; with no fence, an answer that is JSON alone is the block, with no notes. When the text holds no block,
// or its block is not JSON, a structured-output run's JSON (the port's `json`) stands in. The block is
// validated with Zod where it enters, per finding and per verdict: one bad item is set aside as a problem line
// and the rest is kept; only a block that is no block at all fails the run.
import {
  type CitedRule,
  type DiffSide,
  type EarlierVerdict,
  type EngineRunResult,
  enumOf,
  findingId,
  type PromptRulesFile,
  type Severity,
} from "@lookover/contracts";
import { z } from "zod";
import type { EarlierFinding } from "./types.ts";

const line = z.int().min(1);

/** One finding as the engine reports it: a file and a line on one side of the diff, and what is wrong there. */
const finding = z
  .object({
    path: z.string().trim().min(1),
    side: enumOf<DiffSide>()(["head", "base"]).default("head"),
    line,
    end_line: line.nullable().default(null),
    // The anchored line's text, copied: optional, so an answer without it still reads.
    line_text: z.string().nullable().default(null),
    severity: enumOf<Severity>()(["blocking", "should_fix", "consider"]),
    category: z.string().trim().min(1),
    title: z.string().trim().min(1).max(120),
    body: z.string().trim().min(1),
    defect_key: z.string().trim().min(1),
    suggestion: z.string().nullable().default(null),
    pre_existing: z.boolean().default(false),
    // The label of the repository's rule it follows (`R1`), read by the review against the rules the prompt gave:
    // anything else drops the citation, never the finding (ADR 0048).
    rule: z.unknown().optional(),
  })
  .refine((f) => f.end_line === null || f.end_line >= f.line, {
    path: ["end_line"],
    message: "ends before its line",
  });

// `wrong`: the finder's answer to a dispute, that the finding was a mistake (ADR 0052); read only on a finding whose
// claim is a dispute, the one the prompt offers it to.
const verdict = z.object({
  id: z.string().min(1),
  present: z.boolean(),
  wrong: z.boolean().default(false),
  why: z.string().default(""),
});

/** The block itself: its lists, each item read on its own. */
const block = z.object({
  findings: z.array(z.unknown()).default([]),
  earlier: z.array(z.unknown()).default([]),
  empty_reason: z.string().nullable().default(null),
});

/** A finding as read, its `rule` the repository's rule its label names among those the prompt gave, or null. */
export type AnswerFinding = Omit<z.infer<typeof finding>, "rule"> & { rule: CitedRule | null };

export type ReadAnswer =
  | {
      ok: true;
      notes: string;
      findings: AnswerFinding[];
      earlier: EarlierVerdict[];
      emptyReason: string | null;
      problems: string[];
    }
  | { ok: false; reason: "missing_block" | "malformed_block" | "invalid_block"; problems: string[] };

interface Fence {
  tag: string;
  body: string;
  /** Where the opening line starts in the text: the notes end there. */
  at: number;
}

/** Every fenced block, in order. A fence left open at the end counts, with what follows it as its body. */
function fences(text: string): Fence[] {
  const found: Fence[] = [];
  let open: { tag: string; at: number; lines: string[] } | null = null;
  let at = 0;
  for (const raw of text.split("\n")) {
    const trimmed = raw.replace(/\r$/, "").trim();
    if (open && trimmed === "```") {
      found.push({ tag: open.tag, body: open.lines.join("\n"), at: open.at });
      open = null;
    } else if (open) open.lines.push(raw.replace(/\r$/, ""));
    else if (trimmed.startsWith("```")) open = { tag: trimmed.slice(3).trim().toLowerCase(), at, lines: [] };
    at += raw.length + 1;
  }
  if (open) found.push({ tag: open.tag, body: open.lines.join("\n"), at: open.at });
  return found;
}

export const issues = (error: z.ZodError, prefix: string) =>
  error.issues.map((i) => `${[prefix, ...i.path].filter((p) => p !== "").join(".")}: ${i.message}`);

/** The text as JSON, or undefined when it is none. */
function jsonOf(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

/**
 * The JSON value the answer ends with: the last `json` or untagged fence; with none, the whole text when it is
 * JSON; else a structured-output run's.
 */
export function answerValue(result: Pick<EngineRunResult, "text" | "json">) {
  const fence = fences(result.text)
    .filter((f) => f.tag === "json" || f.tag === "")
    .at(-1);
  const notes = (fence ? result.text.slice(0, fence.at) : result.text).trim();
  if (fence) {
    try {
      return { ok: true as const, notes, value: JSON.parse(fence.body) };
    } catch (error) {
      if (!result.json) {
        const problem = error instanceof Error ? error.message : String(error);
        return { ok: false as const, reason: "malformed_block" as const, problems: [problem] };
      }
    }
  } else {
    const whole = jsonOf(notes);
    if (whole) return { ok: true as const, notes: "", value: whole.value };
  }
  if (result.json) return { ok: true as const, notes, value: result.json.value };
  return { ok: false as const, reason: "missing_block" as const, problems: [] };
}

/**
 * What one verdict says of `finding`: `wrong` on a disputed finding; on any other `wrong` is not read, its `present`
 * stands, and it is a problem.
 */
function said(
  finding: EarlierFinding,
  { present, wrong }: z.infer<typeof verdict>,
  problems: string[],
): EarlierVerdict["verdict"] {
  const disputed = finding.claim?.kind === "disputed";
  if (wrong && disputed) return "wrong";
  if (wrong) problems.push(`earlier: ${finding.id} answered wrong, but nobody disputed it`);
  return present ? "present" : "gone";
}

/** Each verdict on its own; an id never asked about is the one thing that fails the whole block. */
function readVerdicts(items: unknown[], asked: readonly EarlierFinding[], problems: string[]) {
  const wanted = new Map<string, EarlierFinding>(asked.map((f) => [f.id, f]));
  const earlier: EarlierVerdict[] = [];
  const unknownIds: string[] = [];
  items.forEach((item, i) => {
    const parsed = verdict.safeParse(item);
    if (!parsed.success) {
      problems.push(...issues(parsed.error, `earlier.${i}`));
      return;
    }
    const { id, why } = parsed.data;
    const finding = wanted.get(id);
    if (finding === undefined) unknownIds.push(id);
    else if (earlier.some((v) => v.id === id)) problems.push(`earlier: ${id} answered twice`);
    else earlier.push({ id: findingId(id), verdict: said(finding, parsed.data, problems), why });
  });
  for (const { id } of asked.filter((f) => !earlier.some((v) => v.id === f.id))) {
    problems.push(`earlier: no verdict on ${id}`);
    earlier.push({ id: findingId(id), verdict: "unknown", why: "" });
  }
  return { earlier, unknownIds };
}

/**
 * The rule a finding's label names among `rules`, the ones the prompt gave (ADR 0048). No label cites none; a label
 * not given cites none too, and is named in `problems`: the citation goes, never the finding.
 */
function citation(
  label: unknown,
  rules: PromptRulesFile[],
  at: string,
  problems: string[],
): CitedRule | null {
  if (label === null || label === undefined) return null;
  const wanted = typeof label === "string" ? label.trim().toUpperCase() : label;
  const rule = rules.flatMap((f) => f.rules).find((r) => r.label === wanted);
  if (rule === undefined) {
    const named = typeof label === "string" ? label : JSON.stringify(label);
    problems.push(`${at}.rule: ${named} is not one of the rules given`);
    return null;
  }
  return { id: rule.id, file: rule.file, line: rule.line };
}

/**
 * Reads the engine's answer; `asked` are the earlier findings the prompt asked a verdict on, with their claims,
 * `rules` the repository's rules it gave, which a finding cites by label.
 */
export function readAnswer(
  result: Pick<EngineRunResult, "text" | "json">,
  asked: readonly EarlierFinding[],
  rules: PromptRulesFile[],
): ReadAnswer {
  const value = answerValue(result);
  if (!value.ok) return value;
  const parsed = block.safeParse(value.value);
  if (!parsed.success) return { ok: false, reason: "invalid_block", problems: issues(parsed.error, "") };
  const problems: string[] = [];
  const findings: AnswerFinding[] = [];
  parsed.data.findings.forEach((item, i) => {
    const one = finding.safeParse(item);
    if (one.success)
      findings.push({ ...one.data, rule: citation(one.data.rule, rules, `findings.${i}`, problems) });
    else problems.push(...issues(one.error, `findings.${i}`));
  });
  const { earlier, unknownIds } = readVerdicts(parsed.data.earlier, asked, problems);
  if (unknownIds.length > 0) {
    return {
      ok: false,
      reason: "invalid_block",
      problems: unknownIds.map((id) => `earlier: ${id} was not asked about`),
    };
  }
  return { ok: true, notes: value.notes, findings, earlier, emptyReason: parsed.data.empty_reason, problems };
}
