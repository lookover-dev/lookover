// The reply marker, written and read back (ADR 0052): `publish` ends each reply Lookover writes on its own threads
// with `<!-- lookover:reply {json} -->`, the JSON naming the round's run, the finding and the claim the reply answers
// (the reply id the round read), or the owner's dismissal and the finding. `core.readThreads` reads the claim a
// reply answers; `lookover feedback` shows a reply without it. Who wrote the reply is the reader's to check, never
// this file's.
import { REPLY_MARKER } from "./frozen.ts";
import type { FindingId, RunId } from "./ids.ts";

const MARKER_END = " -->";

/** What a reply marker names: a round's reply (its run, and the claim it answers, if any) or a dismissal's. */
export type ReplyMarked =
  | { run: RunId; finding: FindingId; claim?: number }
  | { dismissal: string; finding: FindingId };

/** The hidden line that ends one of Lookover's replies: what finds it on the host before it is sent again. */
export function replyMarker(marked: ReplyMarked): string {
  const json =
    "run" in marked
      ? { v: 1, run: marked.run, finding: marked.finding, claim: marked.claim }
      : { v: 1, dismissal: marked.dismissal, finding: marked.finding };
  return `${REPLY_MARKER}${JSON.stringify(json)}${MARKER_END}`;
}

/**
 * A reply's last reply marker read back: the claim it answers (null when it names none, or isn't one Lookover
 * writes) and what the reply says without it; null when the body holds none.
 */
export function readReplyMarker(body: string): { claim: number | null; text: string } | null {
  const start = body.lastIndexOf(REPLY_MARKER);
  if (start < 0) return null;
  const from = start + REPLY_MARKER.length;
  const end = body.indexOf(MARKER_END, from);
  const text = `${body.slice(0, start)}${end < 0 ? "" : body.slice(end + MARKER_END.length)}`.trim();
  if (end < 0) return { claim: null, text };
  let marker: unknown;
  try {
    marker = JSON.parse(body.slice(from, end));
  } catch {
    return { claim: null, text };
  }
  const claim = typeof marker === "object" && marker !== null && "claim" in marker ? marker.claim : null;
  return { claim: typeof claim === "number" ? claim : null, text };
}
