// The manifest flows (ADR 0053, ADR 0059): "make the App here" (your own account, or an organisation with the person
// it works for: the place chosen last, kept until another is; or nowhere, a choice not taken), "a flow was opened with this state, for this place",
// "when was it opened and for where", "it is used up", "forget those opened before then". Kept by the hash of the
// state the caller gives, never the state; whether a flow is too old, or a place allowed, is the caller's to say.
import type { Database } from "bun:sqlite";
import type { HostLogin } from "@lookover/contracts";
import { z } from "zod";

/** An organisation where the App is made, and the person it works for (ADR 0059). Null where used: your own account. */
export interface AppPlace {
  organisation: { id: number; login: string };
  person: HostLogin;
}

/** Where the next flows make the App: a place, or `none`, a choice not taken (no flow may open until another is). */
export type AppChoice = AppPlace | null | "none";

export interface AppFlows {
  /**
   * Where the next flows make the App: an organisation and its person, null, your own account (the default), or
   * `none`, nowhere.
   */
  choose(choice: AppChoice): void;
  /** Where the next flows make the App, as chosen last: null, your own account, until another is chosen. */
  chosen(): AppChoice;
  /** A flow opened at `at` for `place`, kept by its state's hash. */
  opened(stateHash: string, at: number, place: AppPlace | null): void;
  /** When the flow of this hash was opened, and for where; null when none is kept (never opened, used up or forgotten). */
  flow(stateHash: string): { openedAt: number; place: AppPlace | null } | null;
  /** The flow's conversion succeeded: it is gone. */
  usedUp(stateHash: string): void;
  /** Every flow opened before `before` is gone. */
  forget(before: number): void;
}

const placeColumns = {
  organisation_id: z.int().nullable(),
  organisation_login: z.string().nullable(),
  person_id: z.int().nullable(),
  person_login: z.string().nullable(),
};
const flowRow = z.object({ opened_at: z.int(), ...placeColumns });
const placeRow = z.object(placeColumns);

/** The place a row holds: null when it holds none (the table's check keeps the four together). */
function placeOf(row: z.infer<typeof placeRow>): AppPlace | null {
  const { organisation_id, organisation_login, person_id, person_login } = row;
  if (organisation_id === null || organisation_login === null || person_id === null || person_login === null)
    return null;
  return {
    organisation: { id: organisation_id, login: organisation_login },
    person: { id: person_id, login: person_login },
  };
}

/** A place as its four columns, all null for your own account. */
const columnsOf = (place: AppPlace | null) =>
  [
    place?.organisation.id ?? null,
    place?.organisation.login ?? null,
    place?.person.id ?? null,
    place?.person.login ?? null,
  ] as const;

export function appFlows(db: Database): AppFlows {
  const insert = db.query(
    `INSERT OR REPLACE INTO app_flows
       (state_hash, opened_at, organisation_id, organisation_login, person_id, person_login)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const select = db.query(
    "SELECT opened_at, organisation_id, organisation_login, person_id, person_login FROM app_flows WHERE state_hash = ?",
  );
  const remove = db.query("DELETE FROM app_flows WHERE state_hash = ?");
  const older = db.query("DELETE FROM app_flows WHERE opened_at < ?");
  const upsertPlace = db.query(
    `INSERT OR REPLACE INTO app_place (id, organisation_id, organisation_login, person_id, person_login)
     VALUES (1, ?, ?, ?, ?)`,
  );
  const removePlace = db.query("DELETE FROM app_place WHERE id = 1");
  const selectPlace = db.query(
    "SELECT organisation_id, organisation_login, person_id, person_login FROM app_place WHERE id = 1",
  );
  return {
    choose: (choice) => {
      // Your own account is no row; nowhere, a row with no place in it.
      if (choice === null) removePlace.run();
      else upsertPlace.run(...columnsOf(choice === "none" ? null : choice));
    },
    chosen: () => {
      const row = selectPlace.get();
      return row === null ? null : (placeOf(placeRow.parse(row)) ?? "none");
    },
    opened: (stateHash, at, place) => {
      insert.run(stateHash, at, ...columnsOf(place));
    },
    flow: (stateHash) => {
      const row = select.get(stateHash);
      if (row === null) return null;
      const parsed = flowRow.parse(row);
      return { openedAt: parsed.opened_at, place: placeOf(parsed) };
    },
    usedUp: (stateHash) => {
      remove.run(stateHash);
    },
    forget: (before) => {
      older.run(before);
    },
  };
}
