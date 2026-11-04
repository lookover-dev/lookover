// Whose Lookover the agent reads (ADR 0066, 0073). Under the one App, the shared App, several people's Lookovers may
// post, each as its person, and one head may be two pull requests' (ADR 0077): the agent takes only the checks naming
// its own account and its pull request (their `external_id`, `<job>#<number>@<person's id>`), never another person's
// or another pull request's, nor one naming nobody or no pull request. Its Lookover posts as the agent's own
// person: its threads are the shared App's bot's or that person's, and its replies the bot's, or that person's holding
// a reply marker, the fallback ADR 0066 leaves the agent with no outbox; a person's own reply holds none.
import {
  type AgentCheck,
  type AgentHost,
  type ChangeRef,
  type CommitSha,
  checkIsFor,
  type HostThreadReply,
  readReplyMarker,
  SHARED_APP,
} from "@lookover/contracts";

/**
 * The agent's checks of the commit `commit`, in the host's order: the shared App's naming its own person `me`
 * and the pull request `change`, and no other.
 */
export async function ourChecks(
  host: AgentHost,
  change: ChangeRef,
  commit: CommitSha,
  me: number,
): Promise<AgentCheck[]> {
  const checks = await host.checks(change.repo, commit, SHARED_APP.slug);
  return checks.filter((c) => checkIsFor(c.externalId, me, change.number));
}

/** Who Lookover posts as on a change, besides the shared App's bot: the agent's own person. */
export interface Poster {
  person: number;
}

/** Whether the reply is Lookover's: the shared App's bot's, or the person's it posts as with a reply marker. */
export function isLookovers(reply: HostThreadReply, { person }: Poster): boolean {
  const { author } = reply;
  if (author.bot) return author.login === `${SHARED_APP.slug}[bot]`;
  return author.id === person && readReplyMarker(reply.body) !== null;
}
