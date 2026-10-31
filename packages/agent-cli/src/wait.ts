// `lookover wait` (ADR 0021, ADR 0043, ADR 0052): the commit from local git, its pull request, a request posted
// only when nobody asked about that commit, then the App's check of that exact commit read every 10 s until it
// completes, the pull request moves past the commit, nothing appears in time, or the wait runs out. A completed
// round is asked past when someone replied on an unsettled finding's thread since it started; else the threads of
// the findings it verified fixed are resolved.
import {
  type AgentChange,
  type AgentCheck,
  type AgentHost,
  type AgentThread,
  type ChangeRef,
  type CommitSha,
  type HostCheck,
  type HostComment,
  type ReviewResult,
  readRequest,
  readResult,
  requestedCommit,
  reviewRequest,
  shortSha,
} from "@lookover/contracts";
import type { WaitArgs } from "./args.ts";
import { branchChange } from "./change.ts";
import { newestReply, type ReplyToAnswer, readThreads, resolveVerified } from "./threads.ts";
import { ours, posterOf } from "./whose.ts";
import type { World } from "./world.ts";

/** What the exit says, each with its code (exploration 05 §11.3, ADR 0043). `8` stays unused: `gh`'s "pending". */
export const EXIT = {
  nothing_to_fix: 0,
  error: 1,
  usage: 2,
  fix: 3,
  ask_human: 4,
  timed_out: 5,
  // `feedback`: the newest check of the head is still running.
  pending: 5,
  skipped: 6,
  failed: 7,
  no_review: 9,
  newer_commit: 10,
} as const satisfies Record<string, number>;

type Meaning = keyof typeof EXIT;

/** How the wait ended: what it means, a sentence for the person reading stderr, and what it read. */
export interface Outcome {
  meaning: Meaning;
  message: string;
  commit: CommitSha | null;
  /** The number of the change (the pull request) it waited on, once known. */
  change: number | null;
  /** The result block of the check that ended the wait, when one did. */
  result: ReviewResult | null;
  /** Why it was skipped when no check said so: `fork`, a fork's pull request, never asked for (ADR 0048). */
  skip?: "fork";
}

/** How often the check is read. */
const POLL_MS = 10_000;
/** How often stderr says the wait goes on. */
const HEARTBEAT_MS = 30_000;
/** How long the pull request may take to show a pushed commit (GitHub's REST lagged about 3 s, spike 03). */
const PUSH_SHOWN_MS = 15_000;
const PUSH_RETRY_MS = 3_000;

/** `90_000` as `1m30s`. */
function span(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const [h, m, s] = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60];
  return [h ? `${h}h` : "", m ? `${m}m` : "", s || seconds === 0 ? `${s}s` : ""].join("");
}

/** The findings that need the agent, blocking first. */
export function forTheAgent(result: ReviewResult | null): ReviewResult["findings"] {
  const order = { blocking: 0, should_fix: 1, consider: 2 } as const;
  return (result?.findings ?? [])
    .filter((f) => f.needs_action_by === "agent")
    .sort((a, b) => order[a.severity] - order[b.severity]);
}

export async function wait(args: WaitArgs, app: string, w: World): Promise<Outcome> {
  let commit: CommitSha | null = null;
  let number: number | null = null;
  const end = (meaning: Meaning, message: string, result: ReviewResult | null = null): Outcome => ({
    meaning,
    message,
    commit,
    change: number,
    result,
  });
  try {
    const host = await w.host();
    commit = await w.git.head();
    const repo = await w.git.origin();
    const found = args.pr ?? (await branchChange(host, w, repo));
    if (typeof found === "string") return end("error", found);
    number = found;
    const change: ChangeRef = { repo, number };
    const pushed = await shown(host, w, change, commit);
    if (typeof pushed === "string") return end("error", pushed);
    const unasked = (): Outcome => ({
      ...end(
        "skipped",
        `Pull request #${number} comes from a fork: Lookover reviews it only when the owner asks, so lookover wait asks nothing. Ask the owner.`,
      ),
      skip: "fork",
    });
    const { id: me } = await host.account();
    const unasking = pushed.fork ? unasked : null;
    return await follow(host, w, { args, app, me, change, commit, end, unasked: unasking });
  } catch (error) {
    // A host's refusal (`HostError`, its message saying what GitHub answered), git, or no token.
    return end("error", error instanceof Error ? error.message : String(error));
  }
}

/** The pull request once it shows the commit; why not, after `PUSH_SHOWN_MS`. */
async function shown(
  host: AgentHost,
  w: World,
  change: ChangeRef,
  commit: CommitSha,
): Promise<AgentChange | string> {
  const until = w.clock.now() + PUSH_SHOWN_MS;
  for (;;) {
    const read = await host.getChange(change);
    const { head } = read;
    if (head === commit) return read;
    if (w.clock.now() >= until)
      return `Pull request #${change.number} is at ${shortSha(head)}, not at your ${shortSha(commit)}: push first.`;
    await w.sleep(PUSH_RETRY_MS);
  }
}

interface Following {
  args: WaitArgs;
  app: string;
  /** The agent's own account's id: its person's checks are the ones read (`ours`). */
  me: number;
  change: ChangeRef;
  commit: CommitSha;
  end: (meaning: Meaning, message: string, result?: ReviewResult | null) => Outcome;
  /**
   * A fork's pull request (ADR 0048): reviewed only when the owner asks, so `wait` never posts a request (posted as
   * the agent's login, which may be the owner's, it would ask for them). A review the owner asked for is followed;
   * with no check and no request, this ends the wait. Null for the repository's own pull requests.
   */
  unasked: (() => Outcome) | null;
}

/**
 * The agent's own requests naming the commit: its account's only. A colleague's asks their Lookover, never the
 * agent's (a service follows its owner's requests alone), so neither it nor its reactions answer for the agent.
 */
const requestsFor = (comments: HostComment[], commit: CommitSha, me: number) =>
  comments.filter((c) => c.author.id === me && requestedCommit(c.body) === commit);

/** What one read showed: the agent's person's checks of the commit (`ours`), oldest first, and its requests naming it. */
interface Read {
  checks: AgentCheck[];
  requests: HostComment[];
}

/** The triggers nobody asked with: Lookover saw the pull request open or move by itself. */
const AUTOMATIC = new Set(["opened", "push"]);
/**
 * The skip rules (`core.intake`'s) `wait` asks past, as the result's `state_reason` names them. Not `fork`: a fork's
 * pull request is reviewed only when the owner asks by hand (ADR 0048), so its skip is the answer, reported (6),
 * unless a request names the commit.
 */
const SKIP_RULES = new Set(["not_yours", "draft", "repo_off", "on_open_off"]);

/**
 * A check a skip rule completed when nobody asked: an automatic trigger skipped (ADR 0043: "Not your pull request"
 * on a colleague's pull request when it opened). It answers no request, so `wait` asks anyway and reads the check
 * of the review its request leads to; it is no sign Lookover is running either.
 */
export function nobodyAsked(check: HostCheck, requested: boolean): boolean {
  if (check.status !== "completed") return false;
  const run = readResult(check.output.text)?.run;
  if (run?.state !== "skipped" || run.trigger === undefined || !AUTOMATIC.has(run.trigger)) return false;
  const rule = run.state_reason ?? "";
  // A fork's opening skip answers no request either: once someone (the owner) asked, the review asked for is the
  // answer, even while the service hasn't read the request yet.
  return SKIP_RULES.has(rule) || (requested && rule === "fork");
}

/**
 * The agent's person's checks and the requests now, less the checks nobody asked for; the requests read again only
 * while no check showed, or no newer one since a reply was asked about (for the 👀).
 */
async function read(
  host: AgentHost,
  { app, me, change, commit }: Following,
  before?: Read,
  answering: Answering | null = null,
): Promise<Read> {
  const all = ours(await host.checks(change.repo, commit, app), me);
  const shown = before !== undefined && appeared(before, answering);
  const requests = shown ? before.requests : requestsFor(await host.comments(change), commit, me);
  return { checks: all.filter((c) => !nobodyAsked(c, requests.length > 0)), requests };
}

/**
 * A reply the agent asked a round to answer (ADR 0052): only a check whose round read it answers (`readIt`); the
 * request came after the reply, and a round reads the threads once it starts.
 */
interface Answering {
  reply: ReplyToAnswer;
  /**
   * The ids of the agent's person's checks of the commit when it asked: one not among them is a sign Lookover has
   * the request. Ids, not a count: the first check naming the agent replaces those naming nobody (`ours`).
   */
  checks: Set<string>;
  /** When it asked, by the clock: the appear timeout runs from then. */
  askedAt: number;
}

/** Whether a check of the agent's person appeared since the reply was asked about (any check, when none was). */
function appeared(now: Read, answering: Answering | null): boolean {
  return answering === null ? now.checks.length > 0 : now.checks.some((c) => !answering.checks.has(c.id));
}

/** When the check's round started (else ended), in ms, as its result says; null when it says neither. */
function startOf(check: HostCheck): number | null {
  const run = readResult(check.output.text)?.run;
  const at = Date.parse(run?.started_at ?? run?.completed_at ?? "");
  return Number.isNaN(at) ? null : at;
}

/**
 * Whether the completed check's round read the reply. A check that appeared since the reply was asked about did: its
 * round started after the request, so after the reply. Else the finding's claim says, in GitHub's time like the
 * reply's: a claim as new as the reply (the reply itself) was read, an older one means it wasn't. Only a finding with
 * no claim falls back to the round's start, by the service's clock; a check that says no time read it (no hang).
 */
function readIt(check: HostCheck, reply: ReplyToAnswer, appearedSinceAsked: boolean): boolean {
  if (appearedSinceAsked) return true;
  const claim = readResult(check.output.text)?.findings.find((f) => f.id === reply.findingId)?.claim;
  const claimed = Date.parse(claim?.at ?? "");
  if (!Number.isNaN(claimed)) return claimed >= reply.at;
  const start = startOf(check);
  return start === null || start >= reply.at;
}

/** Whether the newest check, completed, answers what was asked: any does, but a reply's only a round that read it. */
function answers(now: Read, check: HostCheck, answering: Answering | null): boolean {
  return answering === null || readIt(check, answering.reply, appeared(now, answering));
}

/**
 * What a judged read leads to: the wait's end (with Lookover's threads when a round ended and they could be read),
 * or a reply newer than the round, to ask a round for (`asked`: a request naming it is there already); null to
 * keep waiting.
 */
type Step = { end: Outcome; threads: AgentThread[] | null } | { again: ReplyToAnswer; asked: boolean } | null;

/** Asks for the commit's review when nobody did and no check is on it; the wait's end on a fork's, which never asks. */
async function begin(host: AgentHost, w: World, f: Following, now: Read): Promise<Outcome | null> {
  const at = `${shortSha(f.commit)} (pull request #${f.change.number})`;
  if (now.checks.length > 0 || now.requests.length > 0) {
    w.err(`Waiting for Lookover on ${at}.`);
    return null;
  }
  if (f.unasked) return f.unasked();
  await host.comment(f.change, reviewRequest(f.commit));
  w.err(`Asked Lookover to review ${at}.`);
  return null;
}

async function follow(host: AgentHost, w: World, f: Following): Promise<Outcome> {
  let now = await read(host, f);
  const unasked = await begin(host, w, f, now);
  if (unasked !== null) return unasked;

  const start = w.clock.now();
  let beat = start;
  let answering: Answering | null = null;
  for (;;) {
    const step = await judge(host, w, now, { start, answering }, f);
    if (step !== null && "end" in step) return await ended(host, w, step);
    if (step !== null) answering = await askAgain(host, w, f, step, now);
    if (w.clock.now() - beat >= HEARTBEAT_MS) {
      beat = w.clock.now();
      const title = titleOf(now, answering);
      w.err(`Still waiting for Lookover on ${shortSha(f.commit)}: ${title} (${span(beat - start)}).`);
    }
    await w.sleep(POLL_MS);
    now = await read(host, f, now, answering);
  }
}

/** The wait's end, once the threads of the findings its round verified fixed are resolved. */
async function ended(host: AgentHost, w: World, step: Extract<Step, { end: Outcome }>): Promise<Outcome> {
  const { result } = step.end;
  if (step.threads !== null && result !== null) await resolveVerified(host, w, step.threads, result);
  return step.end;
}

/** Asks a round to answer the reply, unless a request names it already; what the wait answers to then. */
async function askAgain(
  host: AgentHost,
  w: World,
  f: Following,
  { again, asked }: Extract<Step, { again: ReplyToAnswer }>,
  now: Read,
): Promise<Answering> {
  const yours = `your reply on ${again.findingId} (${shortSha(f.commit)}, pull request #${f.change.number})`;
  if (!asked) await host.comment(f.change, reviewRequest(f.commit, { reply: again.commentId }));
  w.err(asked ? `Waiting for Lookover to answer ${yours}.` : `Asked Lookover to answer ${yours}.`);
  return { reply: again, checks: new Set(now.checks.map((c) => c.id)), askedAt: w.clock.now() };
}

/** What the heartbeat says of the newest check: its title, unless it answers nothing asked. */
function titleOf(now: Read, answering: Answering | null): string {
  const newest = now.checks.at(-1);
  if (newest && (newest.status !== "completed" || answers(now, newest, answering)))
    return newest.output.title;
  return answering ? "no check of your reply yet" : "no check yet";
}

/** The wait so far: when it began, and the reply it asked a round to answer, if it did. */
interface Since {
  start: number;
  answering: Answering | null;
}

/** How the wait ends after what this read showed, or a reply to ask about; null to keep waiting. */
async function judge(host: AgentHost, w: World, now: Read, since: Since, f: Following): Promise<Step> {
  const { args, change, commit, end } = f;
  const { answering } = since;
  const at = `${shortSha(commit)} (pull request #${change.number})`;
  const newest = now.checks.at(-1);
  if (newest?.status === "completed" && answers(now, newest, answering)) {
    const ended = ending(newest, f);
    // The round answered the reply asked about when it appeared since: that reply asks nothing more.
    const answered = answering !== null && appeared(now, answering) ? answering.reply : null;
    if (ended !== null) return await roundEnd(host, w, f, ended, newest, answered);
  }
  const { head } = await host.getChange(change);
  if (head !== commit)
    return {
      end: end(
        "newer_commit",
        `Pull request #${change.number} moved on to ${shortSha(head)}: run lookover wait for it.`,
      ),
      threads: null,
    };
  const waited = w.clock.now() - since.start;
  const appearing = w.clock.now() - (answering?.askedAt ?? since.start);
  const seen =
    appeared(now, answering) ||
    now.requests.some(
      (r) =>
        r.reactions.eyes > 0 &&
        (answering === null || readRequest(r.body)?.reply === answering.reply.commentId),
    );
  if (!seen && appearing >= args.appearMs)
    return {
      end: end(
        "no_review",
        `No review appeared for ${at} in ${span(appearing)}: is Lookover running? Run lookover status.`,
      ),
      threads: null,
    };
  if (waited >= args.timeoutMs)
    return {
      end: end(
        "timed_out",
        `No result for ${at} after ${span(waited)}: run lookover wait again to keep waiting.`,
      ),
      threads: null,
    };
  return null;
}

/**
 * A completed check's end, once its round is read with Lookover's threads: a reply the agent wrote on an unsettled
 * finding's thread that the round didn't read (`readIt`) asks for another round on the same commit (never on a
 * fork's pull request, ADR 0048); else the end stands, with the threads to resolve. `answered`: the reply this round
 * was asked for and answered, which asks nothing more.
 */
async function roundEnd(
  host: AgentHost,
  w: World,
  f: Following,
  ended: Outcome,
  check: AgentCheck,
  answered: ReplyToAnswer | null,
): Promise<Step> {
  const { result } = ended;
  if (result === null || result.run.state !== "done") return { end: ended, threads: null };
  // Lookover's threads are its bot's, or on the shared App the check's person's: whom its Lookover posts as (ADR 0066).
  const poster = posterOf(f.app, check);
  const threads = await readThreads(host, w, f.change, poster);
  if (threads === null) return { end: ended, threads: null };
  const reply = f.unasked ? null : newestReply(threads, result, poster);
  if (reply === null || readIt(check, reply, reply.commentId === answered?.commentId))
    return { end: ended, threads };
  const requests = requestsFor(await host.comments(f.change), f.commit, f.me).filter(
    (c) => readRequest(c.body)?.reply === reply.commentId,
  );
  if (requests.some(handled) || (requests.length > 0 && startedSince(check, reply)))
    return { end: ended, threads };
  return { again: reply, asked: requests.length > 0 };
}

/**
 * Whether the request's round is posted (🚀): it answered the request, so it asks nothing more. 👀 alone is only
 * recorded, before its round runs: the round is still coming, so the wait follows its check (ADR 0043).
 */
const handled = (request: HostComment): boolean => request.reactions.rocket > 0;

/**
 * Whether the check's round started after the reply, by the service's clock: it read the threads once the reply was
 * there. Asked only once a request naming the reply is there, so a reply the claim doesn't carry (a colleague's)
 * waits on no second round of a later `wait`.
 */
function startedSince(check: HostCheck, reply: ReplyToAnswer): boolean {
  const start = startOf(check);
  return start !== null && start >= reply.at;
}

/** What a completed check means, or null when it says to keep waiting. */
export function ending(check: HostCheck, { commit, end }: Pick<Following, "commit" | "end">): Outcome | null {
  const result = readResult(check.output.text);
  const at = shortSha(commit);
  if (result === null)
    return end("error", `Lookover's check on ${at} ended without a result this lookover can read.`);
  // Skipped for a newer commit or a newer review (`wait`): the head comparison or the newer check says what next.
  if (result.loop.next_action === "wait") return null;
  if (result.run.state === "skipped" || result.run.state === "cancelled")
    return end("skipped", `Lookover skipped ${at}. ${check.output.title}.`, result);
  if (result.run.state === "failed")
    return end("failed", `Lookover couldn't review ${at}. ${check.output.title}.`, result);
  const findings = forTheAgent(result).length;
  switch (result.loop.next_action) {
    case "stop":
      return end("nothing_to_fix", `Lookover: nothing to fix on ${at}.`, result);
    case "fix":
    case "reply":
      return end(
        "fix",
        findings === 1
          ? `Lookover: 1 finding to fix on ${at}.`
          : `Lookover: ${findings} findings to fix on ${at}.`,
        result,
      );
    case "ask_human":
      return end("ask_human", `Lookover: a person is needed on ${at}.`, result);
  }
}
