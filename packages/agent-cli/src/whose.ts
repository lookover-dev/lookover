// Whose Lookover the agent reads (ADR 0066). Under one App several people's Lookovers may post, each as its person on
// the shared App: the agent takes the checks naming its own account (their `external_id`, `<job>@<person's id>`),
// else those naming nobody (made before checks named their person), never another person's. On the shared App alone
// a check's person is whom its Lookover posts as: its threads are the App's bot's or that person's, and its replies
// the bot's, or that person's holding a reply marker, the fallback ADR 0066 leaves the agent with no outbox; a
// person's own reply holds none. An own App's Lookover posts only as its bot, whoever its checks name: the holder's
// own comments, markers or not, are never Lookover's there.
import {
  type AgentCheck,
  type HostThreadReply,
  readCheckExternalId,
  readReplyMarker,
  SHARED_APP,
} from "@lookover/contracts";

/** The person a check's external id names; null when it names none. */
const personOf = (check: AgentCheck): number | null => readCheckExternalId(check.externalId)?.person ?? null;

/** The checks of the agent's own person among the App's, in their order: those naming `me`, else those naming nobody. */
export function ours<C extends AgentCheck>(checks: C[], me: number): C[] {
  const mine = checks.filter((c) => personOf(c) === me);
  return mine.length > 0 ? mine : checks.filter((c) => personOf(c) === null);
}

/** Who posts as Lookover on a change: the App's bot, by its slug, and the person it posts as (null for none). */
export interface Poster {
  app: string;
  person: number | null;
}

/** Whether Lookover posts as a person under the App: on the shared App only. */
const postsAsPerson = (app: string): boolean => app === SHARED_APP.slug;

/** Who posts as Lookover for the round of `check`: the App's bot, and on the shared App the check's person. */
export const posterOf = (app: string, check: AgentCheck): Poster => ({
  app,
  person: postsAsPerson(app) ? personOf(check) : null,
});

/** Who posts as Lookover for the agent's own person `me`: the App's bot, and on the shared App `me`. */
export const posterFor = (app: string, me: number): Poster => ({
  app,
  person: postsAsPerson(app) ? me : null,
});

/** Whether the reply is Lookover's: its App's bot's, or the person's it posts as with a reply marker. */
export function isLookovers(reply: HostThreadReply, { app, person }: Poster): boolean {
  const { author } = reply;
  if (author.bot) return author.login === `${app}[bot]`;
  return person !== null && author.id === person && readReplyMarker(reply.body) !== null;
}
