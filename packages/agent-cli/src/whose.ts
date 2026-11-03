// Whose Lookover the agent reads (ADR 0066, 0073). Under the one App, the shared App, several people's Lookovers may
// post, each as its person: the agent takes only the checks naming its own account (their `external_id`,
// `<job>@<person's id>`), never another person's, nor one naming nobody. Its Lookover posts as the agent's own
// person: its threads are the shared App's bot's or that person's, and its replies the bot's, or that person's holding
// a reply marker, the fallback ADR 0066 leaves the agent with no outbox; a person's own reply holds none.
import {
  type AgentCheck,
  type HostThreadReply,
  readCheckExternalId,
  readReplyMarker,
  SHARED_APP,
} from "@lookover/contracts";

/** The person a check's external id names; null when it names none. */
const personOf = (check: AgentCheck): number | null => readCheckExternalId(check.externalId)?.person ?? null;

/** The checks of the agent's own person among the App's, in their order: those naming `me`, and no other. */
export function mine<C extends AgentCheck>(checks: C[], me: number): C[] {
  return checks.filter((c) => personOf(c) === me);
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
