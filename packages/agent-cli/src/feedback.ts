// `lookover feedback` (ADR 0052, 0077): the newest of the agent's person's checks of the pull request's head naming
// that pull request, read once, and Lookover's threads, so the agent sees what waits on it without parsing GitHub.
// Its exit says what the result means, as `wait`'s does.
import {
  type AgentThread,
  type CommitSha,
  type ReviewResult,
  SHARED_APP,
  shortSha,
} from "@lookover/contracts";
import type { FeedbackArgs } from "./args.ts";
import { changeOf } from "./change.ts";
import { ending, nobodyAsked, type Outcome } from "./wait.ts";
import { ourChecks, type Poster } from "./whose.ts";
import type { World } from "./world.ts";

/**
 * What `feedback` read: the outcome of the head's newest check, Lookover's threads when it holds a result, and who
 * posts as Lookover there: the shared App's bot, or the agent's person (ADR 0066); null before the account is read.
 */
export interface Feedback {
  outcome: Outcome;
  threads: AgentThread[];
  poster: Poster | null;
}

export async function feedback(args: FeedbackArgs, w: World): Promise<Feedback> {
  let commit: CommitSha | null = null;
  let number: number | null = null;
  const end = (
    meaning: Outcome["meaning"],
    message: string,
    result: ReviewResult | null = null,
  ): Outcome => ({
    meaning,
    message,
    commit,
    change: number,
    result,
  });
  const none = (outcome: Outcome): Feedback => ({ outcome, threads: [], poster: null });
  try {
    const host = await w.host();
    const change = await changeOf(host, w, args.pr);
    if (typeof change === "string") return none(end("error", change));
    number = change.number;
    const { head } = await host.getChange(change);
    commit = head;
    const at = `${shortSha(head)} (pull request #${number})`;
    const { id: me } = await host.account();
    // Nobody asked for an automatic skip: no answer, as `wait` reads it.
    const checks = (await ourChecks(host, change, head, me)).filter((c) => !nobodyAsked(c, false));
    const newest = checks.at(-1);
    if (newest === undefined) return none(end("no_review", `No review of ${at} yet: run lookover wait.`));
    const still = end("pending", `Lookover is still reviewing ${at}: run lookover wait.`);
    if (newest.status !== "completed") return none(still);
    const ended = ending(newest, { commit: head, end });
    if (ended === null) return none(still);
    const poster: Poster = { person: me };
    if (ended.result === null) return { outcome: ended, threads: [], poster };
    return { outcome: ended, threads: await host.threads(change, SHARED_APP.slug, me), poster };
  } catch (error) {
    return none(end("error", error instanceof Error ? error.message : String(error)));
  }
}
