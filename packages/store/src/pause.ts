// The pause (ADR 0040): "are reviews paused, since when and until when", "the owner paused", "reviews resumed".
// One row at most: a pause replaces the one set before it. Whether a timed pause is over is the caller's to say:
// the store keeps the end it was given, and forgets it only on `resumed`.
import type { Database } from "bun:sqlite";
import type { Service } from "@lookover/contracts";
import { z } from "zod";

/** A pause: since when, and until when (null: until the owner resumes). */
export type Paused = NonNullable<Service["paused"]>;

export interface Pause {
  /** The pause set, as it was given; null when none is. */
  current(): Paused | null;
  /** Reviews paused from `since` until `until`, or until resumed: replaces the pause set, if any. */
  paused(pause: Paused): void;
  /** Reviews resumed (by the owner, or a timed pause over): no pause is set. Resuming when none is set is no change. */
  resumed(): void;
}

const pauseRow = z.object({ since: z.int(), until: z.int().nullable() });

export function pause(db: Database): Pause {
  const select = db.query("SELECT since, until FROM pause WHERE id = 1");
  const upsert = db.query(
    "INSERT INTO pause (id, since, until) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET since = excluded.since, until = excluded.until",
  );
  const remove = db.query("DELETE FROM pause");
  return {
    current: () => {
      const row = select.get();
      return row === null ? null : pauseRow.parse(row);
    },
    paused: ({ since, until }) => {
      upsert.run(since, until);
    },
    resumed: () => {
      remove.run();
    },
  };
}
