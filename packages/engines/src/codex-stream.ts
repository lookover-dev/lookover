// Reading `codex exec --json`: one JSON event per line (codex-cli 0.154.0, the survey of spec #87 and the
// recordings of testkit). Only what decides the outcome is read: the `agent_message` items (the answer is the
// last one: the model may write a preamble first), `turn.completed` (its tokens) and `turn.failed` (its error),
// and the top-level `error` events (a retry's notice, or the last error before `turn.failed`). Everything else is
// kept raw in the run folder for whoever needs it.
import type { EngineRunOutcome, EngineRunResult, EngineUsage, ProcessResult } from "@lookover/contracts";
import { z } from "zod";
import { codexReset, limitLine, limitOf } from "./limit.ts";
import { parseLine } from "./stream.ts";

const message = z.object({
  type: z.literal("item.completed"),
  item: z.object({ type: z.string(), text: z.string().default("") }),
});
const completed = z.object({
  type: z.literal("turn.completed"),
  usage: z
    .object({ input_tokens: z.number().default(0), output_tokens: z.number().default(0) })
    .nullable()
    .default(null),
});
const failed = z.object({
  type: z.literal("turn.failed"),
  error: z.object({ message: z.string().default("") }).default({ message: "" }),
});
const error = z.object({ type: z.literal("error"), message: z.string().default("") });
const event = z.discriminatedUnion("type", [message, completed, failed, error]);

export interface CodexStream {
  /** The last `agent_message`'s text: the answer. Null when the model wrote none. */
  answer: string | null;
  /** Every `turn.completed`: the turn ended, with its tokens. */
  turns: z.infer<typeof completed>[];
  /** The `turn.failed` error's message; null when no turn failed. */
  failure: string | null;
  /** What the top-level `error` events said, in order. */
  errors: string[];
}

// The CLI's own phrases (codex-cli 0.154.0's binary): a 401 from the API, no sign-in, a sign-in that couldn't be
// refreshed. A bare "unauthorized" elsewhere would take a host's refusal for a sign-out.
const NOT_SIGNED_IN =
  /401 Unauthorized|Missing bearer|not logged in|access token could not be refreshed|sign in again/i;
const AT_LIMIT = /usage limit|usage_limit_reached|hit your usage limit|out of credits/i;
/** The CLI's refusal of a prompt over its input limit, before any turn (`input_too_large`, code -32602). */
const INPUT_TOO_LARGE = /Input exceeds the maximum length of [\d,]+ characters\.?/;

/** What the CLI said when it refused the prompt for its length; null when it didn't. */
export function refusedInput(stderr: string): string | null {
  return INPUT_TOO_LARGE.exec(stderr)?.[0] ?? null;
}

export function readCodexStream(stdout: string): CodexStream {
  const stream: CodexStream = { answer: null, turns: [], failure: null, errors: [] };
  for (const line of stdout.split("\n")) {
    const parsed = event.safeParse(parseLine(line));
    if (!parsed.success) continue;
    const e = parsed.data;
    if (e.type === "item.completed") {
      if (e.item.type === "agent_message") stream.answer = e.item.text;
    } else if (e.type === "turn.completed") stream.turns.push(e);
    else if (e.type === "turn.failed") stream.failure = e.error.message;
    else stream.errors.push(e.message);
  }
  return stream;
}

/** How a process that didn't exit on its own ended the run. */
const ENDED = {
  wall_clock: "timeout",
  idle: "timeout",
  killed: "cancelled",
  failed_to_start: "crashed",
} as const satisfies Record<Exclude<ProcessResult["end"], "exited">, EngineRunOutcome>;

/** How a Codex run ended, from how the process ended and what the stream and stderr show. See `index.ts`. */
export function codexOutcomeOf(process: ProcessResult, stream: CodexStream): EngineRunOutcome {
  if (process.end !== "exited") return ENDED[process.end];
  // Every signal counts only when the turn didn't complete: errors the CLI retried past (a reconnect, a
  // transport fallback), followed by `turn.completed`, leave a good answer.
  const done = stream.turns.length > 0 && stream.failure === null;
  const said = saidOnError(process, stream);
  if (!done && NOT_SIGNED_IN.test(said)) return "auth_required";
  if (!done && AT_LIMIT.test(said)) return "quota_exhausted";
  if (stream.failure !== null) return "invalid_output";
  // The prompt was refused for its length: the input was wrong, nothing crashed.
  if (!done && refusedInput(process.stderr) !== null) return "invalid_output";
  if (!done || process.exitCode !== 0) return "crashed";
  return stream.answer === null ? "invalid_output" : "ok";
}

/** What the CLI said of a failure: the failed turn's error, the error events and stderr. */
function saidOnError(process: ProcessResult, stream: CodexStream): string {
  return [stream.failure ?? "", ...stream.errors, process.stderr].join("\n");
}

/**
 * A run at the plan's limit: when it resets, from the "try again at" time in what the CLI said, read at `now`;
 * else the line naming the limit. Nothing for any other outcome.
 */
export function codexLimitOf(
  process: ProcessResult,
  stream: CodexStream,
  outcome: EngineRunOutcome,
  now: number,
): Pick<EngineRunResult, "limitUntil" | "limitSaid"> {
  if (outcome !== "quota_exhausted") return {};
  const said = saidOnError(process, stream);
  return limitOf(outcome, codexReset(said, now), limitLine(said, AT_LIMIT));
}

/** The tokens of every completed turn: input as the API counts it (cached input is part of it), and output. */
export function codexUsageOf(stream: CodexStream): EngineUsage | null {
  const usages = stream.turns.flatMap((t) => (t.usage === null ? [] : [t.usage]));
  if (usages.length === 0) return null;
  return {
    inputTokens: usages.reduce((sum, u) => sum + u.input_tokens, 0),
    outputTokens: usages.reduce((sum, u) => sum + u.output_tokens, 0),
  };
}

const command = z.object({
  type: z.literal("item.completed"),
  item: z.object({
    type: z.literal("command_execution"),
    command: z.string().default(""),
    aggregated_output: z.string().default(""),
    exit_code: z.number().nullable().default(null),
    status: z.string().default(""),
  }),
});

/**
 * How a refused write reads in a command's output: Windows' sandbox (0.154.0: "Access to the path '<path>' is
 * denied."), and the forms a POSIX shell gives under a read-only sandbox.
 */
const REFUSED = /denied|not permitted|read-only file system/i;

/**
 * Whether the stream shows a write to `file` tried and refused by the sandbox: a command naming the file that
 * failed (its status, or a non-zero exit) and whose output says it was refused. A command that only names the
 * file (`Test-Path`, a listing) is no such evidence: the wall wasn't tested.
 */
export function codexWriteRefused(stdout: string, file: string): boolean {
  return stdout.split("\n").some((line) => {
    const parsed = command.safeParse(parseLine(line));
    if (!parsed.success) return false;
    const { item } = parsed.data;
    const failed = item.status === "failed" || (item.exit_code !== null && item.exit_code !== 0);
    return item.command.includes(file) && failed && REFUSED.test(item.aggregated_output);
  });
}

/** The shell commands the model ran, as each completed `command_execution` item names it. */
function codexCommandsOf(stdout: string): string[] {
  return stdout.split("\n").flatMap((line) => {
    const parsed = command.safeParse(parseLine(line));
    return parsed.success ? [parsed.data.item.command] : [];
  });
}

/**
 * What the stream says was denied: each line of a shell command's output that says so. The sandbox's refusal is
 * an ordinary failed command (0.154.0 on Windows: "Access to the path '<path>' is denied.").
 */
export function codexDenialsOf(stdout: string): string[] {
  return stdout.split("\n").flatMap((line) => {
    const parsed = command.safeParse(parseLine(line));
    if (!parsed.success) return [];
    return parsed.data.item.aggregated_output.split(/\r?\n/).filter((l) => /denied/i.test(l));
  });
}

/** Each completed shell command the model ran, with what it showed the model: its output. */
export function codexCallsOf(stdout: string): { call: string; output: string }[] {
  return stdout.split("\n").flatMap((line) => {
    const parsed = command.safeParse(parseLine(line));
    return parsed.success
      ? [{ call: parsed.data.item.command, output: parsed.data.item.aggregated_output }]
      : [];
  });
}

const toolCall = z.object({
  type: z.literal("item.completed"),
  item: z.object({
    type: z.literal("mcp_tool_call"),
    server: z.string().default(""),
    tool: z.string().default(""),
    arguments: z.unknown().optional(),
  }),
});
const fileChange = z.object({
  type: z.literal("item.completed"),
  item: z.object({ type: z.literal("file_change"), changes: z.unknown().optional() }),
});

/**
 * What the model said and did: every `agent_message`'s text, every tool call (`mcp_tool_call`: its server, tool
 * and arguments as JSON, never its result), every `file_change`'s changes as JSON, and every shell command it ran
 * (never its output).
 */
export function codexSaidOf(stdout: string): string[] {
  const done = stdout.split("\n").flatMap((line) => {
    const json = parseLine(line);
    const said = message.safeParse(json);
    if (said.success && said.data.item.type === "agent_message") return [said.data.item.text];
    const call = toolCall.safeParse(json);
    if (call.success) {
      const { server, tool, arguments: args } = call.data.item;
      return [JSON.stringify({ server, tool, arguments: args ?? null })];
    }
    const change = fileChange.safeParse(json);
    return change.success ? [JSON.stringify(change.data.item.changes ?? null)] : [];
  });
  return [...done, ...codexCommandsOf(stdout)];
}
