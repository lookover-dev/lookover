// What `lookover` reads on Lookover's threads (ADR 0052): the agent's newest reply on an unsettled finding's thread,
// which `wait` asks a round to answer; the threads of findings verified fixed, which `wait` resolves with the agent's
// own login (the App can't); Lookover's last reply on a thread, which `feedback` shows.
import {
  type AgentHost,
  type AgentThread,
  type ChangeRef,
  HostError,
  isUnsettled,
  type ReviewResult,
  readReplyMarker,
} from "@lookover/contracts";
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

/** The newest of the threads whose finding the round left unsettled, by a person (a bot's never asks); null when none. */
export function newestReply(threads: AgentThread[], result: ReviewResult): ReplyToAnswer | null {
  const unsettled = new Set(result.findings.filter(isUnsettled).map((f) => f.id));
  const replies = threads
    .filter((t) => unsettled.has(t.findingId))
    .flatMap((t) =>
      t.replies
        .filter((r) => !r.author.bot)
        .map((r) => ({ commentId: r.commentId, findingId: t.findingId, at: Date.parse(r.at) })),
    )
    .filter((r) => !Number.isNaN(r.at))
    .sort((a, b) => a.at - b.at || a.commentId - b.commentId);
  return replies.at(-1) ?? null;
}

/** Lookover's own last reply on the thread (a bot's, as `<app>[bot]`), its hidden marker left out. */
export function lookoverReply(thread: AgentThread, app: string): { body: string; at: string } | null {
  const last = thread.replies.findLast((r) => r.author.bot && r.author.login === `${app}[bot]`);
  if (!last) return null;
  return { body: readReplyMarker(last.body)?.text ?? last.body.trim(), at: last.at };
}

/** GitHub's words as the end of a sentence: one full stop, whether its message ends with one or not. */
const sentence = (words: string) => `${words.replace(/\.+\s*$/, "")}.`;

/** `F1`, `F1 and F3`, `F1, F2 and F3`. */
function listed(ids: string[]): string {
  return ids.length < 2 ? ids.join("") : `${ids.slice(0, -1).join(", ")} and ${ids.at(-1)}`;
}

/**
 * Resolves, with the agent's login, the threads of the findings the round verified fixed that are still open, and
 * says which on stderr; a refusal is said plainly, never an exit of its own. Reads the threads it is given.
 */
export async function resolveVerified(
  host: AgentHost,
  w: Pick<World, "err">,
  threads: AgentThread[],
  result: ReviewResult,
): Promise<void> {
  const resolved: string[] = [];
  for (const f of result.findings.filter((x) => x.status === "verified_fixed")) {
    for (const thread of threads.filter((t) => t.findingId === f.id && !t.resolved)) {
      try {
        await host.resolve(thread.threadId);
        if (!resolved.includes(f.id)) resolved.push(f.id);
      } catch (error) {
        if (!(error instanceof HostError)) throw error;
        w.err(`Couldn't resolve the thread of ${f.id}: ${sentence(error.message)} Resolve it by hand.`);
      }
    }
  }
  if (resolved.length === 1) w.err(`Resolved the thread of ${listed(resolved)}: Lookover verified it fixed.`);
  if (resolved.length > 1)
    w.err(`Resolved the threads of ${listed(resolved)}: Lookover verified them fixed.`);
}

/** Lookover's threads on the change, or the host's refusal said on stderr and none. */
export async function readThreads(
  host: AgentHost,
  w: Pick<World, "err">,
  change: ChangeRef,
  app: string,
): Promise<AgentThread[] | null> {
  try {
    return await host.threads(change, app);
  } catch (error) {
    if (!(error instanceof HostError)) throw error;
    w.err(`Couldn't read Lookover's threads: ${sentence(error.message)}`);
    return null;
  }
}
