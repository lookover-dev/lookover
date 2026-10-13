// The setup (ADR 0047): "how far did the owner get", "the owner went on to this step, where the GitHub step is (ADR
// 0053), chose the first review". Its users are the snapshot's base, which reads it, and the setup commands, which write a patch and
// send what they get back. One row at most, written whole; before the first write the setup is at its first step,
// nothing done. The furthest step reached is kept with the step: a step gone on to past it is the furthest now,
// and going back never loses it (the same rule as `apply`'s, so a UI that follows the events and one that loads
// the snapshot agree). In live mode the service writes "done" at the first start of a data folder; in demo mode the
// scenario decides. Beside it, start at login (ADR 0049): the owner's choice, the machine's, off until chosen, kept
// in its own row so choosing it never makes the setup kept. Nothing registers it before row 8.
import type { Database } from "bun:sqlite";
import {
  changeId,
  enumOf,
  furthestReached,
  SETUP_ORDER,
  type SetupGitHub,
  type SetupGitHubRefusal,
  type Setup as SetupState,
} from "@lookover/contracts";
import { z } from "zod";

export interface Setup {
  /** The setup as it is: at its first step, nothing done, before the first write. */
  read(): SetupState;
  /** Whether the setup was ever written: false on a data folder whose setup nobody wrote yet. */
  kept(): boolean;
  /**
   * Changes what `patch` names, keeps the rest, and gives the setup as it now is. A step past the furthest reached
   * is the furthest now.
   */
  write(patch: Partial<SetupState>): SetupState;
  /** Whether the owner chose to start Lookover at login: on until chosen (ADR 0054). */
  startAtLogin(): boolean;
  /** The owner chose to start Lookover at login, or not: kept; the service registers it with the machine. */
  keepStartAtLogin(on: boolean): void;
}

/** The setup before anything was done: the first step. */
const START: SetupState = {
  done: false,
  step: "ai",
  reached: "ai",
  github: "start",
  githubRefused: null,
  firstReviewChange: null,
};

// The steps as contracts lists them: `z.enum` takes the list, so a step added there is read here without a word.
const STEP = z.enum(SETUP_ORDER);
const GITHUB = enumOf<SetupGitHub>()([
  "start",
  "waiting-for-app",
  "waiting-for-install",
  "nothing-granted",
  "done",
]);
const REFUSED = enumOf<SetupGitHubRefusal>()(["unreachable", "expired", "refused", "elsewhere"]);
const flag = z.union([z.literal(0), z.literal(1)]).transform((f) => f === 1);
const startRow = z.object({ enabled: flag });
const row = z.object({
  done: flag,
  step: STEP,
  reached: STEP,
  github: GITHUB,
  github_refused: REFUSED.nullable(),
  first_review_change: z.string().transform(changeId).nullable(),
});

/** The setup with `reached` the furthest of its step and the step reached before. */
const furthest = (setup: SetupState): SetupState => ({
  ...setup,
  reached: furthestReached(setup.reached, setup.step),
});

export function setup(db: Database): Setup {
  const select = db.query(
    "SELECT done, step, reached, github, github_refused, first_review_change FROM setup WHERE id = 1",
  );
  const upsert = db.query(`
    INSERT INTO setup (id, done, step, reached, github, github_refused, first_review_change)
    VALUES (1, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET done = excluded.done, step = excluded.step, reached = excluded.reached,
      github = excluded.github, github_refused = excluded.github_refused,
      first_review_change = excluded.first_review_change
  `);
  const read = (): SetupState => {
    const found = select.get();
    if (found === null) return START;
    const r = row.parse(found);
    return {
      done: r.done,
      step: r.step,
      reached: r.reached,
      github: r.github,
      githubRefused: r.github_refused,
      firstReviewChange: r.first_review_change,
    };
  };
  // Immediate: the setup is read under the write lock, so two writes never lose each other's patch.
  const write = db.transaction((patch: Partial<SetupState>): SetupState => {
    const next = furthest({ ...read(), ...patch });
    upsert.run(
      next.done ? 1 : 0,
      next.step,
      next.reached,
      next.github,
      next.githubRefused,
      next.firstReviewChange,
    );
    return next;
  });
  const selectStart = db.query("SELECT enabled FROM start_at_login WHERE id = 1");
  const upsertStart = db.query(
    "INSERT INTO start_at_login (id, enabled) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled",
  );
  return {
    read,
    kept: () => select.get() !== null,
    write: (patch) => write.immediate(patch),
    startAtLogin: () => {
      const found = selectStart.get();
      return found === null || startRow.parse(found).enabled;
    },
    keepStartAtLogin: (on) => {
      upsertStart.run(on ? 1 : 0);
    },
  };
}
