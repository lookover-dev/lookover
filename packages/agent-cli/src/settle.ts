// `lookover settle <finding> <accepted|wrong> --confirmed-by-owner <reason>` (ADR 0101): the coding agent settles a
// finding on the person's word, through GitHub alone. Before posting, it reads the newest completed round of its own
// person's on the pull request's head (`ourChecks`), and refuses, posting nothing, only on a definite answer: that round
// has no such finding (in a complete result: a `truncated` one leaves findings out), keeps it off the pull request, or
// settled it; or a round is running on the head (its newest check in progress, as `wait` reads it). With no round on
// the head it posts (the agent's host lists no older commit's checks), and Lookover's answer says the rest.
// Then it posts the settle comment (`settleComment`) and waits for Lookover's answer on it, the reactions of its own
// person alone (Lookover posts as them; a teammate may react too): 🚀 settled and posted, 😕 refused (the newest
// result read again to say why, since a reaction carries none), or neither in time.
import {
  type AgentHost,
  type ChangeRef,
  decisionAsked,
  type FindingStatus,
  findingId,
  type ReviewResultFinding,
  readResult,
  settleComment,
  shortSha,
} from "@lookover/contracts";
import type { SettleArgs } from "./args.ts";
import { changeOf } from "./change.ts";
import { EXIT, nobodyAsked, span } from "./wait.ts";
import { ourChecks } from "./whose.ts";
import type { World } from "./world.ts";

/** How often the comment's reactions are read. */
const POLL_MS = 10_000;

/** What a 🚀 means, as `settle` says it. */
const DONE = {
  accepted: (id: string) => `${id} accepted as is on the owner's word. Run lookover wait.`,
  wrong: (id: string) => `${id} marked wrong on the owner's word. Run lookover wait.`,
} as const;

/** A settled status, as `settle` says how. */
const SETTLED: Record<Exclude<FindingStatus, "open" | "escalated">, string> = {
  verified_fixed: "verified fixed",
  acknowledged: "acknowledged",
  withdrawn: "withdrawn",
  dismissed: "marked wrong",
  accepted: "accepted as is",
  obsolete: "obsolete",
};

/**
 * What a settle reads on GitHub: the host, the pull request, the agent's own person (`me`, a numeric id: whose checks
 * count, and whose reactions are Lookover's, since Lookover posts as them: ADR 0066, 0073) and the finding.
 */
interface Standing {
  host: AgentHost;
  change: ChangeRef;
  me: number;
  finding: string;
}

/**
 * Why Lookover would refuse (or refused) to settle the finding, as the head's checks of the agent's person say it for
 * sure: a round running (the newest check not queued is in progress), or the newest done round not holding the finding, keeping it
 * off the pull request, or having settled it. Null when they say nothing for sure: no check on the head, none done, or the finding left out of
 * a result cut to fit GitHub's limit (`truncated`).
 */
async function inTheWay({ host, change, me, finding }: Standing): Promise<string | null> {
  const { head } = await host.getChange(change);
  const at = `${shortSha(head)} (pull request #${change.number})`;
  const checks = (await ourChecks(host, change, head, me)).filter((c) => !nobodyAsked(c, false));
  // Only the newest check that started runs, as `wait` and `feedback` read it: an older one left in progress was
  // abandoned (a sign-in change cancels a running review without telling GitHub), and a newer round has answered since.
  // A queued check hasn't started: a follow-up asked for during a round queues behind it and hides nothing.
  if (checks.findLast((c) => c.status !== "queued")?.status === "in_progress")
    return `Lookover is reviewing ${at}: run lookover wait, then settle ${finding} again on the same answer.`;
  const newest = checks.findLast((c) => c.status === "completed");
  const result = readResult(newest?.output.text ?? "");
  if (result?.run.state !== "done") return null;
  const found = result.findings.find((f) => f.id === finding);
  // A result cut to fit GitHub's byte limit leaves whole findings out: absence is definite only in a complete one.
  if (found === undefined && result.truncated) return null;
  if (found === undefined)
    return `Lookover's newest round on ${at} has no ${finding}: run lookover feedback to see its findings.`;
  return refusalOf(found);
}

/** Why the finding can't be settled, as the round's result says it; null when it can. */
function refusalOf(f: ReviewResultFinding): string | null {
  if (!f.posted)
    return `${f.id} isn't on the pull request: Lookover kept it off, so there is nothing to settle, and it doesn't hold the review open.`;
  if (f.status === "open" || f.status === "escalated") return null;
  return `${f.id} is settled already: ${SETTLED[f.status]}. Run lookover wait.`;
}

export async function settle(args: SettleArgs, w: World): Promise<number> {
  try {
    const host = await w.host();
    const change = await changeOf(host, w, args.pr);
    if (typeof change === "string") {
      w.err(change);
      return EXIT.error;
    }
    const { id: me } = await host.account();
    const standing: Standing = { host, change, me, finding: args.finding };
    const before = await inTheWay(standing);
    if (before !== null) {
      w.err(before);
      return EXIT.error;
    }
    const { finding, decision, reason } = args;
    const comment = await host.comment(
      change,
      settleComment({ finding: findingId(finding), decision, reason }),
    );
    w.err(
      `Asked Lookover to ${decisionAsked(decision, finding)}, on the owner's word (pull request #${change.number}).`,
    );
    return await answered(w, { ...standing, comment, args });
  } catch (error) {
    w.err(error instanceof Error ? error.message : String(error));
    return EXIT.error;
  }
}

/**
 * Waits for Lookover's 🚀 or 😕 on the comment `comment`, its person's (`me`) and no one else's, until the timeout;
 * the exit then.
 */
async function answered(w: World, posted: Standing & { comment: string; args: SettleArgs }): Promise<number> {
  const { host, change, comment, args } = posted;
  const until = w.clock.now() + args.timeoutMs;
  for (;;) {
    // Lookover's own reactions only: anyone who reads the pull request may put a 🚀 on the comment too.
    const ours = new Set(
      (await host.reactions(change.repo, comment)).filter((r) => r.by === posted.me).map((r) => r.reaction),
    );
    if (ours.has("rocket")) {
      w.err(DONE[args.decision](args.finding));
      return 0;
    }
    if (ours.has("confused")) {
      const why = await inTheWay(posted);
      w.err(
        `Lookover refused to settle ${args.finding}. ${why ?? "Run lookover feedback to see where it stands, and ask the person again if it still needs them."}`,
      );
      return EXIT.error;
    }
    if (w.clock.now() >= until) {
      w.err(await silence(posted, args.timeoutMs));
      return EXIT.error;
    }
    await w.sleep(Math.min(POLL_MS, until - w.clock.now()));
  }
}

/**
 * What no answer in time says: why Lookover would refuse it, when the newest result says (a 😕 owed when Lookover
 * stopped is never sent); else where to look.
 */
async function silence(standing: Standing, timeoutMs: number): Promise<string> {
  const head = `Lookover didn't answer the settle of ${standing.finding} in ${span(timeoutMs)}`;
  const why = await inTheWay(standing);
  if (why !== null) return `${head}. ${why}`;
  return `${head}: it may not be running (run lookover status). The owner can settle it in Lookover's app too (run lookover open).`;
}
