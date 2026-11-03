// What `lookover` reads on Lookover's threads (ADR 0052): the agent's newest reply on an unsettled finding's thread,
// which `wait` asks a round to answer; the threads of findings verified fixed, withdrawn or dismissed, which `wait`
// resolves with the agent's own login (the App can't, ADR 0074); Lookover's last reply on a thread, in words, which
// `feedback` shows.
import {
  type AgentHost,
  type AgentThread,
  type ChangeRef,
  type FindingStatus,
  HostError,
  isUnsettled,
  type ReviewResult,
  readReplyMarker,
  SHARED_APP,
  withoutWordmark,
} from "@lookover/contracts";
import { isLookovers, type Poster } from "./whose.ts";
import type { World } from "./world.ts";

/**
 * A person's reply on one of Lookover's threads, which `wait` asks a round to answer: its id, its finding, and when it
 * was written (ms).
 */
export interface ReplyToAnswer {
  commentId: number;
  findingId: string;
  at: number;
}

/**
 * The newest reply on the threads whose finding the round left unsettled, by a person and not Lookover's (a bot's
 * never asks, nor Lookover's own as its person); null when none.
 */
export function newestReply(
  threads: AgentThread[],
  result: ReviewResult,
  poster: Poster,
): ReplyToAnswer | null {
  const unsettled = new Set(result.findings.filter(isUnsettled).map((f) => f.id));
  const replies = threads
    .filter((t) => unsettled.has(t.findingId))
    .flatMap((t) =>
      t.replies
        .filter((r) => !r.author.bot && !isLookovers(r, poster))
        .map((r) => ({ commentId: r.commentId, findingId: t.findingId, at: Date.parse(r.at) })),
    )
    .filter((r) => !Number.isNaN(r.at))
    .sort((a, b) => a.at - b.at || a.commentId - b.commentId);
  return replies.at(-1) ?? null;
}

/**
 * Lookover's own last reply on the thread (its bot's, as `<app>[bot]`, or its person's with a reply marker), as words:
 * its wordmark opening and its hidden marker left out ("Kept\n\nwhy").
 */
export function lookoverReply(thread: AgentThread, poster: Poster): { body: string; at: string } | null {
  const last = thread.replies.findLast((r) => isLookovers(r, poster));
  if (!last) return null;
  return { body: withoutWordmark(readReplyMarker(last.body)?.text ?? last.body.trim()), at: last.at };
}

/** GitHub's words as the end of a sentence: one full stop, whether its message ends with one or not. */
const sentence = (words: string) => `${words.replace(/\.+\s*$/, "")}.`;

/** `F1`, `F1 and F3`, `F1, F2 and F3`. */
function listed(ids: string[]): string {
  return ids.length < 2 ? ids.join("") : `${ids.slice(0, -1).join(", ")} and ${ids.at(-1)}`;
}

/** Why `wait` resolves a settled finding's thread, as the end of its sentence, one finding or several. */
const SETTLED = {
  verified_fixed: ["Lookover verified it fixed.", "Lookover verified them fixed."],
  withdrawn: ["Lookover withdrew it.", "Lookover withdrew them."],
  dismissed: ["the owner dismissed it.", "the owner dismissed them."],
} satisfies Partial<Record<FindingStatus, [string, string]>>;

type Settled = keyof typeof SETTLED;
/** The settled statuses, in the order `wait` says them. */
const SAID_IN_ORDER: Settled[] = ["verified_fixed", "withdrawn", "dismissed"];
const isSettled = (status: FindingStatus): status is Settled => status in SETTLED;

/** Resolves the finding's threads still open: whether one was; a refusal said plainly. */
async function resolveOpen(
  host: AgentHost,
  w: Pick<World, "err">,
  threads: AgentThread[],
  id: string,
): Promise<boolean> {
  let resolved = false;
  for (const thread of threads.filter((t) => t.findingId === id && !t.resolved)) {
    try {
      await host.resolve(thread.threadId);
      resolved = true;
    } catch (error) {
      if (!(error instanceof HostError)) throw error;
      w.err(`Couldn't resolve the thread of ${id}: ${sentence(error.message)} Resolve it by hand.`);
    }
  }
  return resolved;
}

/**
 * Resolves, with the agent's login, the threads still open of the findings the round verified fixed, withdrew or
 * saw dismissed by the owner (ADR 0074: Lookover doesn't resolve them itself until it may), and says which on stderr,
 * by why; a refusal is said plainly, never an exit of its own. Reads the threads it is given.
 */
export async function resolveSettled(
  host: AgentHost,
  w: Pick<World, "err">,
  threads: AgentThread[],
  result: ReviewResult,
): Promise<void> {
  const resolved: Record<Settled, string[]> = { verified_fixed: [], withdrawn: [], dismissed: [] };
  for (const f of result.findings) {
    if (isSettled(f.status) && (await resolveOpen(host, w, threads, f.id))) resolved[f.status].push(f.id);
  }
  for (const status of SAID_IN_ORDER) {
    const ids = resolved[status];
    const [one, several] = SETTLED[status];
    if (ids.length === 1) w.err(`Resolved the thread of ${listed(ids)}: ${one}`);
    if (ids.length > 1) w.err(`Resolved the threads of ${listed(ids)}: ${several}`);
  }
}

/** Lookover's threads on the change, its bot's or its person's, or the host's refusal said on stderr and none. */
export async function readThreads(
  host: AgentHost,
  w: Pick<World, "err">,
  change: ChangeRef,
  { person }: Poster,
): Promise<AgentThread[] | null> {
  try {
    return await host.threads(change, SHARED_APP.slug, person);
  } catch (error) {
    if (!(error instanceof HostError)) throw error;
    w.err(`Couldn't read Lookover's threads: ${sentence(error.message)}`);
    return null;
  }
}
