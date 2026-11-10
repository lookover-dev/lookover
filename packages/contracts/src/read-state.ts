// What a start keeps of the state its log replayed (ADR 0085): the replay is read through `stateSchema`, piece by
// piece, never trusted. A change and its review are read together and dropped together, a closed change's review
// alone; each repository, departed repository and rule alone; a section that holds one thing (`seq`,
// `now`, the setup, the engines, the connection, the service, the settings) is the start's own when it doesn't
// read. Check results are always the start's own: they read the process that ran them. Nothing is mapped from an
// old shape: dropping is the reader for old data (rule 10).
import type { z } from "zod";
import type { State } from "./state.ts";
import { stateSchema } from "./state-schema.ts";

/** A piece of the replayed state a start dropped, or replaced by its own: where it was, and what didn't read. */
export interface Dropped {
  /** `state` when the replay isn't a state at all and the start's own stands whole. */
  section: keyof State | "state";
  /** The item's key in its list or record: its id when it has one, else its index. Null for a whole section. */
  key: string | null;
  why: DroppedWhy;
}

/** Why a piece was dropped, as a fact: the service's log words it (`droppedLine`). */
export type DroppedWhy =
  /** The replay, a list or a record isn't the shape it must be: `found` is what it is instead. */
  | { kind: "not-object" | "not-list" | "not-record"; found: Found }
  /** The piece read, but its partner (a change's review, a review's change) didn't: both are dropped. */
  | { kind: "partner-dropped" }
  /**
   * The schema refused the piece: its first issue is at `path`, its fields joined by dots (empty for the piece
   * itself), and `message` is how zod words it.
   */
  | { kind: "unreadable"; path: string; message: string };

/** What a value is when it isn't the shape it must be. */
type Found = "null" | "missing" | "list" | "string" | "number" | "boolean" | "object" | "other";

const shape = stateSchema.shape;

/** The replayed `value` as this version can read it, over `own`, the state this start knows, and what it dropped. */
export function readState(value: unknown, own: State): { state: State; dropped: Dropped[] } {
  if (!isRecord(value))
    return {
      state: own,
      dropped: [{ section: "state", key: null, why: { kind: "not-object", found: kindOf(value) } }],
    };
  const out: Dropped[] = [];
  const state: State = {
    seq: orOwn(shape.seq, "seq", value, own, out),
    now: orOwn(shape.now, "now", value, own, out),
    setup: orOwn(shape.setup, "setup", value, own, out),
    engines: orOwn(shape.engines, "engines", value, own, out),
    connection: orOwn(shape.connection, "connection", value, own, out),
    service: orOwn(shape.service, "service", withOwnChecks(value, own), own, out),
    settings: orOwn(shape.settings, "settings", value, own, out),
    repos: eachOf(shape.repos.element, "repos", value, out),
    departed: eachOf(shape.departed.element, "departed", value, out),
    rules: eachOf(shape.rules.element, "rules", value, out),
    ...changesWithReviews(value, out),
  };
  return { state, dropped: out };
}

/** The section of `value` when it reads, else `own`'s. */
function orOwn<K extends keyof State>(
  schema: z.ZodType<State[K]>,
  section: K,
  value: Record<string, unknown>,
  own: State,
  out: Dropped[],
): State[K] {
  const read = schema.safeParse(value[section]);
  if (read.success) return read.data;
  out.push(issueOf(section, null, read.error));
  return own[section];
}

/** `value` with its service's check results replaced by `own`'s. */
function withOwnChecks(value: Record<string, unknown>, own: State): Record<string, unknown> {
  const service = value["service"];
  return isRecord(service) ? { ...value, service: { ...service, checks: own.service.checks } } : value;
}

/** The items of the list `section` that read, in their order. */
function eachOf<T>(
  schema: z.ZodType<T>,
  section: keyof State,
  value: Record<string, unknown>,
  out: Dropped[],
): T[] {
  const items = value[section];
  if (!Array.isArray(items)) {
    out.push({ section, key: null, why: { kind: "not-list", found: kindOf(items) } });
    return [];
  }
  const kept: T[] = [];
  items.forEach((item: unknown, index) => {
    const read = schema.safeParse(item);
    if (read.success) kept.push(read.data);
    else
      out.push(
        issueOf(
          section,
          isRecord(item) && typeof item["id"] === "string" ? item["id"] : `${index}`,
          read.error,
        ),
      );
  });
  return kept;
}

/**
 * Each change with its review: when either doesn't read, both are dropped, each named (the partner for its
 * partner). A review whose change closed, which `change.closed` leaves behind, reads alone. When either record
 * isn't one, both are empty.
 */
function changesWithReviews(
  value: Record<string, unknown>,
  out: Dropped[],
): Pick<State, "changes" | "reviews"> {
  const changes = recordOf("changes", value, out);
  const reviews = recordOf("reviews", value, out);
  if (changes === null || reviews === null) return { changes: {}, reviews: {} };
  const readChanges = entriesOf(shape.changes, "changes", changes, out);
  const readReviews = entriesOf(shape.reviews, "reviews", reviews, out);
  const paired = (key: string) =>
    !Object.hasOwn(changes, key) ||
    !Object.hasOwn(reviews, key) ||
    (Object.hasOwn(readChanges, key) && Object.hasOwn(readReviews, key));
  for (const key of Object.keys(readChanges))
    if (!paired(key)) out.push({ section: "changes", key, why: { kind: "partner-dropped" } });
  for (const key of Object.keys(readReviews))
    if (!paired(key)) out.push({ section: "reviews", key, why: { kind: "partner-dropped" } });
  return {
    changes: Object.fromEntries(Object.entries(readChanges).filter(([key]) => paired(key))),
    reviews: Object.fromEntries(Object.entries(readReviews).filter(([key]) => paired(key))),
  };
}

/** The entries of `record` that read, each read as a one-entry record so its key reads by the record's key schema. */
function entriesOf<T>(
  schema: z.ZodType<Record<string, T>>,
  section: "changes" | "reviews",
  record: Record<string, unknown>,
  out: Dropped[],
): Record<string, T> {
  const kept: Record<string, T> = {};
  for (const [key, item] of Object.entries(record)) {
    const read = schema.safeParse({ [key]: item });
    if (read.success) Object.assign(kept, read.data);
    else out.push(issueOf(section, key, read.error, 1));
  }
  return kept;
}

function recordOf(
  section: "changes" | "reviews",
  value: Record<string, unknown>,
  out: Dropped[],
): Record<string, unknown> | null {
  const record = value[section];
  if (isRecord(record)) return record;
  out.push({ section, key: null, why: { kind: "not-record", found: kindOf(record) } });
  return null;
}

/** The first issue of `error`, its path inside the piece: past the `skip` steps that lead to it. */
function issueOf(section: Dropped["section"], key: string | null, error: z.ZodError, skip = 0): Dropped {
  const [issue] = error.issues;
  const path = (issue?.path ?? []).slice(skip).map(String).join(".");
  return { section, key, why: { kind: "unreadable", path, message: issue?.message ?? "" } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function kindOf(value: unknown): Found {
  if (value === null) return "null";
  if (value === undefined) return "missing";
  if (Array.isArray(value)) return "list";
  const type = typeof value;
  return type === "string" || type === "number" || type === "boolean" || type === "object" ? type : "other";
}
