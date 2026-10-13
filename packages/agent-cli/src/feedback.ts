// `lookover feedback` (ADR 0052): the newest check of the pull request's head, read once, and Lookover's threads,
// so the agent sees what waits on it without parsing GitHub. Its exit says what the result means, as `wait`'s does.
import { type AgentThread, type CommitSha, type ReviewResult, shortSha } from "@lookover/contracts";
import type { FeedbackArgs } from "./args.ts";
import { changeOf } from "./change.ts";
import { ending, nobodyAsked, type Outcome } from "./wait.ts";
import type { World } from "./world.ts";

/** What `feedback` read: the outcome of the head's newest check, and Lookover's threads when it holds a result. */
export interface Feedback {
  outcome: Outcome;
  threads: AgentThread[];
}

export async function feedback(args: FeedbackArgs, app: string, w: World): Promise<Feedback> {
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
  const none = (outcome: Outcome): Feedback => ({ outcome, threads: [] });
  try {
    const host = await w.host();
    const change = await changeOf(host, w, args.pr);
    if (typeof change === "string") return none(end("error", change));
    number = change.number;
    const { head } = await host.getChange(change);
    commit = head;
    const at = `${shortSha(head)} (pull request #${number})`;
    // Nobody asked for an automatic skip: no answer, as `wait` reads it.
    const checks = (await host.checks(change.repo, head, app)).filter((c) => !nobodyAsked(c, false));
    const newest = checks.at(-1);
    if (newest === undefined) return none(end("no_review", `No review of ${at} yet: run lookover wait.`));
    const still = end("pending", `Lookover is still reviewing ${at}: run lookover wait.`);
    if (newest.status !== "completed") return none(still);
    const ended = ending(newest, { commit: head, end });
    if (ended === null) return none(still);
    return { outcome: ended, threads: ended.result ? await host.threads(change, app) : [] };
  } catch (error) {
    return none(end("error", error instanceof Error ? error.message : String(error)));
  }
}
