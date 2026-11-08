// The phrases more than one place says, written once (coding standards: every sentence a person reads is written once).
// The app's view model words the screens, `publish` words the pull request and the service's log file
// (`apps/service/src/log-lines.ts`) words what the service did; where two of them say the same thing (an engine's name,
// why a review waits or was skipped, why it failed, why it was cancelled, why its confirm pass or Deep's second find
// gave no answer, who found a round and who double-checked it, who pushed new commits, why a post waits and when it
// is tried again, how many findings stay in the app, the status block in the description, the kind of each reply on a
// thread), they take it from here, so they never drift; so do the few ways of writing a thing they share (a phrase as
// a sentence, a short commit, a day, a clock's two digits).
// Here, not in a package of its own: the web imports only `contracts`. Phrases start lower case and carry no full stop,
// so the caller places them in its sentence (`asSentence` makes one a sentence of its own); titles and sentences start
// upper case. Each map is a `Record` over its union: a new value fails the typecheck.
import type { ClaimKind, FindingClaim } from "./claim.ts";
import type { ConfirmFailure } from "./confirm.ts";
import type { EngineId } from "./engine.ts";
import type { EngineHealth, EngineUnusable } from "./engines-port.ts";
import type { Finding } from "./finding.ts";
import type { TransientHostFailure } from "./host.ts";
import type {
  CancelReason,
  Deferral,
  FailureCause,
  JobFailure,
  JobFailureKind,
  PushedBy,
  SkipReason,
} from "./job.ts";
import type { ReplyKind } from "./reconciled.ts";
import type { Round } from "./round.ts";
import type { CitedRule } from "./rule.ts";

const ENGINE: Record<EngineId, string> = { claude: "Claude", codex: "Codex" };

/** An engine as people name it: "Claude". */
export function engineName(id: EngineId): string {
  return ENGINE[id];
}

// Written out, not ICU's: en-GB's short September is "Sept".
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A calendar day as the app and the check say it (ADR 0055): "Wed 14 Oct", read from `date`'s UTC fields, so the
 * caller shifts it to the zone it means first.
 */
export function dayText(date: Date): string {
  return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

/** An hour, a minute or a month's day as a clock or a date writes it: "05", "12". */
export function twoDigits(n: number): string {
  return String(n).padStart(2, "0");
}

/** A commit as people read it: its first seven characters, as GitHub shortens it. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** A phrase with its first letter in capitals, to open a sentence or a line: "at its limit" is "At its limit". */
export function upperFirst(phrase: string): string {
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

/** A phrase as a sentence of its own: "reviews are paused" is "Reviews are paused." */
export function asSentence(phrase: string): string {
  return `${upperFirst(phrase)}.`;
}

/** An engine whose version failed the self-test (ADR 0044), as a phrase after its name, or as its state. */
export const FAILED_SAFETY_CHECK = "didn't pass Lookover's safety check";

/** An engine whose self-test couldn't finish (ADR 0075), as a phrase after its name, or as its state. */
export const UNFINISHED_SAFETY_CHECK = "couldn't finish Lookover's safety check";

/**
 * A severity as the app and the pull request say it, given as `label` ("Should fix"): lowered because the confirm
 * pass didn't confirm it (ADR 0044), it says so.
 */
export function severityText(label: string, demoted: boolean): string {
  return demoted ? `${label}, unconfirmed` : label;
}

/**
 * Why an engine can't be used though its program was found, as sentences for the status menu: "Codex is signed in
 * with an API key. Lookover uses your ChatGPT plan only: sign in with ChatGPT."
 */
export function engineHealthText(why: EngineUnusable, engine: EngineId): string {
  switch (why.kind) {
    case "signed-in-otherwise":
      return `${ENGINE[engine]} is signed in with ${why.how}. Lookover uses your ChatGPT plan only: sign in with ChatGPT.`;
    case "npm-launcher":
      // npm's launcher is looked for on Windows only (the `engines` module's `claudeNpmLauncher`).
      return npmLauncherText(engine, "win32");
    case "too-old":
      return `${why.model} needs ${ENGINE[engine]} ${why.needs} or later; this one is ${why.version}. Update it, then check again: npm install -g @openai/codex@latest`;
  }
}

/**
 * What installs an engine's native program on `platform` (Node's name for it, `process.platform`: "win32" is
 * Windows), after "Install it" or "Install the native claude program" (ADR 0070): Claude's own installer, which puts
 * `claude` where Lookover looks and never npm's launcher it refuses; npm for Codex, everywhere.
 */
function installText(engine: EngineId, platform: string): string {
  if (engine === "codex") return ", then check again: npm install -g @openai/codex";
  return platform === "win32"
    ? " in PowerShell, then check again: irm https://claude.ai/install.ps1 | iex"
    : ", then check again: curl -fsSL https://claude.ai/install.sh | bash";
}

function npmLauncherText(engine: EngineId, platform: string): string {
  return `Only npm's ${engine} launcher was found, and it runs ${ENGINE[engine]} through Node. Install the native ${engine} program${installText(engine, platform)}`;
}

/**
 * An engine's detail as the status menu and the setup say it, from its health, on `platform` (Node's name for it):
 * why it can't be used, with this machine's command to install it when its program wasn't found (ADR 0070), or
 * nothing.
 */
export function engineDetailText(
  engine: EngineId,
  health: Pick<EngineHealth, "installed" | "why">,
  platform: string,
): string {
  if (health.why?.kind === "npm-launcher") return npmLauncherText(engine, platform);
  if (health.why !== undefined) return engineHealthText(health.why, engine);
  return health.installed
    ? ""
    : `The ${engine} program was not found on this computer. Install it${installText(engine, platform)}`;
}

/** Why an engine found can't be used, as a phrase: "Codex 0.161.0 is too old for gpt-6.1-sol". */
function unusableText(why: EngineUnusable, engine: EngineId): string {
  switch (why.kind) {
    case "signed-in-otherwise":
      return `${ENGINE[engine]} is signed in with ${why.how}, not ChatGPT`;
    case "npm-launcher":
      return `only npm's ${engine} launcher was found`;
    case "too-old":
      return `${ENGINE[engine]} ${why.version} is too old for ${why.model}`;
  }
}

/**
 * What makes an engine whose program was found but can't be used usable, after "once" where a deferred review says
 * when it starts. `reader`: the owner in the app, "you", whose notice has just named the engine, so "it"; anyone on
 * the pull request, "the owner", naming it: "Codex is updated".
 */
export function unusableFixedText(
  why: EngineUnusable,
  engine: EngineId,
  reader: "you" | "the owner",
): string {
  const app = reader === "you";
  switch (why.kind) {
    case "too-old":
      return `${app ? "it" : ENGINE[engine]} is updated`;
    case "signed-in-otherwise":
      return app ? "you sign in with ChatGPT" : `the owner signs ${ENGINE[engine]} in with ChatGPT`;
    case "npm-launcher":
      return app ? "the native program is installed" : `the native ${engine} program is installed`;
  }
}

/** An engine's state in a few words when its program was found but can't be used: "too old"; null, "not installed". */
export function unusableStateText(why: EngineUnusable | null): string | null {
  return why?.kind === "too-old" ? "too old" : null;
}

/** What a deferred review waits for, in plain words: "Claude is signed out". */
export function deferralText(deferral: Deferral): string {
  switch (deferral.reason) {
    case "paused":
      return "reviews are paused";
    case "connection":
      return "GitHub is disconnected";
    case "engine-signed-out":
      return `${ENGINE[deferral.engine]} is signed out`;
    case "engine-missing":
      return deferral.unusable === null
        ? `${ENGINE[deferral.engine]} is not installed`
        : unusableText(deferral.unusable, deferral.engine);
    case "engine-limit":
      return `${ENGINE[deferral.engine]} reached its limit`;
    case "engine-failed-self-test":
      return `${ENGINE[deferral.engine]} ${FAILED_SAFETY_CHECK}`;
    case "engine-self-test-unfinished":
      return `${ENGINE[deferral.engine]} ${UNFINISHED_SAFETY_CHECK}`;
  }
}

const FAILED: Record<JobFailureKind, (engine: EngineId | null) => string> = {
  service_stopped: () => "the service stopped before the review finished",
  prepare_failed: () => "the code could not be fetched",
  review_failed: (engine) => `${engine === null ? "the reviewer" : ENGINE[engine]} gave no review`,
  publish_failed: () => "GitHub refused a post",
  host_failed: () => "GitHub didn't answer",
  unexpected: () => "the review could not run",
};

/**
 * Why a review did not run, as a phrase for the middle of a line, naming the engine that was reviewing when the
 * engine gave none. Null: a job that failed before anyone said why.
 */
function failureText(failure: Pick<JobFailure, "kind" | "engine"> | null): string {
  return failure === null ? FAILED.unexpected(null) : FAILED[failure.kind](failure.engine);
}

/** What GitHub did to a post that waits to be sent again (ADR 0055). */
const POST_WAIT: Record<TransientHostFailure, string> = {
  rate_limited: "GitHub asked to wait",
  unavailable: "GitHub didn't answer",
};

/**
 * Why a round's post waits and when it is sent again, as a phrase, given that time as its caller words it ("at
 * 14:05"): "GitHub asked to wait, trying again at 14:05".
 */
export function postWaitText(refusal: TransientHostFailure, when: string): string {
  return `${POST_WAIT[refusal]}, trying again ${when}`;
}

const CONFIRM_FAILED: Record<ConfirmFailure, (engine: EngineId) => string> = {
  auth_required: (engine) => deferralText({ reason: "engine-signed-out", engine }),
  quota_exhausted: (engine) => deferralText({ reason: "engine-limit", engine }),
  timeout: (engine) => `${ENGINE[engine]} ran out of time`,
  crashed: (engine) => `${ENGINE[engine]} stopped before it answered`,
  cancelled: (engine) => `${ENGINE[engine]} was stopped before it answered`,
  invalid_output: (engine) => `${ENGINE[engine]}'s answer could not be read`,
  unreadable: (engine) => `${ENGINE[engine]}'s answer could not be read`,
};

/**
 * Why a round's confirm pass gave no verdicts (ADR 0044), as a phrase naming the engine that ran it: "Claude ran out
 * of time". Its findings were posted as found, not double-checked.
 */
export function confirmFailureText(failure: ConfirmFailure, engine: EngineId): string {
  return CONFIRM_FAILED[failure](engine);
}

/** Why a round had no confirm pass: it raised no finding (ADR 0044), as a phrase. */
export const NOTHING_NEW_TO_CHECK = "nothing new to double-check";

/** A round's new findings, posted as found: its confirm pass failed, or it had none (ADR 0044), as a phrase. */
export const NOT_DOUBLE_CHECKED = "not double-checked";

/**
 * A round's finders as the app and the pull request word them: "Claude"; with Deep's second find pass (ADR 0044)
 * "Claude and Codex", or "Claude in two sessions" when one engine ran both. `second`: the second finder, when its
 * pass answered.
 */
export function findersText(reviewer: EngineId, second: EngineId | null): string {
  if (second === null) return ENGINE[reviewer];
  return second === reviewer
    ? `${ENGINE[reviewer]} in two sessions`
    : `${ENGINE[reviewer]} and ${ENGINE[second]}`;
}

/** The facts of a round that say who found it and who double-checked it: the round's, or the run's it is posted from. */
export type RoundChecks = Pick<Round, "reviewer" | "secondFind" | "confirmer" | "confirmFailure" | "raised">;

/**
 * Who found a round and who double-checked it (ADR 0055), as a phrase: "found by Codex, double-checked by Claude".
 * Both finders of a Deep round, or the finder "in two sessions"; the finder alone when its second pass gave no
 * answer; the finder "in a new session" when it confirmed; "not double-checked" when the confirm pass failed or the
 * round raised findings with none (Quick, or only Consider ones after round 1); nothing new when it raised none.
 * Never tokens or times: they stay in the app.
 */
export function foundAndCheckedText(round: RoundChecks): string {
  const { reviewer, secondFind, confirmer, confirmFailure } = round;
  const second = secondFind === null || secondFind.failure !== null ? null : secondFind.engine;
  const found = `found by ${findersText(reviewer, second)}`;
  if (confirmer === null) return `${found}, ${round.raised > 0 ? NOT_DOUBLE_CHECKED : NOTHING_NEW_TO_CHECK}`;
  if (confirmFailure !== null) return `${found}, ${NOT_DOUBLE_CHECKED}`;
  const fresh = confirmer === reviewer ? " in a new session" : "";
  return `${found}, double-checked by ${ENGINE[confirmer]}${fresh}`;
}

const CANCELLED: Record<CancelReason, string> = {
  closed: "the pull request was closed",
  replaced: "a newer review took its place",
  pushed: "a newer commit was pushed after the request",
};

/** What Codex reviews while its reads aren't confined (ADR 0044, ADR 0048). */
export const CODEX_REVIEWS = "it reviews only your own pull requests from this repository";

const SKIPPED: Record<SkipReason, string> = {
  "not-yours": "not opened by you or your agents",
  draft: "still a draft",
  "repo-off": "this repository is off",
  "on-open-off": "reviews on open are off",
  "codex-not-yours": `only Codex may review here, and ${CODEX_REVIEWS}`,
  fork: "it comes from a fork",
};

/** Why a change wasn't reviewed, as a phrase: "still a draft". */
export function skipText(reason: SkipReason): string {
  return SKIPPED[reason];
}

/** Why a waiting review was cancelled, as a title: "The pull request was closed". */
export function cancelText(reason: CancelReason): string {
  return upperFirst(CANCELLED[reason]);
}

/** Why a waiting review was cancelled, as a phrase: "the pull request was closed". */
export function cancelPhrase(reason: CancelReason): string {
  return CANCELLED[reason];
}

/** How many findings stay in Lookover, off the pull request (ADR 0042), as a sentence; null when none does. */
export function keptText(kept: number): string | null {
  if (kept === 0) return null;
  return kept === 1
    ? "One finding stays in Lookover, not on the pull request."
    : `${kept} findings stay in Lookover, not on the pull request.`;
}

/** Where a finding's rule is (ADR 0048), as a phrase: "REVIEW.md, line 12". */
export function ruleText(rule: Pick<CitedRule, "file" | "line">): string {
  return `${rule.file}, line ${rule.line}`;
}

/** What the owner's dismissal of a finding as wrong (ADR 0052) keeps from then on, as a phrase after "It". */
export const NOT_RAISED_AGAIN = "won't be raised again on this pull request";

// The status block in the pull request's description (ADR 0074), as `publish` posts it and the app's simulated
// GitHub page shows it.

/** The status block's heading for a round posted: "Nothing to fix", "One thing to fix", "3 things to fix". */
export function thingsText(n: number): string {
  return n === 0 ? "Nothing to fix" : n === 1 ? "One thing to fix" : `${n} things to fix`;
}

const STOPPED: Record<JobFailureKind, (engine: EngineId | null) => string> = {
  review_failed: (engine) =>
    `${engine === null ? "The reviewer" : ENGINE[engine]} stopped before it finished.`,
  service_stopped: () => "Lookover stopped before it finished.",
  prepare_failed: () => "Lookover couldn't get the code ready.",
  host_failed: () => "GitHub didn't answer.",
  publish_failed: () => "Lookover couldn't post the round.",
  unexpected: () => "Something went wrong in Lookover.",
};

/**
 * New commits on a change, as a phrase: "the agent pushed 2 commits" when it signed every one (ADR 0081), else "2 new
 * commits", no one named; "new commits" when GitHub didn't count them (`commits: 0`).
 */
export function pushedText(by: PushedBy, commits: number): string {
  const counted = (one: string) => (commits === 1 ? `1 ${one}` : `${commits} ${one}s`);
  if (by === "agent") return `the agent pushed ${commits > 0 ? counted("commit") : "new commits"}`;
  return commits > 0 ? counted("new commit") : "new commits";
}

/**
 * Why a job failed, as the status block's sentence by its kind, naming the engine that was reviewing: "Codex stopped
 * before it finished."; "The reviewer" when no run had started.
 */
export function stoppedText(kind: JobFailureKind, engine: EngineId | null): string {
  return STOPPED[kind](engine);
}

/** What the status block of a failed job asks, after why it failed. */
export const TRY_AGAIN = "Push again, or comment `/lookover review`, to try again.";

const UNITS = [
  { ms: 3_600_000, one: "hour" },
  { ms: 60_000, one: "minute" },
  { ms: 1_000, one: "second" },
] as const;

/**
 * A time limit in words, in the largest unit it is a whole number of (seconds at the least, rounded): "2 minutes",
 * or before a noun "2-minute".
 */
function limitWords(ms: number, beforeNoun: boolean): string {
  const unit = UNITS.find((u) => ms % u.ms === 0) ?? UNITS[2];
  const n = Math.max(1, Math.round(ms / unit.ms));
  if (beforeNoun) return `${n}-${unit.one}`;
  return `${n} ${unit.one}${n === 1 ? "" : "s"}`;
}

/**
 * The words of one cause, given who was reviewing and the limit that ran out. `remedy`: what would change it, for a
 * cause another try can't; null, another try can help.
 */
interface CauseWords {
  phrase: string;
  sentence: string;
  remedy: string | null;
}

const CAUSED: Record<FailureCause, (reviewer: string, limitMs: number | null) => CauseWords> = {
  // Any git step of getting the code ready, not the fetch alone: the worktree, the diff and the commit check have
  // limits too. Since the fetch reports progress (ADR 0068), git silent that long is a stall: worth another try.
  git_silent: (_, ms) => {
    const time = `for ${ms === null ? "too long" : limitWords(ms, false)}`;
    return {
      phrase: `git sent nothing ${time} while Lookover got the code ready`,
      sentence: `Git sent nothing ${time} while Lookover got the code ready.`,
      remedy: null,
    };
  },
  git_time_limit: (_, ms) => {
    const limit = ms === null ? "time limit" : `${limitWords(ms, true)} limit`;
    return {
      phrase: `getting the code ready ran past its ${limit}`,
      sentence: `Getting the code ready ran past its ${limit}.`,
      remedy: "The repository or the change is too large to get ready in that time.",
    };
  },
  engine_time_limit: (reviewer, ms) => {
    const limit = ms === null ? "time limit" : `${limitWords(ms, true)} limit`;
    return {
      phrase: `${reviewer} ran past its ${limit}`,
      sentence: `${upperFirst(reviewer)} ran past its ${limit}.`,
      remedy: "A smaller pull request fits in the time.",
    };
  },
  // No history in common, or a commit GitHub no longer has (force-pushed away): true of both.
  base_not_found: () => ({
    phrase: "where the commit branches off its base branch couldn't be found",
    sentence: "Lookover couldn't find where the commit branches off its base branch.",
    remedy: "Rebase onto the base branch, then push.",
  }),
  path_too_long: () => ({
    phrase: "a file path is too long for this machine",
    sentence: "A file path is too long for the machine Lookover runs on.",
    remedy: "Turning on long paths in Windows, or shorter paths, would fix it.",
  }),
  git_missing: () => ({
    phrase: "git isn't installed where Lookover runs",
    sentence: "Git isn't installed where Lookover runs.",
    remedy: "Install git, then push again.",
  }),
  network: () => ({ phrase: FAILED.host_failed(null), sentence: STOPPED.host_failed(null), remedy: null }),
  engine_answer: (reviewer) => ({
    phrase: `${reviewer} gave no usable review`,
    sentence: `${upperFirst(reviewer)} gave no usable review.`,
    remedy: null,
  }),
};

/**
 * A failed review in words (ADR 0081). `phrase`: lower case, no stop, after "The review failed: ", on Home and in
 * `wait`. `sentence`: the status block's and the app's. `retry`: another try can help, and `next` is `TRY_AGAIN`;
 * else `next` says what would change it. None of them names a path, an account or an engine's output: they are safe
 * on a public pull request.
 */
export interface FailureWords {
  phrase: string;
  sentence: string;
  retry: boolean;
  next: string;
}

/**
 * A failure's words by its cause, naming the engine that was reviewing and the limit that ran out (a limit of zero or
 * less is not known); with no cause (none known, or an event stored before causes were, which has no `cause` or
 * `limitMs` at all), by its kind, as `failureText` and `stoppedText` say it. Null: a job that failed before anyone said
 * why.
 */
export function failureWords(
  failure: Pick<JobFailure, "kind" | "engine" | "cause" | "limitMs"> | null,
): FailureWords {
  const cause = failure?.cause ?? null;
  if (failure === null || cause === null) {
    return {
      phrase: failureText(failure),
      sentence: stoppedText(failure?.kind ?? "unexpected", failure?.engine ?? null),
      retry: true,
      next: TRY_AGAIN,
    };
  }
  const reviewer = failure.engine === null ? "the reviewer" : ENGINE[failure.engine];
  const limitMs = failure.limitMs ?? null;
  const words = CAUSED[cause](reviewer, limitMs !== null && limitMs > 0 ? limitMs : null);
  return {
    phrase: words.phrase,
    sentence: words.sentence,
    retry: words.remedy === null,
    next: words.remedy ?? TRY_AGAIN,
  };
}

/** What a failure's words take: a job's failure, with the engine that was reviewing. */
type Failed = Parameters<typeof failureWords>[0];

/**
 * A failed review's check title on GitHub, which `lookover wait` repeats: "The review failed: Claude ran past its
 * 20-minute limit".
 */
export function failedTitle(failure: Failed): string {
  return `The review failed: ${failureWords(failure).phrase}`;
}

/**
 * A failed review's line in the status block (ADR 0074 as 0081 amends it): its sentence, then how to try again where
 * another try can help, else what would change it.
 */
export function failedLine(failure: Failed): string {
  const words = failureWords(failure);
  return `${words.sentence} ${words.next}`;
}

/**
 * When a deferred review starts, after "starts", for anyone on the pull request: "once GitHub is back"; an engine's
 * limit, "once the limit resets", its reset worded by the caller.
 */
export function startsOnceText(deferral: Deferral): string {
  switch (deferral.reason) {
    case "paused":
      return "once the owner resumes reviews";
    case "connection":
      return "once GitHub is back";
    case "engine-signed-out":
      return `by itself once the owner signs ${ENGINE[deferral.engine]} in`;
    case "engine-missing":
      return `by itself once ${
        deferral.unusable === null
          ? `${ENGINE[deferral.engine]} is installed`
          : unusableFixedText(deferral.unusable, deferral.engine, "the owner")
      }`;
    case "engine-limit":
      return "once the limit resets";
    case "engine-failed-self-test":
      return `by itself once a version of ${ENGINE[deferral.engine]} passes it`;
    case "engine-self-test-unfinished":
      return `by itself once ${ENGINE[deferral.engine]} passes it`;
  }
}

/**
 * Why a job waits and when its review starts, as the status block's sentences: null, behind the reviews before it;
 * an engine's limit, at `resetsAt` as the caller words it ("at 14:20", "on Wed 4 Nov at 14:20") when known.
 */
export function waitingText(deferral: Deferral | null, resetsAt: string | null): string {
  if (deferral === null) return "The review starts once the reviews before it are done.";
  if (deferral.reason === "engine-limit") {
    const when = resetsAt === null ? "" : `, ${resetsAt}`;
    return `${ENGINE[deferral.engine]} reached its usage limit. The review starts when it resets${when}.`;
  }
  return `${asSentence(deferralText(deferral))} The review starts ${startsOnceText(deferral)}.`;
}

/** The status block's heading while the owner has to decide a finding, and a thread's label on the simulated page. */
export const NEEDS_YOUR_LOOK = "Needs your look";

/**
 * The block's heading while a round runs on `commit`, as its pieces, the commit as the caller writes it (a link on
 * the pull request, a commit chip on the simulated page): "again" on the last round's commit.
 */
export function lookingOverHead<C>(commit: C, again: boolean): (string | C)[] {
  return ["Looking over ", commit, ...(again ? [" again"] : [])];
}

/** The block's heading while a job waits on `commit`, as its pieces. */
export function waitingHead<C>(commit: C): (string | C)[] {
  return ["Waiting to look over ", commit];
}

/** The block's heading once a job on `commit` failed, as its pieces. */
export function failedHead<C>(commit: C): (string | C)[] {
  return ["Couldn't look over ", commit];
}

/**
 * A posted round's counts over its posted findings, after its commit: "3 fixed, 1 withdrawn", withdrawn by the
 * finder or dismissed by the owner; "" for none.
 */
export function roundCountsText(findings: Pick<Finding, "status" | "posted">[]): string {
  const on = findings.filter((f) => f.posted);
  const fixed = on.filter((f) => f.status === "verified_fixed").length;
  const withdrawn = on.filter((f) => f.status === "withdrawn" || f.status === "dismissed").length;
  return [fixed > 0 ? `${fixed} fixed` : null, withdrawn > 0 ? `${withdrawn} withdrawn` : null]
    .filter((c) => c !== null)
    .join(", ");
}

/**
 * A posted round's line in the block, as its pieces, the commit as the caller writes it: "Round 3 · <commit> · 3
 * fixed, 1 withdrawn", the counts over `findings`, the ledger, left out when there are none.
 */
export function roundLine<C>(
  n: number,
  commit: C,
  findings: Pick<Finding, "status" | "posted">[],
): (string | C)[] {
  const counts = roundCountsText(findings);
  return [`Round ${n} · `, commit, ...(counts === "" ? [] : [` · ${counts}`])];
}

/** The second line of a finding with no line comment, from its body: "Not in the diff: reminders go out twice." */
export function notInDiffText(body: string): string {
  return `Not in the diff: ${body.charAt(0).toLowerCase()}${body.slice(1)}`;
}

const KEPT_TWICE: Record<Exclude<ClaimKind, "disputed">, string> = {
  wont_fix: "Said won't fix twice, kept twice",
  claimed_fixed: "Said fixed twice, kept twice",
  deferred: "Said deferred twice, kept twice",
  question: "Asked twice, kept twice",
};

/**
 * Why the owner decides an escalated finding, as the status block's line under it, by its newest claim: a dispute
 * the finder still calls wrong, however often it was kept (core escalates a blocking one at once); another claim,
 * kept twice against it, named by its kind (core keeps only the newest claim, so a dispute then a won't fix, kept
 * twice, reads "Said won't fix twice"); no claim, kept twice.
 */
export function escalationText(claim: ClaimKind | null): string {
  const why =
    claim === "disputed"
      ? "Disputed, and the finder still calls it wrong"
      : claim === null
        ? "Kept twice"
        : KEPT_TWICE[claim];
  return `${why}: the owner decides on the thread.`;
}

/** Why the owner decides a finding kept twice against "won't fix" (ADR 0074), in the reply on its thread. */
export const KEPT_TWICE_WONT_FIX =
  'Kept twice against "won\'t fix". Fix it, or resolve this thread to keep the code as it is.';

/**
 * The kind of a reply on the thread of a finding a round found still there after a push (ADR 0081): `lookover wait`
 * prints it before that round's reason, as the reply says it.
 */
export const STILL_PRESENT = "Still present";

/**
 * A reply on a finding's thread, after the wordmark: its kind; its fixed words in place of the finder's why, if any;
 * and what it says last, if anything.
 */
export interface ReplyWords {
  kind: string;
  why: string | null;
  last: string | null;
}

/**
 * What a reply on a finding's thread is, by what the round decided (`reply`) and the finding as it left it. A finding
 * kept once against its author is escalated the next time (ADR 0052): the reply says so, unless the owner already
 * has it; one escalated after "won't fix" kept twice gets the fixed words, not the finder's.
 */
export function replyKind(
  reply: ReplyKind,
  finding: (Pick<Finding, "status" | "kept"> & { claim: Pick<FindingClaim, "kind"> | null }) | undefined,
): ReplyWords {
  const words = (kind: string, why: string | null = null, last: string | null = null) => ({
    kind,
    why,
    last,
  });
  switch (reply) {
    case "kept":
      return finding?.status === "escalated"
        ? words("Kept. The owner decides")
        : words("Kept", null, "If it is kept again, the owner decides.");
    case "escalated":
      return finding?.claim?.kind === "wont_fix" && finding.kept >= 2
        ? words("The owner decides this one", KEPT_TWICE_WONT_FIX)
        : words("The owner decides this one");
    case "withdrawn":
      return words("Withdrawn");
    case "answered":
      return words("Answer");
    case "dismissed":
      return words("Dismissed by the owner", null, `It ${NOT_RAISED_AGAIN}.`);
    case "still_present":
      // Nothing is counted: no closing line, as for an answer.
      return words(STILL_PRESENT);
  }
}
