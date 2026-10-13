// The finding marker read back (ADR 0032, ADR 0052): `publish` ends each inline comment with
// `<!-- lookover:finding {json} -->`, the JSON naming the finding (`id`) among other facts. A thread is a
// finding's when its root comment holds that marker and is the App's own: who wrote the comment is the reader's to
// check, never this file's.
import { FINDING_MARKER } from "./frozen.ts";
import { type FindingId, findingId } from "./ids.ts";

const MARKER_END = " -->";

/** The finding the last finding marker of `body` names; null when it holds none, or one Lookover doesn't write. */
export function findingOfMarker(body: string): FindingId | null {
  const start = body.lastIndexOf(FINDING_MARKER);
  if (start < 0) return null;
  const from = start + FINDING_MARKER.length;
  const end = body.indexOf(MARKER_END, from);
  if (end < 0) return null;
  let marker: unknown;
  try {
    marker = JSON.parse(body.slice(from, end));
  } catch {
    return null;
  }
  if (typeof marker !== "object" || marker === null || !("id" in marker)) return null;
  const { id } = marker;
  return typeof id === "string" && id.trim() !== "" ? findingId(id) : null;
}
