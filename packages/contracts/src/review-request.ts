// A review request (ADR 0021, ADR 0043, ADR 0052): a conversation comment on a change whose first line, trimmed, is
// `/lookover review`, or `/lookover review full` (a full round: the round posts as a first round would), in any case.
// `lookover wait` writes one with a hidden marker under it, `<!-- lookover:request {json} -->`, naming the commit it
// asks about (`REQUEST_MARKER`), so it can tell later whether that commit was asked about, and the reply on a Lookover
// thread it asks to have answered, when it asks again on a commit already reviewed; a person writes the command alone,
// which names no commit (the change's head when it is read) and no reply. A comment holding any other `lookover:`
// marker is Lookover's own or quotes it, never a request. Who may ask (the owner, not the App), and which comments
// count (new ones, on open changes), is the service's rule; this file only reads and writes the text.
import { z } from "zod";
import { MARKER_PREFIX, REQUEST_MARKER } from "./frozen.ts";
import { type CommitSha, commitSha } from "./ids.ts";

/** What a request's first line says: the command, then `full` for a full round. */
const COMMAND = "/lookover review";
const FULL = `${COMMAND} full`;
const MARKER_END = " -->";

/** What a review request's text says. */
export interface ReviewRequestText {
  /** `/lookover review full`: the round posts as a first round would, new `consider` findings included. */
  full: boolean;
  /** The commit its marker names; null for a request written by hand. */
  commit: CommitSha | null;
  /** The id of the reply (a review comment on a Lookover thread) its marker asks to have answered; null when none. */
  reply: number | null;
}

/**
 * The request `lookover wait` posts for `sha`: the command, then the hidden marker naming the commit and, when given,
 * the reply it asks to have answered.
 */
export const reviewRequest = (sha: CommitSha, asking: { reply?: number } = {}): string =>
  `${COMMAND}\n${REQUEST_MARKER}${JSON.stringify({ v: 1, commit: sha, reply: asking.reply })}${MARKER_END}`;

const SHA = /^[0-9a-f]{7,40}$/;
// Each field read on its own: a field Lookover doesn't write is no commit or no reply, never a refusal of the rest.
const MARKER = z.object({
  commit: z.string().regex(SHA).transform(commitSha).nullable().catch(null).default(null),
  reply: z.int().positive().nullable().catch(null).default(null),
});

/** The marker's JSON, read; nothing named when the request carries none, or one Lookover doesn't write. */
function markerOf(body: string): Pick<ReviewRequestText, "commit" | "reply"> {
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith(REQUEST_MARKER) && l.endsWith(MARKER_END));
  const none = { commit: null, reply: null };
  if (line === undefined) return none;
  try {
    const read = MARKER.safeParse(JSON.parse(line.slice(REQUEST_MARKER.length, -MARKER_END.length)));
    return read.success ? read.data : none;
  } catch {
    return none;
  }
}

/**
 * What a comment's text asks, when it is a review request: its first line, trimmed, is the command (or the command
 * then `full`), in any case, and it holds no Lookover marker but the request's (a summary or a finding that quotes the
 * command is no request). Null for any other comment.
 */
export function readRequest(body: string): ReviewRequestText | null {
  const first = (body.split("\n")[0] ?? "").trim().toLowerCase();
  if (first !== COMMAND && first !== FULL) return null;
  if (body.split(REQUEST_MARKER).join("").includes(MARKER_PREFIX)) return null;
  return { full: first === FULL, ...markerOf(body) };
}

/** Whether a comment's text is a review request (`readRequest`). */
export const isReviewRequest = (body: string): boolean => readRequest(body) !== null;

/** The commit a review request names in its marker; null for a plain request, or a comment that is no request. */
export const requestedCommit = (body: string): CommitSha | null => readRequest(body)?.commit ?? null;
