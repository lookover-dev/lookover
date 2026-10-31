// Reading Lookover's threads (ADR 0052, ADR 0048): what the change's author and the owner claim about the findings,
// from the replies on the threads whose root comment is Lookover's.
import {
  type Claim,
  type ClaimKind,
  type Finding,
  type FindingClaim,
  type HostThread,
  type HostThreadReply,
  isUnsettled,
  readReplyMarker,
} from "@lookover/contracts";

/**
 * What a round read on the findings' threads: per finding, the newest claim not answered yet, as the finding stores
 * it, with the finding it is on. At most one per finding, in the ledger's order.
 */
export interface ThreadReading {
  claims: (Claim & FindingClaim)[];
}

/**
 * Whose replies are claims, by the host's numeric account id: the owner's, and the change's author's unless the
 * change comes from a fork (ADR 0048: anyone else's text never reaches an engine); never a bot's, the author a bot
 * included. Never Lookover's own (`lookovers`):
 * signed in on the shared App, it posts as the owner (ADR 0066).
 */
export interface Claimants {
  owner: { id: number };
  author: { id: number };
  fork: boolean;
  lookovers: LookoversReply;
}

/** Whether a reply on one of Lookover's threads is Lookover's own (`lookoversReply`). */
export type LookoversReply = (reply: HostThreadReply) => boolean;

/**
 * Lookover's reply (ADR 0066): one whose id it kept for the change, in any round, else one by who posts (`poster`: the
 * App's bot, or the person signed in on the shared App) holding a reply marker, for a post a crash kept no id of. A
 * teammate's copied marker never passes: they can't write as who posts; a person's own reply holds no marker. With no
 * `poster` (null: not asked, there being no thread to read), only the kept ids.
 */
export function lookoversReply(kept: Iterable<number>, poster: { id: number } | null): LookoversReply {
  const ids = new Set(kept);
  return (reply) =>
    ids.has(reply.commentId) ||
    (poster !== null && reply.author.id === poster.id && readReplyMarker(reply.body) !== null);
}

/** How a reply's first line opens, per claim; anything else is a question. Lowercase, one space between words. */
const OPENINGS = {
  claimed_fixed: ["fixed"],
  wont_fix: ["won't fix", "wontfix"],
  disputed: ["disputed", "false positive", "not a bug"],
  deferred: ["deferred", "out of scope"],
} satisfies Record<Exclude<ClaimKind, "question">, string[]>;

const isOpened = (kind: string): kind is keyof typeof OPENINGS => kind in OPENINGS;

/** The claim a reply's first line names (exploration 05 §7.1): its opening words, whole, any case. */
function kindOf(body: string): ClaimKind {
  const first = (body.trim().split(/\r?\n/)[0] ?? "")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ");
  const opens = (words: string) => first.startsWith(words) && !/[a-z0-9]/.test(first.charAt(words.length));
  const named = Object.keys(OPENINGS)
    .filter(isOpened)
    .find((kind) => OPENINGS[kind].some(opens));
  return named ?? "question";
}

/**
 * The claim Lookover's own reply answers: the `claim` its marker names (`publish` writes the reply id it read); null
 * when it names none, or the reply isn't Lookover's (`lookovers`): another App's reply, or a teammate's quoting
 * Lookover's markers, is nobody's word.
 */
const answeredBy = (reply: HostThreadReply, lookovers: LookoversReply): number | null =>
  lookovers(reply) ? (readReplyMarker(reply.body)?.claim ?? null) : null;

/**
 * The claims on the ledger's unsettled findings: on the threads whose marker names one (outdated or not: never by
 * its line), the newest reply from a claimant newer than the newest claim answered, the one the finding holds
 * (`claim.commentId`) or one Lookover's reply names. Never cut at Lookover's reply: a claim written while a round
 * ran lands before the reply to the one it read, and is read by the next round. Host reply ids grow with time.
 */
export function readThreads(ledger: Finding[], threads: HostThread[], who: Claimants): ThreadReading {
  // A bot's reply is never a claim, on a change a bot opened too (Renovate's, Copilot's); a person's is, unless
  // Lookover wrote it as them.
  const counts = (reply: HostThreadReply) =>
    !reply.author.bot &&
    !who.lookovers(reply) &&
    (reply.author.id === who.owner.id || (!who.fork && reply.author.id === who.author.id));
  const claims = ledger.filter(isUnsettled).flatMap((finding): ThreadReading["claims"] => {
    const replies = threads.filter((t) => t.findingId === finding.id).flatMap((t) => t.replies);
    const answered = Math.max(
      finding.claim?.commentId ?? 0,
      ...replies.map((r) => answeredBy(r, who.lookovers) ?? 0),
    );
    const newest = replies
      .filter((r) => counts(r) && r.commentId > answered)
      .sort((a, b) => a.at.localeCompare(b.at) || a.commentId - b.commentId)
      .at(-1);
    if (!newest) return [];
    const text = newest.body.trim();
    return [
      {
        findingId: finding.id,
        kind: kindOf(text),
        text,
        by: newest.author.login,
        at: newest.at,
        commentId: newest.commentId,
      },
    ];
  });
  return { claims };
}
