// Reading `claude -p --output-format stream-json`: one JSON event per line. Only what decides the outcome is
// read (the `result` event, an `assistant` event's error, a rate-limit event's status); everything else in
// the stream is kept raw in the run folder for whoever needs it. Shapes seen on claude 2.1.283 (exploration 02
// and the recordings of testkit).
import type { EngineRunOutcome, EngineRunResult, EngineUsage, ProcessResult } from "@lookover/contracts";
import { z } from "zod";
import { claudeReset, limitLine, limitOf } from "./limit.ts";

const resultEvent = z.object({
  type: z.literal("result"),
  is_error: z.boolean().default(false),
  /** The answer. Null when the program ended on an error before answering. */
  result: z.string().nullable().default(null),
  /** A structured-output run's value, validated by the program against the schema it was given. */
  structured_output: z.unknown().optional(),
  usage: z
    .object({
      input_tokens: z.number().default(0),
      output_tokens: z.number().default(0),
      cache_creation_input_tokens: z.number().default(0),
      cache_read_input_tokens: z.number().default(0),
    })
    .nullable()
    .default(null),
});
const assistantEvent = z.object({ type: z.literal("assistant"), error: z.string().nullable().default(null) });
const rateLimitEvent = z.object({
  type: z.literal("rate_limit_event"),
  rate_limit_info: z
    .object({
      status: z.string().default("allowed"),
      resetsAt: z.number().nullable().catch(null).default(null),
    })
    .default({ status: "allowed", resetsAt: null }),
});
const event = z.discriminatedUnion("type", [resultEvent, assistantEvent, rateLimitEvent]);

export interface Stream {
  result: z.infer<typeof resultEvent> | null;
  /** The program said it is not signed in. */
  signedOut: boolean;
  /** A rate-limit event rejected the run. */
  rejected: boolean;
  /** When the limit that rejected it resets, as its event said (seconds since the epoch); null when none said. */
  resetsAt: number | null;
}

/** One line of a JSON-lines stream (Claude's, Codex's) as JSON, or null for a line that is none. */
export function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// The CLI's own phrases only: a bare "authentication" would take an API outage for a sign-out. A sign-in that
// couldn't be refreshed ("Failed to refresh OAuth token", another Claude process refreshing it) is one too: its
// event's error is `server_error`, so only the text tells.
const NOT_SIGNED_IN = /not logged in|please run \/login|invalid api key|oauth token/i;
const AT_LIMIT = /usage limit|hit your limit|limit reached|rate limit/i;

export function readStream(stdout: string): Stream {
  const stream: Stream = { result: null, signedOut: false, rejected: false, resetsAt: null };
  for (const line of stdout.split("\n")) {
    const parsed = event.safeParse(parseLine(line));
    if (!parsed.success) continue;
    const e = parsed.data;
    if (e.type === "result") stream.result = e;
    else if (e.type === "assistant") stream.signedOut ||= e.error === "authentication_failed";
    else if (e.rate_limit_info.status === "rejected") {
      stream.rejected = true;
      stream.resetsAt = e.rate_limit_info.resetsAt ?? stream.resetsAt;
    }
  }
  return stream;
}

/**
 * A run at the plan's limit: when it resets, from the rejecting event's `resetsAt`, believed at `now`; else the line
 * of the result or stderr naming the limit. Nothing for any other outcome.
 */
export function claudeLimitOf(
  process: ProcessResult,
  stream: Stream,
  outcome: EngineRunOutcome,
  now: number,
): Pick<EngineRunResult, "limitUntil" | "limitSaid"> {
  if (outcome !== "quota_exhausted") return {};
  const said = limitLine(`${stream.result?.result ?? ""}\n${process.stderr}`, AT_LIMIT);
  return limitOf(outcome, claudeReset(stream.resetsAt, now), said);
}

/** How the run ended, from how the process ended and what the stream and stderr show. See `index.ts`. */
export function outcomeOf(process: ProcessResult, stream: Stream): EngineRunOutcome {
  if (process.end === "wall_clock" || process.end === "idle") return "timeout";
  if (process.end === "killed") return "cancelled";
  if (process.end === "failed_to_start") return "crashed";
  const { result } = stream;
  // Every signal counts only when the run failed: a rejection or a sign-in error the CLI recovered from, followed
  // by a result without the error flag, is a good answer.
  const failed = result === null || result.is_error;
  const said = `${result?.result ?? ""}\n${process.stderr}`;
  if (failed && (stream.signedOut || NOT_SIGNED_IN.test(said))) return "auth_required";
  if (failed && (stream.rejected || AT_LIMIT.test(said))) return "quota_exhausted";
  if (result === null) return "crashed";
  if (result.is_error) return "invalid_output";
  return process.exitCode === 0 ? "ok" : "crashed";
}

export function usageOf(stream: Stream): EngineUsage | null {
  const usage = stream.result?.usage ?? null;
  if (usage === null) return null;
  return {
    inputTokens: usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens,
    outputTokens: usage.output_tokens,
  };
}

/**
 * The value a structured-output run returned (`--json-schema`: the program validated it against the schema), or
 * null for any other run. The answer's text is never searched for JSON: reading it is `review`'s (ADR 0028).
 */
export function structuredOf(stream: Stream): { value: unknown } | null {
  const value = stream.result?.structured_output;
  return value === undefined || value === null ? null : { value };
}

const denialEvent = z.object({
  type: z.literal("system"),
  subtype: z.literal("permission_denied"),
  message: z.string().default(""),
});

/**
 * What the stream says was denied: each `permission_denied` event's message, which names the path (2.1.283:
 * "<path> is outside <folder>; --restricted confines the file tools to the working directory.").
 */
export function denialsOf(stdout: string): string[] {
  return stdout.split("\n").flatMap((line) => {
    const parsed = denialEvent.safeParse(parseLine(line));
    return parsed.success ? [parsed.data.message] : [];
  });
}

const said = z.object({
  type: z.literal("assistant"),
  message: z.object({
    content: z
      .array(z.object({ type: z.string(), text: z.string().optional(), input: z.unknown().optional() }))
      .default([]),
  }),
});

/**
 * What the model said and did: each `assistant` event's text and tool calls (their input as JSON), and the
 * `result` event's answer and structured output (as JSON).
 */
export function saidOf(stdout: string): string[] {
  return stdout.split("\n").flatMap((line) => {
    const json = parseLine(line);
    const answer = resultEvent.safeParse(json);
    if (answer.success) {
      const { result, structured_output } = answer.data;
      return [
        ...(result === null ? [] : [result]),
        ...(structured_output === undefined ? [] : [JSON.stringify(structured_output)]),
      ];
    }
    const parsed = said.safeParse(json);
    if (!parsed.success) return [];
    return parsed.data.message.content.flatMap((block) => {
      if (block.type === "text") return [block.text ?? ""];
      return block.type === "tool_use" ? [JSON.stringify(block.input ?? null)] : [];
    });
  });
}

const toolUses = z.object({
  type: z.literal("assistant"),
  message: z.object({
    content: z.array(z.object({ type: z.string(), id: z.string().optional(), input: z.unknown() })).catch([]),
  }),
});
const toolResults = z.object({
  type: z.literal("user"),
  message: z.object({
    content: z
      .array(
        z.object({
          type: z.string(),
          tool_use_id: z.string().optional(),
          content: z.union([z.string(), z.array(z.object({ text: z.string().default("") }))]).optional(),
        }),
      )
      .catch([]),
  }),
});

/**
 * Each tool call the model made (its input as JSON) with what it showed the model (its `tool_result`'s text, empty
 * when none came). An instruction file the program loads itself shows nowhere in them (2.1.283: a subfolder's
 * CLAUDE.md, loaded with a file read there, is not in that read's result).
 */
export function callsOf(stdout: string): { call: string; output: string }[] {
  const lines = stdout.split("\n").map(parseLine);
  const outputs = new Map<string, string[]>();
  for (const block of lines.flatMap((line) => toolResults.safeParse(line).data?.message.content ?? [])) {
    if (block.type !== "tool_result" || block.tool_use_id === undefined || block.content === undefined)
      continue;
    const text = typeof block.content === "string" ? [block.content] : block.content.map((c) => c.text);
    outputs.set(block.tool_use_id, [...(outputs.get(block.tool_use_id) ?? []), ...text]);
  }
  return lines
    .flatMap((line) => toolUses.safeParse(line).data?.message.content ?? [])
    .filter((block) => block.type === "tool_use")
    .map((block) => ({
      call: JSON.stringify(block.input ?? null),
      output: (outputs.get(block.id ?? "") ?? []).join("\n"),
    }));
}

const named = z.union([z.string(), z.object({ name: z.string(), source: z.string().default("") })]);
type Named = z.infer<typeof named>;
const initEvent = z.object({
  type: z.literal("system"),
  subtype: z.literal("init"),
  agents: z.array(named).default([]),
  skills: z.array(named).default([]),
  slash_commands: z.array(named).default([]),
  mcp_servers: z.array(named).default([]),
  plugins: z.array(named).default([]),
});
const nameOf = (x: Named) => (typeof x === "string" ? x : x.name);
const sourceOf = (x: Named) => (typeof x === "string" ? "" : x.source);

/**
 * The customisations the init line says were loaded that a run must not have (I-080), by name: every skill and
 * slash command, the user's own included (#235: `--safe-mode` and `--disable-slash-commands` list none); an agent
 * or tool server named `planted` (the bait's) or from the project or its local settings (its `source`, when the
 * line gives one); a plugin that isn't built in. The built-in agents and plugins are the program's own; a user's
 * own agent carries no source and the built-in list varies by version, so it isn't caught here (ADR 0056).
 */
export function customisedOf(stdout: string, planted: string): string[] {
  const init = stdout
    .split("\n")
    .map((line) => initEvent.safeParse(parseLine(line)))
    .find((parsed) => parsed.success)?.data;
  if (init === undefined) return [];
  const listed = [...init.agents, ...init.mcp_servers];
  return [
    ...init.skills,
    ...init.slash_commands,
    ...listed.filter((x) => nameOf(x) === planted || /^(project|local)$/.test(sourceOf(x))),
    ...init.plugins.filter((x) => !sourceOf(x).endsWith("@builtin")),
  ].map(nameOf);
}

/** A `--restricted` denial's message (2.1.283): the path it refused, and the working folder it is outside. */
const OUTSIDE_OF = /^(.+?) is outside (.+?); --restricted/;

/**
 * Whether a denial is the wall refusing the folder that holds the working folder, or one above it (#129: a listing
 * of the self-test's own folder): the wall at work on a path no review reads.
 */
export function deniesAbove(denial: string): boolean {
  const match = OUTSIDE_OF.exec(denial);
  if (match === null) return false;
  const trim = (path: string) => path.replace(/[\\/]+$/, "");
  const path = trim(match[1] ?? "");
  const folder = trim(match[2] ?? "");
  return path !== "" && folder.startsWith(path) && /^[\\/]/.test(folder.slice(path.length));
}
