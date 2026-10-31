// The asks to install the shared App (ADR 0067): "which accounts did this person ask to install it on, and when",
// "they asked on this one", "this one is reached", "this person signed in". One ask per account, by GitHub's id for it
// (an organisation can be renamed between an ask and its install), the last one winning, with its login as last asked;
// the person who asked kept beside it, so another person's asks are never theirs.
import type { Database } from "bun:sqlite";
import type { HostLogin } from "@lookover/contracts";
import { z } from "zod";

/** An ask to install on `account` (its login as the person asked it, and its id), at `askedAt` (ms since the epoch). */
export interface InstallAsk {
  account: HostLogin;
  askedAt: number;
}

export interface InstallAsks {
  /** The asks `person` (their GitHub id) made, oldest first. */
  of(person: number): InstallAsk[];
  /** `person` asked to install on `account` at `at`: replaces any ask kept for that account. */
  asked(person: number, account: HostLogin, at: number): void;
  /** The account of GitHub's id `account` is reached, whatever its login now: its ask forgotten, if any. */
  reached(account: number): void;
  /** `person` signed in: every other person's asks forgotten, theirs kept. */
  signedIn(person: number): void;
}

const askRow = z.object({ id: z.int(), login: z.string(), askedAt: z.int() });

export function installAsks(db: Database): InstallAsks {
  const select = db.query(
    "SELECT account_id AS id, account AS login, asked_at AS askedAt FROM install_asks WHERE person_id = ? ORDER BY asked_at, account_id",
  );
  const upsert = db.query(
    "INSERT INTO install_asks (account, account_id, person_id, asked_at) VALUES (?, ?, ?, ?) ON CONFLICT (account_id) DO UPDATE SET account = excluded.account, person_id = excluded.person_id, asked_at = excluded.asked_at",
  );
  const remove = db.query("DELETE FROM install_asks WHERE account_id = ?");
  const others = db.query("DELETE FROM install_asks WHERE person_id <> ?");
  return {
    of: (person) =>
      select.all(person).map((row) => {
        const { id, login, askedAt } = askRow.parse(row);
        return { account: { id, login }, askedAt };
      }),
    asked: (person, account, at) => {
      upsert.run(account.login, account.id, person, at);
    },
    reached: (account) => {
      remove.run(account);
    },
    signedIn: (person) => {
      others.run(person);
    },
  };
}
