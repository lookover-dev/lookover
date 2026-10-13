// What happened, in order (ADR 0038): the events the service sends the UI, kept so the snapshot is built from
// them with `apply`, the same way the UI builds its copy, and numbered by the table itself, so the numbers keep
// going up after a restart. Its user is the service: "record this and number it", "give me everything". A store
// that takes over from another (a new room's, ADR 0046) is opened with the number the last one reached: its events
// are numbered after it, so a tab that followed the old one never sees a number go back.
import type { Database } from "bun:sqlite";
import type { Event, EventBody } from "@lookover/contracts";
import { z } from "zod";

export interface Events {
  /** Records what happened and gives it its number, one more than the last. */
  append(body: EventBody): Event;
  /** Every event, oldest first. */
  all(): Event[];
  /** The number of the last event, or the number this store numbers after; 0 before the first. */
  last(): number;
}

const seqRow = z.object({ seq: z.int() });
const row = z.object({ seq: z.int(), body: z.string() });
const rows = z.array(row);
const lastRow = z.object({ last: z.int() });

/** Written by `append` below from a typed body: reading it back is reading our own JSON. */
function parse(r: z.infer<typeof row>): Event {
  const body: EventBody = JSON.parse(r.body);
  return { ...body, seq: r.seq };
}

/**
 * The events, numbered after `from` when the table hasn't numbered past it: SQLite's own counter for the table is
 * moved up, never down, so a number is given once however the store is opened.
 */
export function events(db: Database, from: number): Events {
  const insert = db.query("INSERT INTO events (body) VALUES (?) RETURNING seq");
  const selectAll = db.query("SELECT seq, body FROM events ORDER BY seq");
  // The table's counter, which outlives its rows (a migration that empties the table, a store opened from a number).
  const selectLast = db.query(
    "SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'events'), 0) AS last",
  );
  const last = (): number => lastRow.parse(selectLast.get()).last;
  // Immediate: the counter is read and moved under the write lock, so another connection's insert never lands between.
  db.transaction(() => {
    if (from <= last()) return;
    // The counter's row appears with the first insert: moved when it is there, made when it isn't.
    if (db.query("UPDATE sqlite_sequence SET seq = ? WHERE name = 'events'").run(from).changes === 0) {
      db.query("INSERT INTO sqlite_sequence (name, seq) VALUES ('events', ?)").run(from);
    }
  }).immediate();
  return {
    append: (body) => ({ ...body, seq: seqRow.parse(insert.get(JSON.stringify(body))).seq }),
    all: () => rows.parse(selectAll.all()).map(parse),
    last,
  };
}
