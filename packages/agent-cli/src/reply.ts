// `lookover reply <finding> <claim> <text>` (ADR 0052): the agent's answer on the finding's thread, as its own login,
// its first line opened in the grammar Lookover reads (exploration 05 §7.1). A finding with no thread (in the status
// block only) takes no claim: refused, nothing posted. Lookover's threads are the shared App's bot's or the agent's own
// person's (ADR 0066, 0073); never another person's.
import { type AgentHost, type ChangeRef, newestThread, readResult, SHARED_APP } from "@lookover/contracts";
import { CLAIMS, type ReplyArgs } from "./args.ts";
import { changeOf } from "./change.ts";
import { EXIT } from "./wait.ts";
import { mine } from "./whose.ts";
import type { World } from "./world.ts";

export async function reply(args: ReplyArgs, w: World): Promise<number> {
  try {
    const host = await w.host();
    const change = await changeOf(host, w, args.pr);
    if (typeof change === "string") {
      w.err(change);
      return EXIT.error;
    }
    // The agent's own person: the checks it reads name its account alone (`mine`), and Lookover posts as it.
    const { id: me } = await host.account();
    const thread = newestThread(await host.threads(change, SHARED_APP.slug, me), args.finding);
    if (thread === undefined) {
      w.err(await noThread(host, change, me, args.finding));
      return EXIT.error;
    }
    await host.reply(change, thread.commentId, `${CLAIMS[args.claim].opening}: ${args.text}`);
    w.err(`Replied on ${args.finding}'s thread: ${thread.url}. Run lookover wait to have it answered.`);
    return 0;
  } catch (error) {
    w.err(error instanceof Error ? error.message : String(error));
    return EXIT.error;
  }
}

/**
 * Why the finding has no thread: in the status block only, as the head's newest result of the agent's person says, or
 * none Lookover has.
 */
async function noThread(host: AgentHost, change: ChangeRef, me: number, id: string): Promise<string> {
  const { head } = await host.getChange(change);
  const newest = mine(await host.checks(change.repo, head, SHARED_APP.slug), me).findLast(
    (c) => c.status === "completed",
  );
  const found = readResult(newest?.output.text ?? "")?.findings.find((f) => f.id === id);
  if (found?.placement === "status")
    return `${id} is in the status block only, in the pull request's description: it has no thread, so it takes no reply. Fix it, or ask the owner to dismiss it.`;
  return `Lookover has no thread for ${id} on pull request #${change.number}.`;
}
