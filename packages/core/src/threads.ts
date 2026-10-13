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
 * change comes from a fork (ADR 0048: anyone else's text never reaches an engine).
 */
export interface Claimants {
  owner: { id: number };
  author: { id: number };
  fork: boolean;
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
 * when it names none, or the reply isn't Lookover's. Lookover's is a bot's, holding the reply marker Lookover puts on
 * every reply: another App's reply, even one quoting Lookover's other markers, is nobody's word; a person's is never
 * Lookover's.
 */
const answeredBy = (reply: HostThreadReply): number | null =>
  reply.author.bot ? (readReplyMarker(reply.body)?.claim ?? null) : null;

/**
 * The claims on the ledger's unsettled findings: on the threads whose marker names one (outdated or not: never by
 * its line), the newest reply from a claimant newer than the newest claim answered, the one the finding holds
 * (`claim.commentId`) or one Lookover's reply names. Never cut at Lookover's reply: a claim written while a round
 * ran lands before the reply to the one it read, and is read by the next round. Host reply ids grow with time.
 */
export function readThreads(ledger: Finding[], threads: HostThread[], who: Claimants): ThreadReading {
  const counts = (reply: HostThreadReply) =>
    !reply.author.bot &&
    (reply.author.id === who.owner.id || (!who.fork && reply.author.id === who.author.id));
  const claims = ledger.filter(isUnsettled).flatMap((finding): ThreadReading["claims"] => {
    const replies = threads.filter((t) => t.findingId === finding.id).flatMap((t) => t.replies);
    const answered = Math.max(finding.claim?.commentId ?? 0, ...replies.map((r) => answeredBy(r) ?? 0));
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
