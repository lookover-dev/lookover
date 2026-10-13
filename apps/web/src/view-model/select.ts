// The view model: read-only views of the snapshot, what Home, the status pill and the rows show.
import {
  asSentence,
  type Change,
  CODEX_REVIEWS,
  type Command,
  type Connection,
  type ConnectionCause,
  type Deferral,
  type Engine,
  type EngineId,
  engineName,
  type Finding,
  type FixAction,
  githubLinks,
  isUnsettled,
  type KeyRefusal,
  type Repository,
  type RepositoryId,
  type Review,
  type Reviewers,
  type SettingKey,
  type SkipReason,
  type State,
  shortSha,
  skipText,
  type Turn,
} from "@lookover/contracts";
import type { Tone } from "../ui/basics.tsx";
import { deferralText, waitingNotice } from "./deferral.ts";
import { ago, agoSentence, clock, isToday, itOrThem, plural, until } from "./format.ts";
import { accountText, causeText, engineStateText } from "./health.ts";
import { runLine } from "./run.ts";
import { atLoginMismatch } from "./start-at-login.ts";
import { type DisplayStatus, displayStatus, failureText } from "./status.ts";

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

/** The change at a page address: repository name and number, as in "/reviews/ledger-api/148". */
export function changeReviewAt(
  state: State,
  repoName: string | undefined,
  number: string | undefined,
): ChangeReview | null {
  return (
    changeReviews(state).find((i) => i.repo.name === repoName && String(i.change.number) === number) ?? null
  );
}

/** "ledger-api #148" */
export function changeLabel(change: Change): string {
  return `${change.repoId.split("/")[1]} #${change.number}`;
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
 * The pull requests setup's first review offers: the owner's, in a repository that is on. Never another author's,
 * nor one from a fork, whoever opened it (ADR 0048): neither is reviewed unless asked by hand.
 */
export function firstReviewCandidates(state: State): ChangeReview[] {
  return changeReviews(state).filter(
    (it) => it.repo.enabled && it.change.author !== "other" && !it.change.fork,
  );
}

/** The AI reviewing now, or the one that reviewed last. */
export function reviewerOf(review: Review): EngineId | null {
  return review.run?.reviewer ?? review.rounds.at(-1)?.reviewer ?? null;
}

export function status(it: ChangeReview): DisplayStatus {
  return displayStatus(it.review);
}

export function chip(it: ChangeReview): { tone: Tone; label: string } {
  const s = status(it);
  switch (s.kind) {
    case "needs-you":
      return { tone: "need", label: "Needs you" };
    case "failed":
      return { tone: "need", label: "Failed" };
    case "running":
      return { tone: "run", label: `Round ${s.round}` };
    case "waiting":
      return { tone: "warn", label: "Waiting" };
    case "settled":
      return { tone: "ok", label: s.clean ? "Clean" : "Settled" };
    case "to-fix":
      // Findings open: the ball is with the author.
      return { tone: "warn", label: "To fix" };
    case "skipped":
      return { tone: "mute", label: "Skipped" };
    case "cancelled":
      return { tone: "mute", label: "Cancelled" };
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

function openLine(it: ChangeReview): string {
  const open = unsettledFindings(it.review);
  const blocking = open.filter((f) => f.severity === "blocking").length;
  const kind = blocking > 0 ? findingCount(blocking, "blocking") : plural(open.length, "finding");
  const commits = it.change.newCommits;
  return commits > 0 ? `${kind} open · ${plural(commits, "new commit")}` : `${kind} open`;
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
      return openLine(it);
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
  if (status(it).kind === "to-fix" && it.change.newCommits > 0) {
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
    needs: all.filter((i) => kind(i) === "needs-you" || kind(i) === "failed"),
    running: all.filter((i) => kind(i) === "running"),
    // A review that waits runs by itself once the reason clears: it never looks broken (ADR 0029).
    waiting: all.filter((i) => kind(i) === "waiting"),
    earlier: all.filter((i) => EARLIER.includes(kind(i)) && isToday(state.now, i.review.updatedAt)),
  };
}

export interface Problem {
  id: string;
  tone: "need" | "warn";
  /** Short, for the pill. */
  short: string;
  title: string;
  detail: string;
  /**
   * Its one fix: a command the service answers, a page to open (GitHub's, for what only GitHub can change), or a
   * place in the app (`path`: what the owner changes in Settings).
   */
  fix: ({ label: string } & (FixAction | { path: string })) | null;
  busy: boolean;
}

function engineUsed(state: State, id: EngineId): boolean {
  const reviewers = state.settings.reviewers.value;
  return reviewers === "both" || reviewers === id;
}

const RECONNECT = { label: "Reconnect GitHub", command: { type: "connection.reconnect" } } as const;

/** "Add a new key": the App's page on GitHub, where a new key is generated; Reconnect while no App is known. */
function newKey(connection: Connection): Problem["fix"] {
  const { app, web } = connection;
  return app ? { label: "Add a new key", href: githubLinks.app(web, app.account, app.slug) } : RECONNECT;
}

/** Where a new key goes once generated: said by every cause a new key fixes. */
const GIVE_IT = "then give it in Settings, under “Use an existing App”.";

/**
 * What a refused key says, by what GitHub named. `can`: who may generate a key on an organisation's App, " (an admin
 * of acme can)"; empty on a personal App, the person's own.
 */
const keyRefusedText = (can: string): Record<KeyRefusal | "unknown", string> => ({
  revoked: `The key was revoked on GitHub. Generate a new one on the App's page${can}, ${GIVE_IT}`,
  "app-deleted": `GitHub says the App was deleted. If it still is on the App's page, generate a new key there${can}, ${GIVE_IT}`,
  clock: "This computer's clock is off, so GitHub can't trust the key. Set the clock right, then reconnect.",
  unknown: `It may have been revoked, or the App deleted. Generate a new key on the App's page${can}, ${GIVE_IT}`,
});

/** "an admin of acme" on an organisation's App (ADR 0059): who changes it on GitHub. Null on a personal App. */
function adminOf(app: Connection["app"]): string | null {
  return app?.account.type === "Organization" ? `an admin of ${app.account.login}` : null;
}

/** "Check again" (ADR 0059): the person's `gh` read again, their membership with it. */
const CHECK_AGAIN = { label: "Check again", command: { type: "gh.check" } } as const;

/**
 * What a connection that can't be used says, by its cause (ADR 0053), each with its one fix; its short line is the
 * status menu's words for the cause (`causeText`) after "GitHub".
 */
function causeProblem(connection: Connection, cause: ConnectionCause): Omit<Problem, "id" | "tone" | "busy"> {
  return { short: `GitHub ${causeText(cause)}`, ...causeFix(connection, cause) };
}

/** The App's installation suspended: "you" unsuspend it, or an admin of its organisation. */
function suspendedFix({
  app,
  web,
  installationId,
}: Connection): Omit<Problem, "id" | "tone" | "busy" | "short"> {
  const admin = adminOf(app);
  return {
    title: "Lookover's App is suspended on GitHub",
    detail: `Reviews cannot be read or posted until ${admin === null ? "you unsuspend" : `${admin} unsuspends`} it on GitHub.`,
    fix:
      app && installationId !== null
        ? {
            label: "Unsuspend it on GitHub",
            href: githubLinks.installation(web, app.account, installationId),
          }
        : RECONNECT,
  };
}

/** The App no longer installed on its account: your GitHub account, or an organisation, whose admin installs it. */
function uninstalledFix({ app, web }: Connection): Omit<Problem, "id" | "tone" | "busy" | "short"> {
  const admin = adminOf(app);
  const until = admin === null ? "it is installed again" : `${admin} installs it again`;
  return {
    title: "Lookover's App is no longer installed",
    detail: `${app?.slug ?? "The App"} was removed from ${app ? accountText(app) : "your GitHub account"}. Reviews cannot be read or posted until ${until}.`,
    fix: app ? { label: "Install it on GitHub", href: githubLinks.install(web, app.slug) } : RECONNECT,
  };
}

/** The rest of what a cause says: its title, its detail and its one fix. */
function causeFix(
  connection: Connection,
  cause: ConnectionCause,
): Omit<Problem, "id" | "tone" | "busy" | "short"> {
  const admin = adminOf(connection.app);
  const can = admin === null ? "" : ` (${admin} can)`;
  switch (cause.kind) {
    case "unreachable":
      return {
        title: "GitHub can't be reached",
        detail: `Since ${clock(connection.since)}. Reviews cannot be read or posted until it answers.`,
        fix: RECONNECT,
      };
    case "uninstalled":
      return cause.suspended ? suspendedFix(connection) : uninstalledFix(connection);
    case "key-refused":
      return {
        title: "GitHub refused the App's key",
        detail: keyRefusedText(can)[cause.why ?? "unknown"],
        // A clock that is off is fixed on this computer: a new key wouldn't help.
        fix: cause.why === "clock" ? RECONNECT : newKey(connection),
      };
    case "key-lost":
      return {
        title: "Lookover can't open the App's key",
        detail: `Its entry in this computer's keychain is gone. Generate a new key on the App's page${can}, ${GIVE_IT}`,
        fix: newKey(connection),
      };
    case "not-a-member":
      return {
        title: `You're no longer a member of ${cause.organisation}`,
        detail: `Your gh says you aren't an active member of ${cause.organisation}, so Lookover stopped reviewing. Once an admin adds you back, check again.`,
        fix: CHECK_AGAIN,
      };
  }
}

function connectionProblem(connection: Connection): Problem {
  const said =
    connection.cause === null
      ? {
          // No cause named: not connected yet after setup, or a service that gave none.
          short: "GitHub disconnected",
          title: "GitHub is disconnected",
          detail: `Your App lost its access at ${clock(connection.since)}. Reviews cannot be read or posted.`,
          fix: RECONNECT,
        }
      : causeProblem(connection, connection.cause);
  return { id: "connection", tone: "need", busy: false, ...said };
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

/** What GitHub's connection needs said: disconnected, or a wait GitHub asked for that isn't over. */
function connectionProblems(state: State): Problem[] {
  const { connection } = state;
  if (connection.state !== "connected") return [connectionProblem(connection)];
  const until = connection.limitUntil;
  return until !== null && until > state.now ? [connectionLimit(until)] : [];
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
        detail:
          e.detail || `The ${e.cli} program was not found on this computer. Install it, then check again.`,
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
 * A problem's fix as the band shows it on the page at `pathname`: none where the fix is a way to this very page
 * (Settings' "Open Settings" on Settings, #274), since the place to act is already in front of the owner.
 */
export function fixOn(problem: Problem, pathname: string): Problem["fix"] {
  const { fix } = problem;
  if (fix && "path" in fix && fix.path.split("#")[0] === pathname) return null;
  return fix;
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

export function pill(state: State): { tone: "ok" | "warn" | "mute"; label: string } {
  const list = problems(state);
  if (list.length > 1) return { tone: "warn", label: `${list.length} things need attention` };
  const one = list[0];
  if (one) return { tone: "warn", label: one.short };
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
