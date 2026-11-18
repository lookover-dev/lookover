// What `lookover` was asked, read from its arguments: `wait [--pr N] [--timeout 30m] [--appear-timeout 3m]
// [--json]`, `feedback [--pr N] [--json]`, `reply <finding> <claim> <text> [--pr N]`, `settle <finding>
// <accepted|wrong> --confirmed-by-owner <reason> [--pr N] [--timeout 3m]`, or `help`. A flag takes its value as the
// next argument or after `=`. No flag names the App: there is one, the shared App (ADR 0073).
import {
  type ClaimKind,
  FINDING_PATTERN,
  OWNER_DECISION,
  type OwnerDecision,
  oneLineReason,
  REASON_MAX,
} from "@lookover/contracts";

export interface WaitArgs {
  /** The pull request's number, or null to find the current branch's. */
  pr: number | null;
  timeoutMs: number;
  appearMs: number;
  json: boolean;
}

export interface FeedbackArgs {
  pr: number | null;
  json: boolean;
}

/**
 * Each claim `lookover reply` makes: the word it takes for it, and what opens the reply's first line, in the grammar
 * Lookover reads.
 */
export const CLAIMS = {
  claimed_fixed: { word: "fixed", opening: "Fixed" },
  wont_fix: { word: "wont-fix", opening: "Won't fix" },
  disputed: { word: "disputed", opening: "Disputed" },
  deferred: { word: "deferred", opening: "Deferred" },
  question: { word: "question", opening: "Question" },
} as const satisfies Record<ClaimKind, { word: string; opening: string }>;

export interface ReplyArgs {
  pr: number | null;
  /** The finding's id, `F3`. */
  finding: string;
  claim: ClaimKind;
  text: string;
}

export interface SettleArgs {
  pr: number | null;
  /** The finding's id, `F3`. */
  finding: string;
  decision: OwnerDecision;
  /** The person's reason, on one line: at most `REASON_MAX` characters. */
  reason: string;
  /** How long it waits for Lookover's answer on its comment. */
  timeoutMs: number;
}

export type Asked =
  | { command: "help" }
  | { command: "wait"; args: WaitArgs }
  | { command: "feedback"; args: FeedbackArgs }
  | { command: "reply"; args: ReplyArgs }
  | { command: "settle"; args: SettleArgs }
  | { usage: string; json?: boolean };

export const USAGE = `Usage: lookover wait [--pr N] [--timeout 30m] [--appear-timeout 3m] [--json]
       lookover feedback [--pr N] [--json]
       lookover reply <finding> <claim> <text> [--pr N]
       lookover settle <finding> <accepted|wrong> --confirmed-by-owner <reason> [--pr N] [--timeout 3m]

wait      Asks Lookover to review the commit you pushed, if nobody has, waits for its check and says what to
          do next. Asks again on the same commit when you replied on a thread since its last round, and
          resolves the threads of the findings it verified fixed or withdrew, or the owner settled.
feedback  The findings waiting on you in the newest round, each with its thread, your claim and Lookover's
          last reply.
reply     Answers a finding on its thread: claim fixed, wont-fix, disputed, deferred or question. Then run
          lookover wait to have it answered.
settle    Settles a finding on the person's word, once they told you so in this conversation: accepted as
          is, or wrong, with their reason in their words. Never on your own judgment, never to get past a
          finding you disagree with. Then run lookover wait.

  --pr N                the pull request; the current branch's by default
  --timeout 30m         how long wait waits for the result (settle: 3m, for Lookover's answer)
  --confirmed-by-owner  the person's reason: they told you to settle it, and why
  --appear-timeout 3m   how long wait waits for Lookover to pick the request up
  --json                one JSON document on stdout

Exit (wait and feedback): 0 nothing to fix, 1 error, 2 usage, 3 something to fix, 4 a person is needed,
5 timed out (feedback: the review is still running), 6 skipped, 7 the review failed, 9 no review appeared
(feedback: none yet), 10 a newer commit was pushed. reply: 0 posted, 1 error, 2 usage. settle: 0 settled,
1 error, refused or no answer in time, 2 usage.`;

const UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;

/** A duration such as `30m`, `90s`, `1h` or `45` (seconds), in ms; null when it is none or not above zero. */
function duration(text: string): number | null {
  const read = /^(\d+)(ms|s|m|h)?$/.exec(text);
  if (!read?.[1]) return null;
  const unit = read[2] === "ms" || read[2] === "m" || read[2] === "h" ? read[2] : "s";
  const ms = Number(read[1]) * UNIT_MS[unit];
  return ms > 0 ? ms : null;
}

/** Every option any command takes, read into one bag; each command says which it takes. */
interface Options {
  pr: number | null;
  /** Null when not given: each command has its own default. */
  timeoutMs: number | null;
  appearMs: number;
  json: boolean;
  /** `--confirmed-by-owner`'s reason, as given; null when not given. */
  confirmed: string | null;
}

/** What a duration flag sets, or why its value is no duration. */
const durationOf =
  (flag: string, set: (o: Options, ms: number) => void) =>
  (o: Options, value: string): string | null => {
    const ms = duration(value);
    if (ms === null) return `${flag} takes a duration such as 30m, 90s or 1h, not "${value}".`;
    set(o, ms);
    return null;
  };

/** Each option that takes a value: it sets it, or says why the value can't be one. */
const OPTIONS: Record<string, (o: Options, value: string) => string | null> = {
  "--pr": (o, value) => {
    if (!/^[1-9]\d*$/.test(value)) return `--pr takes a pull request's number, not "${value}".`;
    o.pr = Number(value);
    return null;
  },
  "--timeout": durationOf("--timeout", (o, ms) => {
    o.timeoutMs = ms;
  }),
  "--appear-timeout": durationOf("--appear-timeout", (o, ms) => {
    o.appearMs = ms;
  }),
  "--confirmed-by-owner": (o, value) => {
    o.confirmed = value;
    return null;
  },
};

type Command = "wait" | "feedback" | "reply" | "settle";

/** The flags each command takes. */
const TAKES = {
  wait: new Set(["--pr", "--timeout", "--appear-timeout", "--json"]),
  feedback: new Set(["--pr", "--json"]),
  reply: new Set(["--pr"]),
  settle: new Set(["--pr", "--timeout", "--confirmed-by-owner"]),
} satisfies Record<Command, Set<string>>;

const isCommand = (word: string): word is Command => word in TAKES;
const isClaimKind = (key: string): key is ClaimKind => key in CLAIMS;
/** The claims, in the order `lookover reply` lists their words. */
const CLAIM_KINDS = Object.keys(CLAIMS).filter(isClaimKind);
/** The claim `word` names, or null for no claim's. */
const claimOf = (word: string): ClaimKind | null =>
  CLAIM_KINDS.find((kind) => CLAIMS[kind].word === word) ?? null;

const HELP = new Set(["help", "--help", "-h"]);

export function ask(argv: string[]): Asked {
  const [command, ...rest] = argv;
  const json = argv.includes("--json");
  if (command === undefined || HELP.has(command)) return { command: "help" };
  if (!isCommand(command)) return { usage: `lookover has no command "${command}".`, json };
  const read = readOptions(command, rest.flatMap(split));
  if ("help" in read) return { command: "help" };
  if ("usage" in read) return { usage: read.usage, json };
  const { options: o, words } = read;
  if (command === "reply") return replyAsked(o, words);
  if (command === "settle") return settleAsked(o, words);
  if (words.length > 0) return { usage: `lookover ${command} takes no "${words[0]}".`, json };
  if (command === "wait") {
    const { pr, appearMs, json } = o;
    return { command, args: { pr, timeoutMs: o.timeoutMs ?? 30 * 60_000, appearMs, json } };
  }
  return { command, args: { pr: o.pr, json: o.json } };
}

/** `--flag=value` as two arguments, as `--flag value` is. */
function split(arg: string): string[] {
  const equals = arg.indexOf("=");
  return arg.startsWith("--") && equals > 0 ? [arg.slice(0, equals), arg.slice(equals + 1)] : [arg];
}

/** The command's options, and the words that are none; or help, or why the arguments can't be read. */
function readOptions(
  command: Command,
  rest: string[],
): { options: Options; words: string[] } | { help: true } | { usage: string } {
  const options: Options = { pr: null, timeoutMs: null, appearMs: 3 * 60_000, json: false, confirmed: null };
  const words: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? "";
    if (HELP.has(arg)) return { help: true };
    if (!arg.startsWith("--")) {
      words.push(arg);
      continue;
    }
    if (!TAKES[command].has(arg)) return { usage: `lookover ${command} has no option "${arg}".` };
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    const wrong = option(options, arg, rest[++i]);
    if (wrong !== null) return { usage: wrong };
  }
  return { options, words };
}

/** Sets the option `flag` to `value`, or says why it can't. */
function option(o: Options, flag: string, value: string | undefined): string | null {
  const set = OPTIONS[flag];
  if (!set) return `lookover has no option "${flag}".`;
  if (value === undefined || value === "") return `${flag} needs a value.`;
  return set(o, value);
}

const CLAIM_WORDS = CLAIM_KINDS.map((kind) => CLAIMS[kind].word);
/** `fixed, wont-fix, disputed, deferred or question`. */
const CLAIM_LIST = `${CLAIM_WORDS.slice(0, -1).join(", ")} or ${CLAIM_WORDS.at(-1)}`;

function replyAsked(o: Options, words: string[]): Asked {
  const [finding = "", word = "", text = "", ...more] = words;
  const claim = claimOf(word);
  if (words.length < 3 || more.length > 0)
    return {
      usage:
        'lookover reply takes the finding, the claim and the text, in quotes: lookover reply F3 wont-fix "…".',
    };
  if (!FINDING_PATTERN.test(finding.toUpperCase()))
    return { usage: `"${finding}" is no finding: name one as F3.` };
  if (claim === null) return { usage: `"${word}" is no claim: say ${CLAIM_LIST}.` };
  if (text.trim() === "") return { usage: "The reply needs a text: why, in a sentence." };
  return {
    command: "reply",
    args: { pr: o.pr, finding: finding.toUpperCase(), claim, text: text.trim() },
  };
}

/**
 * `settle`'s arguments (ADR 0101): the finding, the decision, and the person's reason after `--confirmed-by-owner`,
 * required, and on one line at most `REASON_MAX` characters (`oneLineReason`), as the service takes it.
 */
function settleAsked(o: Options, words: string[]): Asked {
  const [finding = "", decision = ""] = words;
  if (words.length !== 2)
    return {
      usage:
        'lookover settle takes the finding and the decision: lookover settle F3 accepted --confirmed-by-owner "…".',
    };
  if (!FINDING_PATTERN.test(finding.toUpperCase()))
    return { usage: `"${finding}" is no finding: name one as F3.` };
  const decided = OWNER_DECISION.safeParse(decision);
  if (!decided.success) return { usage: `"${decision}" is no decision: say accepted or wrong.` };
  if (o.confirmed === null)
    return {
      usage:
        "lookover settle needs --confirmed-by-owner and the person's reason: settle only what the person told you to settle, in their words.",
    };
  const said = oneLineReason(o.confirmed);
  if ("tooLong" in said)
    return { usage: `The reason is ${said.tooLong} characters: say it in ${REASON_MAX} or fewer.` };
  const { reason } = said;
  if (reason === null) return { usage: "--confirmed-by-owner needs the person's reason, in their words." };
  const timeoutMs = o.timeoutMs ?? 3 * 60_000;
  return {
    command: "settle",
    args: { pr: o.pr, finding: finding.toUpperCase(), decision: decided.data, reason, timeoutMs },
  };
}
