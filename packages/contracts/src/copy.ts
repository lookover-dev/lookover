// The phrases more than one place says, written once (coding standards: every sentence a person reads is written
// once). The app's view model words the screens, `publish` words the pull request and the service's log file
// (`apps/service/src/log-lines.ts`) words what the service did; where two of them say the same thing (an engine's
// name, why a review waits or was skipped, why it failed, why it was cancelled, why its confirm pass or Deep's second
// find gave no answer, who found a round and who double-checked it, why a post waits and when it is tried again, how
// many findings stay in the app), they take it from here, so they never drift; so do the few ways of writing a thing
// they share (a phrase as a sentence, a short commit, a day, a clock's two digits). Here, not in a package of its
// own: the web imports only `contracts`. Phrases start lower case and carry no full stop, so the caller places them
// in its sentence (`asSentence` makes one a sentence of its own); titles and sentences start upper case. Each map is a
// `Record` over its union: a new value fails the typecheck.
import type { ConfirmFailure } from "./confirm.ts";
import type { EngineId } from "./engine.ts";
import type { EngineUnusable } from "./engines-port.ts";
import type { GhRefusal } from "./gh.ts";
import type { CreateAppRefusal } from "./github-app.ts";
import type { TransientHostFailure } from "./host.ts";
import type { CancelReason, Deferral, JobFailure, JobFailureKind, SkipReason } from "./job.ts";
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

/**
 * What the review's body and each of its line comments open with on GitHub, on both ways (ADR 0066), and the app's
 * mock of the pull request too: signed in on the shared App, Lookover posts as the person, and this is the only thing
 * on GitHub that says the words are Lookover's.
 */
export const LOOKOVERS_OPENING = "Lookover · ";

/** An engine whose version failed the self-test (ADR 0044), as a phrase after its name, or as its state. */
export const FAILED_SAFETY_CHECK = "didn't pass Lookover's safety check";

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
      return `Only npm's ${engine} launcher was found, and it runs ${ENGINE[engine]} through Node. Install the native ${engine} program, then check again.`;
    case "too-old":
      return `${why.model} needs ${ENGINE[engine]} ${why.needs} or later; this one is ${why.version}. Update it, then check again: npm install -g @openai/codex@latest`;
  }
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

/** The command that signs the person's own `gh` in (ADR 0059). */
export const GH_SIGN_IN = "gh auth login";

/**
 * What gets the person's own `gh` to answer for them (ADR 0059), up to `GH_SIGN_IN`: installed then signed in, or
 * signed in. The setup and "Use an existing App" each say it in a sentence of their own.
 */
export const GH_FIX_BEFORE = {
  "gh-missing": "install gh, then run",
  "gh-signed-out": "run",
} as const satisfies Record<Exclude<GhRefusal["kind"], "gh-unanswered">, string>;

/** The fix as one phrase: "install gh, then run gh auth login". */
export const ghFixText = (kind: keyof typeof GH_FIX_BEFORE): string => `${GH_FIX_BEFORE[kind]} ${GH_SIGN_IN}`;

/** The setup's disclosure where an App made before is given, as it reads on screen. */
export const USE_EXISTING_APP = "Advanced: use an existing App";

/**
 * Why "Create it on GitHub" made no App (ADR 0053), as a sentence: the setup screen says it, the tab GitHub's page
 * would open in says it, and the command's answer gives it to the console.
 */
export function createAppRefusalText(refusal: CreateAppRefusal): string {
  switch (refusal.kind) {
    case "live-config":
      return "Live runs use the test App; they never create one.";
    case "already-made":
      return "Lookover already keeps an App.";
    case "gh-missing":
      return `Creating it on an organisation needs the GitHub CLI: ${ghFixText("gh-missing")}.`;
    case "gh-signed-out":
      return `Creating it on an organisation needs gh signed in: ${ghFixText("gh-signed-out")}.`;
    case "gh-unanswered":
      return "gh couldn't answer. Check again in a moment.";
    case "not-an-admin":
      return `Only an admin of the organisation can create its App. Once one has, use it under “${USE_EXISTING_APP}”.`;
  }
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
  }
}

const FAILED: Record<JobFailureKind, (engine: EngineId | null) => string> = {
  service_stopped: () => "the service stopped before the review finished",
  prepare_failed: () => "the code could not be fetched",
  review_failed: (engine) => `${engine === null ? "the reviewer" : ENGINE[engine]} gave no review`,
  publish_failed: () => "GitHub refused the review",
  host_failed: () => "GitHub did not answer",
  unexpected: () => "the review could not run",
};

/**
 * Why a review did not run, as a phrase for the middle of a line, naming the engine that was reviewing when the
 * engine gave none. Null: a job that failed before anyone said why.
 */
export function failureText(failure: Pick<JobFailure, "kind" | "engine"> | null): string {
  return failure === null ? FAILED.unexpected(null) : FAILED[failure.kind](failure.engine);
}

/** What GitHub did to a post that waits to be sent again (ADR 0055). */
const POST_WAIT: Record<TransientHostFailure, string> = {
  rate_limited: "GitHub asked to wait",
  unavailable: "GitHub did not answer",
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
