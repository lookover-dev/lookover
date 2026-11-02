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
  githubLinks,
  type HostAccount,
  isUnsettled,
  ownInstallation,
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
import { accountFix, installFirstFix, ownsAccount, ssoFix } from "./accounts.ts";
import { adminOf, keyBand, RECONNECT } from "./app-key.ts";
import { deferralText, waitingNotice } from "./deferral.ts";
import { ago, agoSentence, clock, isToday, itOrThem, plural, until, type WithCommand } from "./format.ts";
import { accountText, causeText, connectionText, engineStateText } from "./health.ts";
import { runLine } from "./run.ts";
import { FINISHING, SIGN_IN_TEXT, waitingText } from "./sign-in.ts";
import { atLoginMismatch } from "./start-at-login.ts";
import { type DisplayStatus, displayStatus, FILTER_OF, failureText } from "./status.ts";

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

/** "sasensi/ledger-api": a repository with its owner, as Repositories lists every account's (ADR 0066). */
export function repositoryLabel(repo: Pick<Repository, "owner" | "name">): string {
  return `${repo.owner}/${repo.name}`;
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
export function writerName(change: Change): string | null {
  return change.writtenBy ? engineName(change.writtenBy) : null;
}

export function authorLabel(change: Change): string {
  const writer = writerName(change);
  if (writer) return `written by ${writer}`;
  return change.author === "you" ? `by ${change.openedBy}` : change.openedBy;
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
 * (ADR 0072).
 */
export function openVerdict(it: ChangeReview): string {
  const { open, blocking } = openCounts(unsettledFindings(it.review));
  const things = open === 1 ? "One thing" : `${open} things`;
  const how = it.review.preview ? "found" : "to fix";
  return `Looked over ${lookedOver(it)}. ${things} ${how}${blocking > 0 ? `, ${blocking} blocking` : ""}.`;
}

/** How many findings are open, of those given, and how many of them are blocking. */
export function openCounts(open: readonly Finding[]): { open: number; blocking: number } {
  return { open: open.length, blocking: open.filter((f) => f.severity === "blocking").length };
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
  waiting: { tone: "warn", label: "Waiting" },
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
 * one more, or showing the review that runs or waits. One place for each, so the page, its notes and the shortcut
 * list say the same words.
 */
export const REVIEW_BUTTON = {
  now: "Review now",
  again: "Review again",
  running: "Reviewing…",
  waiting: "Waiting…",
} as const;

export type ReviewButton = keyof typeof REVIEW_BUTTON;

/** What R does on a review, in the shortcut list: the review button, whichever it asks for. */
export const REVIEW_KEY = `${REVIEW_BUTTON.now} or again`;

/** Which label the review button shows: the review running or waiting, else what pressing it asks for. */
export function reviewButton(it: ChangeReview): ReviewButton {
  const { kind } = status(it);
  if (kind === "running" || kind === "waiting") return kind;
  return it.review.rounds.length === 0 ? "now" : "again";
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

const SKIP_WHY = {
  "not-yours": (it) =>
    claudeOnly(
      it,
      `By itself, Lookover reviews only the pull requests opened by you or by your coding agents. This one was opened by ${it.change.openedBy} and nobody asked for a review, so it was skipped.`,
      "To have it reviewed, comment",
    ),
  fork: (it) =>
    claudeOnly(
      it,
      "It comes from a fork, so its code could try to steer the reviewer. Lookover never reviews a pull request from a fork by itself, whoever opened it.",
      "To have Claude review it, comment",
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

/**
 * Whether the review page offers its review button (`reviewLabel`). Asked in person, a change skipped because nobody asked is reviewed:
 * another author's (ADR 0043), a fork's, by Claude (ADR 0048), or one opened with reviews on open off. Not where only
 * Codex reviews another author's change or a fork, and not while a review runs or waits.
 */
export function canReviewAgain(it: ChangeReview): boolean {
  const s = status(it);
  if (s.kind === "skipped")
    return ASKED_IN_PERSON_REVIEWS[s.reason] && !(CLAUDE_ONLY[s.reason] && codexOnly(it));
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
      return failureText(s.failure);
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

/** At most one action per row, and never one that only opens the row: the row itself does that. */
export function rowAction(it: ChangeReview): RowAction | null {
  const kind = status(it).kind;
  if ((kind === "to-fix" || kind === "preview") && it.change.newCommits > 0) {
    return { label: REVIEW_BUTTON.again, command: { type: "review.request", changeId: it.change.id } };
  }
  return null;
}

export interface HomeGroups {
  needs: ChangeReview[];
  running: ChangeReview[];
  waiting: ChangeReview[];
  earlier: ChangeReview[];
}

const EARLIER: DisplayStatus["kind"][] = ["to-fix", "settled", "skipped", "cancelled"];

export function homeGroups(state: State): HomeGroups {
  const all = changeReviews(state);
  const kind = (i: ChangeReview) => status(i).kind;
  return {
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
   * code to `copy` as it opens when the page asks for one (Sign in again's), or a place in the app (`path`: what the
   * owner changes in Settings).
   */
  fix:
    | ({ label: string } & (
        | Exclude<FixAction, { href: string }>
        | { href: string; copy?: string }
        | { path: string }
      ))
    | null;
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

/**
 * A refused or lost key's one fix (ADR 0070): Settings' GitHub group, where "Add a new key" and "Use an existing App"
 * are, said without "in Settings" on Settings itself (`detailHere`); Reconnect while no App is known, as there is no
 * page to make a key on, on the shared App, which has no key (ADR 0066), and for the clock.
 */
function keyFix(
  connection: Connection,
  cause: Extract<ConnectionCause, { kind: "key-refused" | "key-lost" }>,
): ProblemSaid {
  const inSettings = connection.way === "own" && connection.app !== null;
  const { title, detail, newKey } = keyBand(cause, inSettings ? "settings" : "reconnect");
  if (!newKey || !inSettings) return { title, detail, fix: RECONNECT };
  return {
    title,
    detail,
    detailHere: keyBand(cause, "here").detail,
    fix: { label: "Open Settings", path: "/settings#github" },
  };
}

/** "until an admin of acme unsuspends it on GitHub": who lifts a suspended installation's suspension. */
const unsuspendedBy = (admin: string | null): string =>
  `until ${admin === null ? "you unsuspend" : `${admin} unsuspends`} it on GitHub`;

/** The one fix of a suspended installation: its page on GitHub, where it is unsuspended. */
const unsuspendFix = (web: string, account: HostAccount, installationId: number) => ({
  label: "Unsuspend it on GitHub",
  href: githubLinks.installation(web, account, installationId),
});

/** The one fix of an App no longer installed: its install page on GitHub. */
const installFix = (web: string, slug: string) => ({
  label: "Install it on GitHub",
  href: githubLinks.install(web, slug),
});

/** "Check again" (ADR 0059): the person's `gh` read again, their membership with it. */
const CHECK_AGAIN = { label: "Check again", command: { type: "gh.check" } } as const;

/**
 * What a connection that can't be used says, by its cause (ADR 0053), each with its one fix; its short line is the
 * status menu's words for the cause (`causeText`) after "GitHub".
 */
function causeProblem(connection: Connection, cause: ConnectionCause): Omit<Problem, "id" | "busy"> {
  return { short: `GitHub ${causeText(cause)}`, ...causeFix(connection, cause) };
}

/** The App's installation suspended: "you" unsuspend it, or an admin of its organisation. */
function suspendedFix({ app, web, accounts }: Connection): ProblemSaid {
  const installation = ownInstallation(accounts);
  return {
    title: "Lookover's App is suspended on GitHub",
    detail: `Reviews cannot be read or posted ${unsuspendedBy(adminOf(app?.account))}.`,
    fix:
      app && installation !== undefined
        ? unsuspendFix(web, app.account, installation.installationId)
        : RECONNECT,
  };
}

/**
 * The App no longer installed on its account: your GitHub account, or an organisation, whose admin installs it. On
 * the shared App (ADR 0066), installed on none of the person's accounts any more: the accounts list's first fix.
 */
function uninstalledFix(connection: Connection): ProblemSaid {
  const { app, web, way } = connection;
  if (way === "shared")
    return {
      title: "Lookover's App is no longer installed",
      detail: `${SHARED_APP.slug} is installed on none of your GitHub accounts. Reviews cannot be read or posted until it is installed again.`,
      fix: installFirstFix(connection),
    };
  const admin = adminOf(app?.account);
  const until = admin === null ? "it is installed again" : `${admin} installs it again`;
  return {
    title: "Lookover's App is no longer installed",
    detail: `${app?.slug ?? "The App"} was removed from ${app ? accountText(app) : "your GitHub account"}. Reviews cannot be read or posted until ${until}.`,
    fix: app ? installFix(web, app.slug) : RECONNECT,
  };
}

/** A problem said with its tone: whether it needs the person or only waits. */
type ProblemToned = ProblemSaid & Pick<Problem, "tone">;

/** What needs the person: every cause but one out of reach. */
const needs = (said: ProblemSaid): ProblemToned => ({ tone: "need", ...said });

/**
 * The rest of what a cause says, decided here once: its tone, its title, its detail and its one fix. Out of reach
 * only waits (ADR 0070), its tone `warn` and no fix; every other cause needs the person.
 */
function causeFix(connection: Connection, cause: ConnectionCause): ProblemToned {
  switch (cause.kind) {
    case "unreachable":
      // The poller and discovery try again every minute by themselves, so no button.
      return {
        tone: "warn",
        title: "GitHub can't be reached",
        detail: `Since ${clock(connection.since)}. Lookover tries again every minute. Nothing is lost.`,
        fix: null,
      };
    case "uninstalled":
      return needs(cause.suspended ? suspendedFix(connection) : uninstalledFix(connection));
    case "key-refused":
    case "key-lost":
      return needs(keyFix(connection, cause));
    case "not-a-member":
      return needs({
        title: `You're no longer a member of ${cause.organisation}`,
        detail: `Your gh says you aren't an active member of ${cause.organisation}, so Lookover stopped reviewing. Once an admin adds you back, check again.`,
        fix: CHECK_AGAIN,
      });
    case "signed-out":
      // Only a new sign-in brings it back (ADR 0066): its code shows on the connection once asked.
      return needs({
        title: "You're signed out of GitHub",
        detail:
          "GitHub no longer takes your sign-in. Reviews cannot be read or posted until you sign in again.",
        fix: SIGN_IN_AGAIN,
      });
    case "sso":
      return needs({
        title: `${cause.organisation} asks you to sign in with SSO`,
        detail: `${cause.organisation} protects its repositories with single sign-on. Its reviews cannot be read or posted until you sign in there.`,
        fix: ssoFix(connection, cause.organisation, cause.url),
      });
  }
}

function connectionProblem(connection: Connection, now: number): Problem {
  const said =
    connection.cause === null
      ? {
          // No cause named: not connected yet after setup, or a service that gave none.
          short: "GitHub disconnected",
          tone: "need" as const,
          title: "GitHub is disconnected",
          detail: `Your App lost its access at ${clock(connection.since)}. Reviews cannot be read or posted.`,
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
  if (cause?.kind !== "signed-out" || signIn === null) return null;
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
  if (connection.state !== "connected") return [connectionProblem(connection, state.now)];
  const until = connection.limitUntil;
  const accounts = connection.accounts.flatMap((a) =>
    a.cause === null ? [] : [accountProblem(connection, a, a.cause)],
  );
  return [...(until !== null && until > state.now ? [connectionLimit(until)] : []), ...accounts];
}

/**
 * What an AI that is not ready needs, said once with its one fix; null for one that is ready. One case a state.
 * Signed out or missing, the engine's own `detail` (why: Codex signed in with an API key, only npm's Node launcher
 * found) replaces the general line when it said one.
 */
function engineProblem(e: Engine, now: number): Problem | null {
  const checkAgain = { label: "Check again", command: { type: "engine.check" } } as const;
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
        fix: checkAgain,
        busy: false,
      };
    case "failed-self-test":
      return {
        id: e.id,
        tone: "need",
        short: `${e.name} needs attention`,
        title: deferralText({ reason: "engine-failed-self-test", engine: e.id }),
        detail: `${e.version ? `${e.cli} ${e.version}` : `This version of ${e.cli}`} changed something Lookover relies on, so its reviews wait. Update or downgrade it, then check again.`,
        fix: checkAgain,
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
 * The status menu's GitHub line (ADR 0067): what the connection is ("connected as sam"), whether its dot is on (a
 * wait GitHub asked for is no fault: only a cause turns it off), its colour when off (the pill's, `worstTone`), and
 * every GitHub problem under it, each with its one fix: the connection's, then each account's, in GitHub's order.
 */
export function githubStatus(state: State): {
  ok: boolean;
  text: string;
  tone: Problem["tone"] | null;
  problems: Problem[];
} {
  const { connection } = state;
  const list = problems(state).filter((p) => p.id === "connection" || p.account !== undefined);
  return {
    ok: connection.state === "connected" && list.every((p) => p.account === undefined),
    text: connectionText(connection),
    tone: worstTone(list),
    problems: list,
  };
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
  const g = homeGroups(state);
  const list = problems(state);
  const reviewed = changeReviews(state).filter(
    (i) => i.review.rounds.length > 0 && isToday(state.now, i.review.updatedAt),
  );
  const parts = counts(state, g, reviewed, list.length);
  const pausedFor = pauseUntil(state);
  // Under what needs you, a pause is still said: the pill and the band speak of the problem, not of it.
  const small = (pausedFor ? [`paused ${pausedFor}`, ...parts] : parts).join(" · ");

  // Problems are said by the alert band above every page; Home counts them with the pull requests.
  // A review waiting because of a listed problem is that problem's effect, not one more thing to do.
  const blocking = list.filter((p) => p.tone === "need");
  const own = g.needs;
  if (own.length > 0 && blocking.length === 0 && own.every((i) => status(i).kind === "preview")) {
    const n = own.length;
    return { title: `${plural(n, "preview")} to read.`, small };
  }
  if (own.length > 0 && blocking.length === 0) {
    const n = own.length;
    return { title: `${n} pull ${n === 1 ? "request needs" : "requests need"} you.`, small };
  }
  if (own.length + blocking.length > 0) {
    const n = own.length + blocking.length;
    return { title: `${n} ${n === 1 ? "thing needs" : "things need"} you.`, small };
  }
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
export function rowAge(state: State, it: ChangeReview): string {
  return ago(state.now, it.review.updatedAt);
}

/** The settings a repository has of its own, the ones its page says differ from the owner's defaults. */
export function differences(repo: Repository): SettingKey[] {
  const { settings } = repo;
  return Object.keys(settings)
    .filter((k): k is SettingKey => k in settings)
    .filter((k) => settings[k].origin === "owner-repository");
}

export function openChangeCount(state: State, repoId: RepositoryId): number {
  return Object.values(state.changes).filter((p) => p.repoId === repoId).length;
}

export function lastReviewAt(state: State, repoId: RepositoryId): number | null {
  let last: number | null = null;
  for (const i of changeReviews(state)) {
    if (i.change.repoId !== repoId) continue;
    for (const r of i.review.rounds) if (r.endedAt && (last === null || r.endedAt > last)) last = r.endedAt;
  }
  return last;
}
