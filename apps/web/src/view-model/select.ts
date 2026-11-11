// The view model: read-only views of the snapshot, what Home, the status pill and the rows show.
import {
  type AccountCause,
  asSentence,
  type Change,
  CODEX_REVIEWS,
  type Command,
  type Connection,
  type ConnectionAccount,
  type ConnectionCause,
  type Deferral,
  type Engine,
  type EngineId,
  engineName,
  type Finding,
  type FixAction,
  failedHead,
  failureWords,
  isUnsettled,
  type Repository,
  type RepositoryId,
  type Review,
  type Reviewers,
  type SettingKey,
  SHARED_APP,
  type SkipReason,
  type State,
  shortSha,
  skipText,
  type Turn,
} from "@lookover/contracts";
import type { Tone } from "../ui/basics.tsx";
import {
  type AccountLink,
  accountFix,
  installFirstFix,
  LOOK,
  lookRuns,
  ownsAccount,
  saidSignedOut,
  sharedRepositoriesLink,
  ssoFix,
} from "./accounts.ts";
import { deferralText, waitingNotice } from "./deferral.ts";
import {
  ago,
  agoSentence,
  clock,
  holdSeparators,
  inSentence,
  isToday,
  itOrThem,
  metaLine,
  plural,
  repositoryLabel,
  until,
  type WithCommand,
  type Words,
} from "./format.ts";
import {
  causeText,
  connectionText,
  ENGINE_CHECK_AGAIN,
  ENGINE_TRY_AGAIN,
  engineStateText,
  serviceStatus,
} from "./health.ts";
import { type RunLineParts, runLine, runLineParts } from "./run.ts";
import { inTab, isMine, neverAsked, type Scope } from "./scope.ts";
import { FINISHING, SIGN_IN_TEXT, waitingText } from "./sign-in.ts";
import { atLoginMismatch } from "./start-at-login.ts";
import {
  type DisplayStatus,
  displayStatus,
  FILTER_OF,
  failedWords,
  retryHelps,
  retryNote,
} from "./status.ts";

/** A change with its review and the repository it belongs to: one row on Home, one review page. */
export interface ChangeReview {
  change: Change;
  review: Review;
  repo: Repository;
}

export function changeReviews(state: State): ChangeReview[] {
  const out: ChangeReview[] = [];
  for (const change of Object.values(state.changes)) {
    const review = state.reviews[change.id];
    const repo = state.repos.find((r) => r.id === change.repoId);
    if (review && repo) out.push({ change, review, repo });
  }
  return out.sort((a, b) => b.review.updatedAt - a.review.updatedAt);
}

/**
 * The pull requests Reviews lists: those of the repositories that are on, the person's own included (ADR 0084). Home,
 * All reviews, the tabs, Home's sentence and the palette read these; a review page reached by its address and the
 * counts of real jobs read every change. A review queued, deferred or running when its repository was switched off stays
 * listed until it ends: switching off cancels no job, and its row is where it is watched or cancelled.
 */
export function listedReviews(state: State): ChangeReview[] {
  return changeReviews(state).filter((i) => i.repo.enabled || isPending(i));
}

/** A review that runs or waits: its job queued, deferred or running. */
function isPending(it: ChangeReview): boolean {
  const { kind } = status(it);
  return kind === "running" || kind === "waiting";
}

/**
 * The change at a page address: its repository's owner and name, and its number, as in
 * "/reviews/sasensi/ledger-api/148" (ADR 0066).
 */
export function changeReviewAt(
  state: State,
  owner: string | undefined,
  name: string | undefined,
  number: string | undefined,
): ChangeReview | null {
  return (
    changeReviews(state).find(
      (i) => i.repo.owner === owner && i.repo.name === name && String(i.change.number) === number,
    ) ?? null
  );
}

/** "sasensi/ledger-api #148": the owner too, since two accounts may each have a ledger-api (ADR 0066). */
export function changeLabel(change: Change): string {
  return `${change.repoId} #${change.number}`;
}

/**
 * Home's empty state, the sentence under "Nothing reviewed yet": with no repository listed (the App sees none, or was
 * uninstalled), it waits for one; with none turned on, it says where to turn one on; else the repositories turned on,
 * by name, with the owner only where a name repeats among them, in any case (#536): two lookover-sandbox under two
 * accounts are never said as the same one twice.
 */
export function nothingReviewedYet(repos: readonly Pick<Repository, "owner" | "name" | "enabled">[]): string {
  if (repos.length === 0)
    return "Once the App can see a repository on GitHub, its pull requests will show up here.";
  const on = repos.filter((r) => r.enabled);
  if (on.length === 0) return "Turn on a repository in Repositories and its pull requests will show up here.";
  const key = (r: Pick<Repository, "name">) => r.name.toLowerCase();
  const repeats = (r: Pick<Repository, "name">) => on.filter((o) => key(o) === key(r)).length > 1;
  const names = on.map((r) => (repeats(r) ? repositoryLabel(r) : r.name));
  return `Open a pull request in ${inSentence(names, "or")} and it will show up here.`;
}

/**
 * Who reviews, as the "Who reviews" setting says it: "Claude and Codex", in no order (ADR 0044: the one that didn't
 * write the change finds).
 */
export const REVIEWERS_TEXT: Record<Reviewers, string> = {
  both: `${engineName("claude")} and ${engineName("codex")}`,
  claude: engineName("claude"),
  codex: engineName("codex"),
};

/** "Claude": the coding agent that wrote a change, named after its program. */
function writerName(change: Change): string | null {
  return change.writtenBy ? engineName(change.writtenBy) : null;
}

/**
 * Who opened it, then who wrote it when an agent did: "by sasensi · written by Claude" (ADR 0078). Every row says
 * "by" the same way, the person's own, an agent's and a teammate's (round 5: "sasensi" bare on one row beside
 * "by sasensi" on the next read as two different things).
 */
export function authorLabel(change: Change): string {
  const writer = writerName(change);
  return writer ? `by ${change.openedBy} · written by ${writer}` : `by ${change.openedBy}`;
}

export function unsettledFindings(review: Review): Finding[] {
  return review.findings.filter(isUnsettled);
}

/**
 * The findings a settled loop still keeps in the app: open, but kept off the pull request (I-152). They never
 * hold the loop open; the app shows them, marked as not posted.
 */
export function keptFindings(review: Review): Finding[] {
  return review.findings.filter((f) => isUnsettled(f) && !f.posted);
}

/** What the app says about `n` kept findings, once the loop is settled. */
function keptText(n: number): string {
  return n === 1 ? "1 finding stays here, not on GitHub" : `${n} findings stay here, not on GitHub`;
}

/**
 * The commit a review's verdict says it looked over: its last round's, else the pull request's head, by its first
 * seven characters as the rounds name it.
 */
export function lookedOver(it: ChangeReview): string {
  return shortSha(it.review.rounds.at(-1)?.sha ?? it.change.headSha);
}

/**
 * A settled review's verdict: how many findings closed in how many rounds, then what stays in the app, or,
 * when nothing does, that the rest can go (ADR 0042, as on the pull request).
 */
export function settledVerdict(review: Review): { closed: string; rest: string } {
  const kept = keptFindings(review).length;
  const closed = plural(review.findings.length - kept, "finding");
  const rounds = plural(review.rounds.length, "round");
  return kept > 0
    ? { closed: `${closed} closed in ${rounds}.`, rest: `${keptText(kept)}.` }
    : { closed: `${closed}, all closed in ${rounds}.`, rest: "The rest can go." };
}

/**
 * The verdict of a review that left findings open: to fix once posted, found after a preview, which posted nothing
 * (ADR 0072). Its words hold the commit, which the page draws as a commit, as the failed notice's `head`.
 */
export function openVerdict(it: ChangeReview): Words {
  const { open, blocking } = openCounts(unsettledFindings(it.review));
  // The counts one way: in words for one ("One thing to fix, one blocking"), else in digits throughout.
  const said = (n: number) => (open === 1 ? "one" : `${n}`);
  const things = open === 1 ? "One thing" : `${open} things`;
  const how = it.review.preview ? "found" : "to fix";
  const commit = it.review.rounds.at(-1)?.sha ?? it.change.headSha;
  return [
    "Looked over ",
    { commit },
    `. ${things} ${how}${blocking > 0 ? `, ${said(blocking)} blocking` : ""}.`,
  ];
}

/** How many findings are open, of those given, and how many of them are blocking. */
export function openCounts(open: readonly Finding[]): { open: number; blocking: number } {
  return { open: open.length, blocking: open.filter((f) => f.severity === "blocking").length };
}

/**
 * The line under a review's title (`metaLine`): who opened it and who wrote it, said as its row says them
 * (`authorLabel`), then who reviews or reviewed it, "by sasensi · written by Claude · reviewed by Codex" (round 4,
 * 2026-11-08: a comma then a wide gap read as two separators; "opened by" here beside "by" on the rows read as two
 * different things).
 */
export function reviewMeta(change: Change, reviewer: string | null): string {
  return metaLine([authorLabel(change), ...(reviewer ? [`reviewed by ${reviewer}`] : [])]);
}

/** The AI reviewing now, or the one that reviewed last. */
export function reviewerOf(review: Review): EngineId | null {
  return review.run?.reviewer ?? review.rounds.at(-1)?.reviewer ?? null;
}

export function status(it: ChangeReview): DisplayStatus {
  return displayStatus(it.review);
}

/** A state chip: its tone and its words. */
export interface StateChip {
  tone: Tone;
  label: string;
}

/**
 * The state chips whose words are fixed, by the status they show (a settled review with no finding is "clean"):
 * `chip` reads them, and so does what holds a chip's place for the chips it may show.
 */
export const CHIPS = {
  "needs-you": { tone: "need", label: "Needs you" },
  failed: { tone: "need", label: "Failed" },
  // Not under way yet: To fix's amber, told apart by its dot, a ring.
  waiting: { tone: "wait", label: "Waiting" },
  clean: { tone: "ok", label: "Clean" },
  settled: { tone: "ok", label: "Settled" },
  // Findings open: the ball is with the author.
  "to-fix": { tone: "warn", label: "To fix" },
  // Findings open, nothing posted: the owner's to read (ADR 0072).
  preview: { tone: "need", label: "Preview" },
  skipped: { tone: "mute", label: "Skipped" },
  cancelled: { tone: "mute", label: "Cancelled" },
} as const satisfies Record<Exclude<DisplayStatus["kind"], "running" | "not-asked"> | "clean", StateChip>;

export function chip(it: ChangeReview): StateChip {
  const s = status(it);
  switch (s.kind) {
    case "running":
      return { tone: "run", label: `Round ${s.round}` };
    case "settled":
      return s.clean ? CHIPS.clean : CHIPS.settled;
    case "needs-you":
    case "failed":
    case "waiting":
    case "to-fix":
    case "preview":
    case "skipped":
    case "cancelled":
      return CHIPS[s.kind];
    case "not-asked":
      return { tone: "mute", label: it.change.draft ? "Draft" : "No review" };
  }
}

/** What a review waits for, in plain words: "Claude is signed out", or its turn. */
export function waitText(deferral: Deferral | null): string {
  return deferral ? deferralText(deferral) : "waiting for its turn";
}

/** "Claude", "Claude and Codex". */
const enginesText = (engines: EngineId[]): string => engines.map(engineName).join(" and ");

/** A phrase as a sentence of its own, then when the review starts. */
const sentenceOf = (text: string, after: "it" | "them"): string =>
  `${asSentence(text)} This one starts after ${after}.`;

/**
 * What a review waiting its turn waits behind (ADR 0055): its row's line ("Claude is reviewing ledger-api #149",
 * "round 2 is still posting") and its page's notice, which says when it starts.
 */
function turnWords(state: State, it: ChangeReview, turn: Turn): { line: string; notice: string } {
  const said = (line: string, after: "it" | "them") => ({ line, notice: sentenceOf(line, after) });
  if (turn.behind === "change") {
    const { run, rounds } = it.review;
    if (run === null) return said("earlier posts are still going out", "them");
    return said(
      `round ${rounds.length + 1} is still ${run.step === "publishing" ? "posting" : "running"}`,
      "it",
    );
  }
  const who = enginesText(turn.engines);
  const many = turn.engines.length > 1;
  if (turn.changes.length > 0) {
    const labels = turn.changes.map((id) => {
      const change = state.changes[id];
      return change ? changeLabel(change) : "another pull request";
    });
    const line = `${who} ${many ? "are" : "is"} reviewing ${labels.join(" and ")}`;
    return said(line, turn.changes.length > 1 ? "them" : "it");
  }
  if (turn.testing) {
    return many
      ? said(`${who} are running their self-tests`, "them")
      : said(`${who} is running its self-test`, "it");
  }
  // Only an older review waiting for the same AI holds it: first come, first served.
  return {
    line: "an earlier review goes first",
    notice: sentenceOf(`another review is waiting for ${who} first`, "it"),
  };
}

/** A waiting review's line on Home: why it waits, or what it waits behind. */
function waitLine(state: State, it: ChangeReview, deferral: Deferral | null, turn: Turn | null): string {
  if (deferral !== null || turn === null) return waitText(deferral);
  return turnWords(state, it, turn).line;
}

/** The notice on a waiting review's page: why it waits or what it waits behind, and when it starts. */
export function waitNotice(state: State, it: ChangeReview): string {
  const s = status(it);
  if (s.kind !== "waiting") return "";
  if (s.deferral !== null) return waitingNotice(s.deferral, { ...state, paused: state.service.paused });
  if (s.turn === null) return "It waits its turn and starts by itself.";
  return turnWords(state, it, s.turn).notice;
}

/**
 * What the status menu offers for the reviews deferred on `from`: send them to the other AI, once it is ready. The
 * service says on each deferred job which engine may step in (`stepIn`, from `core`'s rule: the repository's
 * reviewers allow it and it may review that change, ADR 0047); this only counts, and keeps no copy of the rule.
 */
export function sendElsewhere(state: State, from: EngineId): { to: EngineId; count: number } | null {
  const to: EngineId = from === "claude" ? "codex" : "claude";
  if (state.engines[to].state !== "ready") return null;
  const count = changeReviews(state).filter(
    ({ review }) => review.job?.state === "deferred" && review.job.stepIn === to,
  ).length;
  return count > 0 ? { to, count } : null;
}

/**
 * Why a change wasn't reviewed, at length: the review page's "Why wasn't it reviewed?". `ask`: how a request reviews
 * it, a review request comment around its command, for the skips a request reviews; null for the others.
 */
export interface SkipWhy {
  text: string;
  ask: { lead: string; command: string; tail: string } | null;
}

/**
 * The labels of the review page's review button, one per state it can be in: asking for a first review, asking for
 * one more, asking again after a failure another try can help, or showing the review that runs or waits. One place
 * for each, so the page, its notes and the shortcut list say the same words.
 */
export const REVIEW_BUTTON = {
  now: "Review now",
  again: "Review again",
  retry: "Try again",
  running: "Reviewing…",
  waiting: "Waiting…",
} as const;

export type ReviewButton = keyof typeof REVIEW_BUTTON;

/** The review button's labels R presses: every one that asks for a review. */
const REVIEW_KEY_LABELS = [REVIEW_BUTTON.now, REVIEW_BUTTON.again, REVIEW_BUTTON.retry];

/** What R does on a review, in the shortcut list: the review button, whichever it asks for, each label said. */
export const REVIEW_KEY = `${REVIEW_KEY_LABELS.slice(0, -1).join(", ")} or ${REVIEW_KEY_LABELS.at(-1)}`;

/**
 * Which label the review button shows: the review running or waiting, else what pressing it asks for; "Try again"
 * when the newest review failed and another try can help, the plain answer to the failed notice under it.
 */
export function reviewButton(it: ChangeReview): ReviewButton {
  const { kind } = status(it);
  if (kind === "running" || kind === "waiting") return kind;
  const { job } = it.review;
  if (job?.state === "failed" && retryHelps(job.failure)) return "retry";
  return it.review.rounds.length === 0 ? "now" : "again";
}

/**
 * Whether the review button is the page's filled primary: only when pressing it is what the person is needed for
 * (design-system.md "Button"): "Try again" after a failure another try can help, "Review now" before any round, or
 * "Review again" on commits nobody looked at or on a preview to post. While nothing needs them (the agent works on
 * the findings, the review settled, a finding only they can settle, which the button doesn't) it is a secondary.
 * After a failure another try can't cure, before round 1 too, only new commits make it the answer.
 */
export function reviewButtonPrimary(it: ChangeReview): boolean {
  const shown = reviewButton(it);
  if (shown === "retry") return true;
  if (shown !== "now" && shown !== "again") return false;
  if (it.review.job?.state === "failed") return it.change.newCommits > 0;
  if (shown === "now") return true;
  return it.change.newCommits > 0 || (it.review.preview && unsettledFindings(it.review).length > 0);
}

/**
 * Whether Open on GitHub is the page's filled primary: on a review that needs the person, where they settle the
 * thread (design-system.md "Button"), unless the review button already is, on commits nobody looked at.
 */
export function gitHubPrimary(it: ChangeReview): boolean {
  return status(it).kind === "needs-you" && !reviewButtonPrimary(it);
}

/** What the review button asks for: "Review now" before any round ran, "Review again" after. */
export function reviewLabel(it: ChangeReview): (typeof REVIEW_BUTTON)["now" | "again"] {
  return it.review.rounds.length === 0 ? REVIEW_BUTTON.now : REVIEW_BUTTON.again;
}

const ask = (it: ChangeReview, lead: string): SkipWhy["ask"] => ({
  lead,
  command: "/lookover review",
  tail: `on it, or use “${reviewLabel(it)}”.`,
});

/**
 * A skip a request reviews, by Claude only: where only Codex reviews, a request is skipped too (`codex-not-yours`),
 * so the way is Settings, not a request.
 */
function claudeOnly(it: ChangeReview, text: string, lead: string): SkipWhy {
  if (!codexOnly(it)) return { text, ask: ask(it, lead) };
  return { text: `${text} ${letClaudeReview(it.repo)}`, ask: null };
}

/** Where only Codex reviews, the way to have the change reviewed: Settings. */
const letClaudeReview = (repo: Pick<Repository, "name">): string =>
  `Only Codex reviews in ${repo.name}, and ${CODEX_REVIEWS}. To have this one reviewed, let Claude review too, in Settings.`;

function codexOnly(it: ChangeReview): boolean {
  return it.repo.settings.reviewers.value === "codex";
}

/**
 * Why another author's pull request isn't reviewed by itself (ADR 0078), then what came of it (`then`, from its
 * comma or "and" on): the skip's card and the never-asked one say the same rule.
 */
const openedByOther = (it: ChangeReview, then: string): string =>
  `By itself, Lookover reviews only the pull requests opened by you or by your coding agents. This one was opened by ${it.change.openedBy}${then}`;

/** How a request is said, by who would review: anyone, or Claude alone on a fork (ADR 0048). */
const ASK_LEAD = { any: "To have it reviewed, comment", fork: "To have Claude review it, comment" } as const;

const SKIP_WHY = {
  "not-yours": (it) =>
    claudeOnly(it, openedByOther(it, " and nobody asked for a review, so it was skipped."), ASK_LEAD.any),
  fork: (it) =>
    claudeOnly(
      it,
      "It comes from a fork, so its code could try to steer the reviewer. Lookover never reviews a pull request from a fork by itself.",
      ASK_LEAD.fork,
    ),
  draft: () => ({ text: "Drafts are skipped. It is reviewed when it is marked ready.", ask: null }),
  "repo-off": ({ repo }) => ({
    text: `Reviews are turned off for ${repo.name}. Turn them on in Repositories.`,
    ask: null,
  }),
  "on-open-off": (it) => ({
    text: `“When a pull request is opened” is off in Settings, so reviews start only when someone asks. Use “${reviewLabel(it)}” to ask.`,
    ask: null,
  }),
  "codex-not-yours": ({ repo }) => ({ text: letClaudeReview(repo), ask: null }),
} satisfies Record<SkipReason, (it: ChangeReview) => SkipWhy>;

/** Why the change wasn't reviewed, at length, for `reason`: the one its "Not reviewed" card names. */
export function skipWhy(it: ChangeReview, reason: SkipReason): SkipWhy {
  return SKIP_WHY[reason](it);
}

/** The review page's "Not reviewed" card: "Not reviewed: <title>.", then why at length. */
export interface NotReviewedCard {
  title: string;
  why: SkipWhy;
}

/**
 * The "Not reviewed" card of a change skipped or never asked about; null for any other. Never asked about in a
 * repository switched off, it says the repository is off: a request there is skipped too. Another author's pull
 * request the person hasn't asked about got nothing (ADR 0078): it says so, and how to ask; a teammate's own comment
 * doesn't ask. The person's own with no job was opened with reviews on open off.
 */
export function notReviewed(it: ChangeReview): NotReviewedCard | null {
  const s = status(it);
  if (s.kind === "skipped") return { title: skipText(s.reason), why: skipWhy(it, s.reason) };
  if (s.kind !== "not-asked") return null;
  if (!it.repo.enabled) return { title: skipText("repo-off"), why: skipWhy(it, "repo-off") };
  if (!neverAsked(it)) return { title: skipText("on-open-off"), why: skipWhy(it, "on-open-off") };
  const opened = openedByOther(it, ", so nothing was posted on it.");
  const text = it.change.fork ? `${opened} It comes from a fork, so only Claude would review it.` : opened;
  return { title: "you haven't asked", why: claudeOnly(it, text, ASK_LEAD[it.change.fork ? "fork" : "any"]) };
}

/**
 * Whether a request reviews a change never asked about: not in a repository switched off (a request there is
 * skipped `repo-off`), and not another author's where only Codex reviews (Codex never reviews another's, ADR 0078).
 * The review page's button and the row's action both follow it.
 */
function askable(it: ChangeReview): boolean {
  return it.repo.enabled && !(neverAsked(it) && codexOnly(it));
}

/**
 * "Review a pull request…": of `items`, only those whose review page offers Review now or Review again
 * (`canReviewAgain`: nothing that runs or waits, no skip a request would skip again), the person's first, then those
 * nobody asked about, each in the order given (ADR 0092).
 */
export function reviewList(items: readonly ChangeReview[]): ChangeReview[] {
  const offered = items.filter(canReviewAgain);
  return [...offered.filter(isMine), ...offered.filter(neverAsked)];
}

/** What the palette opens on: every command (`all`), or "Review a pull request…" (`review`). */
export type PaletteMode = "all" | "review";

/**
 * The palette's pull requests, of Reviews' list (`listedReviews`: none in a repository that is off, the person's own
 * included, ADR 0084): in "Review a pull request…" (`review`) those `reviewList` keeps, else every one.
 */
export function paletteReviews(state: State, mode: PaletteMode | null): ChangeReview[] {
  const listed = listedReviews(state);
  return mode === "review" ? reviewList(listed) : listed;
}

/**
 * The newest review failed (ADR 0081): the review screen's notice, above the round when there was one, whose verdict
 * and pill keep following the loop (ADR 0029). The commit it couldn't look over ("Couldn't look over b2e8d1f") and
 * why; under them, when, from the review's history ("3 min ago", kept apart from the commit, round 6), and what would
 * change it, or how likely another try works where that is known (`retryNote`), else nothing; null when the newest
 * review didn't fail.
 */
export function failedNotice(
  it: ChangeReview,
  now: number,
): { head: Words; sentence: string; when: string | null; next: string | null } | null {
  const { job, timeline } = it.review;
  if (job?.state !== "failed") return null;
  const at = timeline.findLast((t) => t.kind === "failed" && t.sha === job.sha)?.at;
  const { sentence, next } = failedWords(job.failure);
  return {
    head: failedHead({ commit: job.sha }),
    sentence,
    when: at === undefined ? null : agoSentence(now, at),
    next: next ?? retryNote(job.failure),
  };
}

/**
 * Whether the review page offers its review button (`reviewLabel`). Asked in person, a change skipped because nobody
 * asked is reviewed: another author's (ADR 0043), a fork's, by Claude (ADR 0048), or one opened with reviews on open
 * off. Not where only Codex reviews another author's change or a fork, skipped or never asked about (ADR 0078), not on
 * one never asked about in a repository switched off (`askable`), and not while a review runs or waits.
 */
export function canReviewAgain(it: ChangeReview): boolean {
  const s = status(it);
  if (s.kind === "skipped")
    return ASKED_IN_PERSON_REVIEWS[s.reason] && !(CLAUDE_ONLY[s.reason] && codexOnly(it));
  if (s.kind === "not-asked") return askable(it);
  return s.kind !== "running" && s.kind !== "waiting";
}

/**
 * Whether a request reviews a change skipped for each reason. The others wait for something else: a draft to be
 * marked ready, the repository turned on, Claude let review.
 */
const ASKED_IN_PERSON_REVIEWS = {
  "not-yours": true,
  fork: true,
  "on-open-off": true,
  draft: false,
  "repo-off": false,
  "codex-not-yours": false,
} as const satisfies Record<SkipReason, boolean>;

/** The skips only Claude may review when asked: Codex reviews only the owner's own changes from the repository. */
const CLAUDE_ONLY = {
  "not-yours": true,
  fork: true,
  "on-open-off": false,
  draft: false,
  "repo-off": false,
  "codex-not-yours": false,
} as const satisfies Record<SkipReason, boolean>;

function findingCount(n: number, kind: string): string {
  return `${n} ${kind} ${n === 1 ? "finding" : "findings"}`;
}

/** What an open review's line says of its findings: open on the pull request, or found by a preview (ADR 0072). */
const OPEN_HOW = { "to-fix": "open", preview: "found · nothing posted" } as const;

/** The findings left open, the blocking ones or else all, then where they are (`OPEN_HOW`). */
function openLine(it: ChangeReview, kind: keyof typeof OPEN_HOW): string {
  const { open, blocking } = openCounts(unsettledFindings(it.review));
  const what = blocking > 0 ? findingCount(blocking, "blocking") : plural(open, "finding");
  const line = `${what} ${OPEN_HOW[kind]}`;
  const commits = it.change.newCommits;
  return commits > 0 ? `${line} · ${plural(commits, "new commit")}` : line;
}

/**
 * The one line under a row's title that says where the review stands. A running review's time counts to `now`: the
 * screen's ticking now (ADR 0058), else the service's.
 */
export function statusLine(state: State, it: ChangeReview, now = state.now): string {
  const { review } = it;
  const s = status(it);
  switch (s.kind) {
    case "needs-you": {
      const n = review.findings.filter((f) => f.status === "escalated").length;
      return `${n} ${n === 1 ? "finding needs" : "findings need"} your decision`;
    }
    case "failed":
      return failureWords(s.failure).phrase;
    case "running":
      return runLine(now, review);
    case "waiting":
      return waitLine(state, it, s.deferral, s.turn);
    case "settled": {
      if (s.clean) return "no issues found";
      const kept = keptFindings(review).length;
      const closed = plural(review.findings.length - kept, "finding");
      const rounds = plural(review.rounds.length, "round");
      return kept > 0
        ? `${closed} closed in ${rounds} · ${keptText(kept)}`
        : `${closed}, all closed in ${rounds}`;
    }
    case "to-fix":
      return openLine(it, "to-fix");
    case "preview":
      return openLine(it, "preview");
    case "skipped":
      return skipText(s.reason);
    case "cancelled":
      return "cancelled";
    case "not-asked":
      return "not reviewed yet";
  }
}

/**
 * Whether the owner's coding agent works on the change in the loop (`lookover wait`): an agent wrote it, and it is
 * the owner's. An agent's change by another author has no loop of the owner's.
 */
export function inAgentLoop(change: Pick<Change, "author" | "writtenBy">): boolean {
  return change.writtenBy !== null && change.author !== "other";
}

/** Who acts next on a review that left findings to fix, said under its verdict. */
export function nextStep({ change, review }: ChangeReview): string {
  if (change.newCommits > 0) {
    return `${plural(change.newCommits, "new commit")} since this review. Review again to look at ${itOrThem(change.newCommits)}.`;
  }
  // A coding agent reads findings on GitHub only (ADR 0021): a preview gave it nothing to act on.
  if (review.preview) return "This was a preview: nothing was posted on GitHub. Review again to post it.";
  if (inAgentLoop(change)) return "The agent is working on it and will ask again.";
  return change.author === "other"
    ? "Review again once the author pushes fixes."
    : "Push your fixes, then review again.";
}

/**
 * Beside "Review again" while reviews are paused: the request is taken, and waits (ADR 0040). Null when a
 * request starts a review as usual.
 */
export function reviewAgainNote(state: State): string | null {
  const pausedFor = pauseUntil(state);
  return pausedFor ? `Reviews are paused: this one waits ${pausedFor}.` : null;
}

export interface RowAction {
  label: string;
  command: Command;
}

/**
 * At most one action per row, and never one that only opens the row: the row itself does that. Review again on
 * findings with new commits; Review now on another author's pull request never asked about, where a request
 * reviews it, as its page's button (`askable`, ADR 0078). An old skip of another's keeps its row as it was: no action.
 */
export function rowAction(it: ChangeReview): RowAction | null {
  const kind = status(it).kind;
  const request = { type: "review.request", changeId: it.change.id } as const;
  if ((kind === "to-fix" || kind === "preview") && it.change.newCommits > 0) {
    return { label: REVIEW_BUTTON.again, command: request };
  }
  if (kind === "not-asked" && neverAsked(it) && askable(it))
    return { label: REVIEW_BUTTON.now, command: request };
  return null;
}

export interface HomeGroups {
  /** Every row of the tab, grouped or not: what All reviews holds under it. */
  tab: ChangeReview[];
  needs: ChangeReview[];
  running: ChangeReview[];
  waiting: ChangeReview[];
  earlier: ChangeReview[];
  /** Everyone's only: other authors' pull requests nobody asked about. */
  notReviewed: ChangeReview[];
}

const EARLIER: DisplayStatus["kind"][] = ["to-fix", "settled", "skipped", "cancelled"];

/** Home's groups, of the person's pull requests (Mine) or of every open one (Everyone, ADR 0078). */
export function homeGroups(state: State, scope: Scope): HomeGroups {
  const all = inTab(scope, listedReviews(state));
  const kind = (i: ChangeReview) => status(i).kind;
  return {
    tab: all,
    notReviewed: all.filter((i) => kind(i) === "not-asked" && neverAsked(i)),
    // The Needs you filter's statuses: a preview's findings are on no pull request, only the owner reads them (ADR 0072).
    needs: all.filter((i) => FILTER_OF[kind(i)] === "needs"),
    running: all.filter((i) => kind(i) === "running"),
    // A review that waits runs by itself once the reason clears: it never looks broken (ADR 0029).
    waiting: all.filter((i) => kind(i) === "waiting"),
    earlier: all.filter((i) => EARLIER.includes(kind(i)) && isToday(state.now, i.review.updatedAt)),
  };
}

export interface Problem {
  id: string;
  /** The account it is of, by its login, when it is one account's own on the shared App (ADR 0066). */
  account?: string;
  tone: "need" | "warn";
  /** Short, for the pill. */
  short: string;
  title: string;
  /** One sentence; a code to type elsewhere in it as inline code. */
  detail: string | WithCommand;
  /** The sentence on the page its fix (`path`) leads to, where the band shows no button, when it differs. */
  detailHere?: string;
  /**
   * Its one fix: a command the service answers, a page to open (GitHub's, for what only GitHub can change), with the
   * code to `copy` as it opens when the page asks for one (Sign in again's), or the look sent as it opens when it is
   * the install page or an installation's settings (`LOOK`, ADR 0088), or a place in the app (`path`: what the owner
   * changes in Settings).
   */
  fix:
    | ({ label: string } & (
        | Exclude<FixAction, { href: string }>
        | { href: string; copy?: string; command?: AccountLink["command"] }
        | { path: string }
      ))
    | null;
  /**
   * Whether its fix's work is under way: a command fix waiting (a sign-in), or a link fix whose look runs (ADR 0088),
   * which says "Looking…" in its place until the look ends.
   */
  busy: boolean;
}

/** What a problem says and its fix, before its id, tone and pill words are known. */
type ProblemSaid = Omit<Problem, "id" | "tone" | "busy" | "short">;

function engineUsed(state: State, id: EngineId): boolean {
  const reviewers = state.settings.reviewers.value;
  return reviewers === "both" || reviewers === id;
}

/** A new sign-in to the shared App (ADR 0066): the one fix of a sign-in GitHub no longer takes. */
const SIGN_IN_AGAIN = { label: "Sign in again", command: { type: "connection.signIn" } } as const;

/** Reconnect, the band's button when no cause is named: the connection read again from the start. */
const RECONNECT = { label: "Reconnect GitHub", command: { type: "connection.reconnect" } } as const;

/**
 * What a connection that can't be used says, by its cause (ADR 0053), each with its one fix; its short line is the
 * status menu's words for the cause (`causeText`) after "GitHub".
 */
function causeProblem(connection: Connection, cause: ConnectionCause): Omit<Problem, "id" | "busy"> {
  return { short: `GitHub ${causeText(cause)}`, ...causeFix(connection, cause) };
}

/**
 * The App suspended, the whole connection held (ADR 0066): unsuspended where its repositories are chosen, the one
 * installation the person owns, else GitHub's install page, which lists every account.
 */
const suspendedFix = (connection: Connection): ProblemSaid => ({
  title: "Lookover's App is suspended on GitHub",
  detail: "Reviews cannot be read or posted until you unsuspend it on GitHub.",
  fix: { label: "Unsuspend it on GitHub", href: sharedRepositoriesLink(connection), command: LOOK },
});

/** Installed on none of the person's accounts any more (ADR 0066): the accounts list's first fix. */
const uninstalledFix = (connection: Connection): ProblemSaid => ({
  title: "Lookover's App is no longer installed",
  detail: `${SHARED_APP.slug} is installed on none of your GitHub accounts. Reviews cannot be read or posted until it is installed again.`,
  fix: installFirstFix(connection),
});

/** A problem said with its tone: whether it needs the person or only waits. */
type ProblemToned = ProblemSaid & Pick<Problem, "tone">;

/** What needs the person: every cause but one out of reach. */
const needs = (said: ProblemSaid): ProblemToned => ({ tone: "need", ...said });

/**
 * The rest of what a cause says, decided here once: its tone, its title, its detail and its one fix. Out of reach
 * only waits (ADR 0070), its tone `warn` and no fix; every other cause needs the person.
 */
function causeFix(connection: Connection, cause: ConnectionCause): ProblemToned {
  // Signed out: only a new sign-in brings it back (ADR 0066), its code shown on the connection once asked.
  if (saidSignedOut(cause))
    return needs({
      title: "You're signed out of GitHub",
      detail:
        "GitHub no longer takes your sign-in. Reviews cannot be read or posted until you sign in again.",
      fix: SIGN_IN_AGAIN,
    });
  if (cause.kind === "unreachable")
    // The poller and discovery try again every minute by themselves, so no button.
    return {
      tone: "warn",
      title: "GitHub can't be reached",
      detail: `Since ${clock(connection.since)}. Lookover tries again every minute. Nothing is lost.`,
      fix: null,
    };
  if (cause.kind === "uninstalled")
    return needs(cause.suspended ? suspendedFix(connection) : uninstalledFix(connection));
  // What is left is SSO.
  return needs({
    title: `${cause.organisation} asks you to sign in with SSO`,
    detail: `${cause.organisation} protects its repositories with single sign-on. Its reviews cannot be read or posted until you sign in there.`,
    fix: ssoFix(connection, cause.organisation, cause.url),
  });
}

function connectionProblem(connection: Connection, now: number): Problem {
  const said =
    connection.cause === null
      ? {
          // No cause named: not connected yet after setup, or a service that gave none.
          short: "GitHub disconnected",
          tone: "need" as const,
          title: "GitHub is disconnected",
          detail: `Lookover lost its access at ${clock(connection.since)}. Reviews cannot be read or posted.`,
          fix: RECONNECT,
        }
      : causeProblem(connection, connection.cause);
  return { id: "connection", busy: false, ...said, ...codeAsked(connection, now) };
}

/**
 * Signed out, once Sign in again gave a code (ADR 0066): the setup's sentence for it, and its one button, which copies
 * the code and opens GitHub's page; past its expiry and still shown, the code was taken and the sign-in finishes, Sign
 * in again waiting. Nothing to change otherwise.
 */
function codeAsked(
  { cause, signIn }: Connection,
  now: number,
): Pick<Problem, "detail" | "fix" | "busy"> | null {
  if (!saidSignedOut(cause) || signIn === null) return null;
  if (now >= signIn.expiresAt) return { detail: FINISHING, fix: SIGN_IN_AGAIN, busy: true };
  return {
    detail: waitingText(signIn.userCode, until(now, signIn.expiresAt)),
    fix: { label: SIGN_IN_TEXT.copy, href: signIn.verificationUri, copy: signIn.userCode },
    busy: false,
  };
}

/** GitHub's rate limit: Lookover waits until the time it gave, and nothing needs doing (ADR 0043). */
function connectionLimit(until: number): Problem {
  return {
    id: "connection",
    tone: "warn",
    short: "GitHub asks to wait",
    title: "GitHub asks Lookover to wait",
    detail: `Lookover checks GitHub again at ${clock(until)}. Nothing is lost.`,
    fix: null,
    busy: false,
  };
}

/**
 * One account the shared App reaches that can't be used now (ADR 0066), its other accounts still used, with its one
 * fix from the accounts list's table (ADR 0067, `accountFix`): SSO asked, said as the connection's would be; its
 * installation suspended, lifted by the person when they own the account, else by one of its owners (who suspended it
 * named when GitHub said); or gone, installed again by an owner. Its short line names the account, for the pill.
 */
function accountProblem(connection: Connection, a: ConnectionAccount, cause: AccountCause): Problem {
  const { login } = a.account;
  const said = { id: `account:${login}`, account: login, tone: "need", busy: false } as const;
  const fix = accountFix(connection, a, cause);
  if (cause.kind === "sso")
    return { ...said, ...causeProblem(connection, cause), short: `${login} needs SSO`, fix };
  const mine = ownsAccount(connection, a);
  const cannot = "Its repositories' reviews cannot be read or posted";
  if (!cause.suspended)
    return {
      ...said,
      short: `App uninstalled on ${login}`,
      title: `Lookover's App is no longer installed on ${login}`,
      detail: `${cannot} until ${mine ? "you install" : `an owner of ${login} installs`} it there again.`,
      fix,
    };
  const by = cause.suspendedBy === undefined ? "" : ` ${cause.suspendedBy} suspended it.`;
  return {
    ...said,
    short: `App suspended on ${login}`,
    title: `Lookover's App is suspended on ${login}`,
    detail: `${cannot} until ${mine ? "you unsuspend" : `an owner of ${login} unsuspends`} it on GitHub.${by}`,
    fix,
  };
}

/**
 * What GitHub's connection needs said: disconnected, or a wait GitHub asked for that isn't over; then each account
 * that holds a cause of its own, in GitHub's order.
 */
function connectionProblems(state: State): Problem[] {
  const { connection } = state;
  if (connection.state !== "connected")
    return [withLookBusy(connectionProblem(connection, state.now), connection)];
  const until = connection.limitUntil;
  const accounts = connection.accounts.flatMap((a) =>
    a.cause === null ? [] : [accountProblem(connection, a, a.cause)],
  );
  return [...(until !== null && until > state.now ? [connectionLimit(until)] : []), ...accounts].map((p) =>
    withLookBusy(p, connection),
  );
}

/**
 * A problem whose fix opens GitHub's install page or an installation's settings is busy while the look its link
 * starts runs (ADR 0088): "Looking…" in the fix's place, until the look ends; then the fix again.
 */
function withLookBusy(problem: Problem, connection: Connection): Problem {
  const { fix } = problem;
  const looks = fix !== null && "href" in fix && fix.command?.type === LOOK.type;
  return looks && lookRuns(connection) ? { ...problem, busy: true } : problem;
}

/**
 * What an AI that is not ready needs, said once with its one fix; null for one that is ready. One case a state.
 * Signed out or missing, the engine's own `detail` (why: Codex signed in with an API key, only npm's Node launcher
 * found) replaces the general line when it said one.
 */
function engineProblem(e: Engine, now: number): Problem | null {
  switch (e.state) {
    case "ready":
      return null;
    case "limit":
      return {
        id: e.id,
        tone: "warn",
        short: `${e.name} at its limit`,
        title: `${e.name} reached its limit`,
        detail: e.limitUntil ? `Reviews wait ${until(now, e.limitUntil)}.` : "Reviews wait until it resets.",
        fix: null,
        busy: false,
      };
    case "missing":
      return {
        id: e.id,
        tone: "need",
        short: `${e.name} needs attention`,
        title: `${e.name} is ${engineStateText(e)}`,
        // The service says why, with the command that installs it on this machine (ADR 0070).
        detail: e.detail,
        fix: ENGINE_CHECK_AGAIN,
        busy: false,
      };
    case "failed-self-test":
      return {
        id: e.id,
        tone: "need",
        short: `${e.name} needs attention`,
        title: deferralText({ reason: "engine-failed-self-test", engine: e.id }),
        detail: `${e.version ? `${e.cli} ${e.version}` : `This version of ${e.cli}`} changed something Lookover relies on, so its reviews wait. Update or downgrade it, then check again.`,
        fix: ENGINE_CHECK_AGAIN,
        busy: false,
      };
    case "self-test-unfinished":
      return {
        id: e.id,
        tone: "need",
        short: `${e.name} needs attention`,
        title: deferralText({ reason: "engine-self-test-unfinished", engine: e.id }),
        detail: `The check ended before it could tell either way: nothing failed. ${e.name}'s reviews wait until it passes.`,
        // The same command: it tests at once every engine whose program hasn't passed (ADR 0075).
        fix: ENGINE_TRY_AGAIN,
        busy: false,
      };
    case "signed-out":
      return {
        id: e.id,
        tone: "need",
        short: `${e.name} needs attention`,
        title: `${e.name} is signed out`,
        detail: e.signingIn
          ? `A terminal is open. Sign in there; this page checks every few seconds.`
          : e.detail || `Since ${clock(e.since)}. Sign in again in ${e.name}'s own window.`,
        fix: { label: "Sign in", command: { type: "engine.signIn", id: e.id } },
        busy: e.signingIn,
      };
  }
}

/**
 * Start at login not as the owner chose (ADR 0054): the machine refused to register it, or to remove it. Fixed in
 * Settings, by turning it off and on (or on and off), which asks the machine again. None in development, where
 * nothing is registered on the machine.
 */
function loginProblem(state: State): Problem | null {
  const { service } = state;
  if (!atLoginMismatch(service)) return null;
  const fix = { label: "Open Settings", path: "/settings#login" };
  return service.startAtLogin
    ? {
        id: "login",
        tone: "need",
        short: "Start at login refused",
        title: "This computer refused to start Lookover at login",
        detail: "Turn “Start at login” off and on in Settings to try again.",
        fix,
        busy: false,
      }
    : {
        id: "login",
        tone: "need",
        short: "Still starts at login",
        title: "This computer still starts Lookover at login",
        detail: "Turn “Start at login” on and off in Settings to try again.",
        fix,
        busy: false,
      };
}

/**
 * A problem as the band shows it on the page at `pathname`: no fix where the fix is a way to this very page
 * (Settings' "Open Settings" on Settings, #274), since the place to act is already in front of the owner, and its
 * sentence for that page (`detailHere`).
 */
export function bandOn(problem: Problem, pathname: string): Problem {
  const { fix, detailHere } = problem;
  if (!(fix && "path" in fix && fix.path.split("#")[0] === pathname)) return problem;
  return { ...problem, fix: null, detail: detailHere ?? problem.detail };
}

export function problems(state: State): Problem[] {
  if (!state.setup.done) return [];
  const engines = Object.values(state.engines)
    .filter((e) => engineUsed(state, e.id))
    .map((e) => engineProblem(e, state.now))
    .filter((p) => p !== null);
  // No problem says the service stopped: one that answers is running, and a stopped one can't be reached (ADR 0046).
  // Its start at login can be wrong, though: last, the machine's.
  const login = loginProblem(state);
  return [...connectionProblems(state), ...engines, ...(login ? [login] : [])];
}

/**
 * A status line's dot: green when what it says is fine, else its problem's tone, as the band says it (ADR 0070); grey
 * for an AI that doesn't review and isn't ready, since the band says nothing of it.
 */
export type StatusDot = "ok" | Problem["tone"] | "mute";

/**
 * One line of the status menu: its words ("Codex: signed out"), its dot and the problem it says with its one fix. An
 * account's problem on the shared App (ADR 0067) is a line of its own, at the level of every other.
 */
export interface StatusMenuLine {
  id: string;
  text: string;
  dot: StatusDot;
  problem: Problem | null;
  /** One of the lines that lead (a problem on it): the menu sets these apart from the fine ones. */
  leads: boolean;
}

/** A line's dot: green when it is fine, its problem's tone when it has one, amber when it is not fine with none. */
function dotOf(fine: boolean, problem: Problem | undefined): StatusDot {
  if (problem) return problem.tone;
  return fine ? "ok" : "warn";
}

/**
 * The status menu's lines: each AI, GitHub, the service, and each account's problem on the shared App. Each dot judges
 * its own words: GitHub's line says the connection only ("connected as sam", amber while GitHub asks to wait); an
 * account's problem is its own line, its dot and fix, never nested in GitHub's (2026-11-08: nested, it read as less
 * than the problem beside it). The lines with a problem lead, in the alert band's order, every one at one level; the
 * fine ones follow in the menu's: the AIs, GitHub, the service. An AI that doesn't review is grey, with them.
 */
export function statusMenuLines(state: State): StatusMenuLine[] {
  const list = problems(state);
  // `of`: the id of the problem the line says, its fix on the line.
  const line = (id: string, of: string, text: string, fine: boolean): StatusMenuLine => {
    const problem = list.find((p) => p.id === of);
    return { id, text, dot: dotOf(fine, problem), problem: problem ?? null, leads: false };
  };
  const { connection } = state;
  const accounts = list
    .filter((p) => p.account !== undefined)
    .map((p): StatusMenuLine => ({ id: p.id, text: p.title, dot: p.tone, problem: p, leads: false }));
  const service = serviceStatus(state.service);
  const lines = [
    ...Object.values(state.engines).map((e) => {
      const said = line(e.id, e.id, `${e.name}: ${engineStateText(e)}`, e.state === "ready");
      // Not one of the reviewers: no problem in the band, so none here; grey, among the fine lines.
      return engineUsed(state, e.id) || said.dot === "ok" ? said : { ...said, dot: "mute" as const };
    }),
    line("github", "connection", `GitHub: ${connectionText(connection)}`, connection.state === "connected"),
    ...accounts,
    line("service", "login", `Service: ${service.text}`, service.ok),
  ];
  const troubled = (l: StatusMenuLine) => l.dot !== "ok" && l.dot !== "mute";
  // The lines with a problem in the band's order, which they sit under; one not fine with none after them.
  const place = (l: StatusMenuLine) => {
    const at = l.problem ? list.indexOf(l.problem) : -1;
    return at === -1 ? list.length : at;
  };
  const first = lines
    .filter(troubled)
    .sort((a, b) => place(a) - place(b))
    .map((l) => ({ ...l, leads: true }));
  return [...first, ...lines.filter((l) => !troubled(l))];
}

/**
 * The status menu's two groups (design-system.md "Status pill menu"): the lines that lead, each in a well of its own,
 * then the fine ones in one well, headed "Fine" only under a problem (round 6: three wells of one weight read the green
 * group as a third problem); with no problem the menu's "Status" already says it, and with no fine line there is none.
 */
export function statusMenuGroups(lines: readonly StatusMenuLine[]): {
  leads: StatusMenuLine[];
  fine: StatusMenuLine[];
  fineHeading: string | null;
} {
  const leads = lines.filter((l) => l.leads);
  const fine = lines.filter((l) => !l.leads);
  return { leads, fine, fineHeading: leads.length > 0 && fine.length > 0 ? "Fine" : null };
}

/** Several problems said as one (ADR 0070): pink when any needs the person, amber when every one only waits. */
function worstTone(list: Problem[]): Problem["tone"] | null {
  if (list.length === 0) return null;
  return list.some((p) => p.tone === "need") ? "need" : "warn";
}

/**
 * The status pill: the band's colour (ADR 0070), pink when any problem needs the person, amber when every one left
 * only waits; several are counted, "waiting" unless one needs them. Then paused, then all good.
 */
export function pill(state: State): { tone: "ok" | "need" | "warn" | "mute"; label: string } {
  const list = problems(state);
  const tone = worstTone(list) ?? "warn";
  if (list.length > 1) {
    return { tone, label: `${list.length} things ${tone === "need" ? "need attention" : "waiting"}` };
  }
  const one = list[0];
  if (one) return { tone, label: one.short };
  if (state.service.paused) return { tone: "mute", label: "Paused" };
  return { tone: "ok", label: "All good" };
}

/** The counts under Home's sentence: "1 reviewing now · 2 waiting · 5 reviewed today · Codex ready". */
function counts(state: State, g: HomeGroups, reviewed: ChangeReview[], problemCount: number): string[] {
  const ready = Object.values(state.engines).filter((e) => e.state === "ready");
  const [onlyReady] = ready;
  return [
    g.running.length > 0 ? `${g.running.length} reviewing now` : null,
    g.waiting.length > 0 ? `${g.waiting.length} waiting` : null,
    reviewed.length > 0 ? `${reviewed.length} reviewed today` : null,
    problemCount > 0 && ready.length === 1 && onlyReady ? `${onlyReady.name} ready` : null,
  ].filter((part) => part !== null);
}

/** How long reviews stay paused ("until 09:52", "until you resume"), or null when they aren't. */
function pauseUntil(state: State): string | null {
  const pause = state.service.paused;
  if (!pause) return null;
  return `until ${pause.until ? clock(pause.until) : "you resume"}`;
}

export function sentence(state: State): { title: string; small: string } {
  // The sentence tells the person's day: their own pull requests, whatever scope Reviews shows.
  const g = homeGroups(state, "mine");
  const list = problems(state);
  const reviewed = listedReviews(state).filter(
    (i) => i.review.rounds.length > 0 && isToday(state.now, i.review.updatedAt),
  );
  const parts = counts(state, g, reviewed, list.length);
  const pausedFor = pauseUntil(state);
  // Under what needs you, a pause is still said: the pill and the band speak of the problem, not of it.
  const small = (pausedFor ? [`paused ${pausedFor}`, ...parts] : parts).join(" · ");

  // Problems are said once, by the alert band above every page (round 5: named here too, the pill, the band and the
  // headline said them three times). The headline speaks of the reviews: the person's own that need them, else
  // "Nothing else needs you." under a problem. A review waiting because of a listed problem is that problem's effect.
  const blocking = list.filter((p) => p.tone === "need");
  const own = g.needs;
  if (own.length > 0 && own.every((i) => status(i).kind === "preview")) {
    return { title: `${plural(own.length, "preview")} to read.`, small };
  }
  if (own.length > 0) {
    const n = own.length;
    return { title: `${n} pull ${n === 1 ? "request needs" : "requests need"} you.`, small };
  }
  if (blocking.length > 0) return { title: "Nothing else needs you.", small };
  if (pausedFor) return { title: "Reviews are paused.", small: [pausedFor, ...parts].join(" · ") };
  if (g.running.length > 0 || g.waiting.length > 0) return { title: "Nothing needs you.", small };
  const last = reviewed[0];
  return {
    title: "Nothing needs you.",
    small: last
      ? `${plural(reviewed.length, "pull request")} reviewed today, the last one ${agoSentence(state.now, last.review.updatedAt)}.`
      : "No pull request reviewed yet today.",
  };
}

/** "12 min", shown at the end of a finished row. */
function rowAge(state: State, it: ChangeReview): string {
  return ago(state.now, it.review.updatedAt);
}

/** A part of a row's meta line: the pull request (in mono), words, or the running round's step and its running time. */
export type RowMetaPart =
  | { kind: "change"; text: string }
  | { kind: "text"; text: string }
  | ({ kind: "running" } & RunLineParts);

/**
 * A review row's meta line, part by part: the pull request, who opened and wrote it, where its review stands (the
 * running step and its time, `now` the screen's ticking one), and how long ago for a finished one. The screen puts
 * one `SEPARATOR` between every two, and a part's own " · " is held the same way, so the line reads the same all
 * along and never wraps after a dot.
 */
export function rowMeta(state: State, it: ChangeReview, now = state.now): RowMetaPart[] {
  const s = status(it);
  const finished = s.kind === "settled" || s.kind === "skipped" || s.kind === "cancelled";
  return [
    { kind: "change", text: changeLabel(it.change) },
    { kind: "text", text: holdSeparators(authorLabel(it.change)) },
    s.kind === "running"
      ? { kind: "running", ...runLineParts(now, it.review) }
      : { kind: "text", text: holdSeparators(statusLine(state, it, now)) },
    ...(finished ? [{ kind: "text" as const, text: rowAge(state, it) }] : []),
  ];
}

/** The settings a repository has of its own, the ones its page says differ from the owner's defaults. */
export function differences(repo: Repository): SettingKey[] {
  const { settings } = repo;
  return Object.keys(settings)
    .filter((k): k is SettingKey => k in settings)
    .filter((k) => settings[k].origin === "owner-repository");
}

export function lastReviewAt(state: State, repoId: RepositoryId): number | null {
  let last: number | null = null;
  for (const i of changeReviews(state)) {
    if (i.change.repoId !== repoId) continue;
    for (const r of i.review.rounds) if (r.endedAt && (last === null || r.endedAt > last)) last = r.endedAt;
  }
  return last;
}
