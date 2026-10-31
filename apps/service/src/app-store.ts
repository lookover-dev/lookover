// The App store (ADR 0053, "Where the App is kept"): the GitHub App the service is given or creates, in the data
// folder's `github/` folder. `app.json` holds the record (id, slug, the App's account and the person it works
// for, ADR 0059, with the last answer of that person's `gh` on their membership of an organisation's App) and where
// its key is: under the keychain, with the keychain entry's name, or in the fallback file. The key is sealed as the
// sign-in to the shared App is, by `sealing.ts` (ADR 0066's one sealing, which holds how: the cipher, the keychain
// entry, the files and their names, what is removed when), under the name `app`, the App's id as associated data;
// unsealed, in `app.<24 hex>.pem`, the store says so (`protection: "user-file"`, `read()` naming the file, the one
// the key scanner may skip). The record is written whole or not at all, and its rename is the one moment the App
// changes. One process owns a data folder, through one store: the store's reads and writes take turns, so a write
// never removes the files of another still under way. A key that no longer opens reads as `lost`, with why. The
// record is the service's own: never a shared type, never in an event, a log or settings.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HostAccount, HostLogin, KeyProtection } from "@lookover/contracts";
import { z } from "zod";
import type { Keychain } from "./keychain.ts";
import { bytesOf, type LostWhy, type SecretAt, sealing, secretAt } from "./sealing.ts";
import { turns } from "./turns.ts";
import { makeUserOnly } from "./user-only.ts";

export type { LostWhy } from "./sealing.ts";

/**
 * The App as the service keeps it: its id, its slug (`LOOKOVER_APP`), the account it belongs to (a user or an
 * organisation), and the person Lookover works for, the owner (ADR 0059): on a personal account, the account itself.
 */
export interface StoredApp {
  id: number;
  slug: string;
  account: HostAccount;
  person: HostLogin;
}

/**
 * How the key is kept: under the keychain, or in the unencrypted file `fallback` names, from the data folder with
 * `/` (`github/app.<id>.pem`): the one file holding key text the leak checks may skip.
 */
type KeyKept = { protection: "keychain" } | { protection: "user-file"; fallback: string };

/**
 * The last answer the person's own `gh` gave of their membership of the App's organisation (ADR 0059): still a member,
 * or no longer one. Kept with the App, so a start where `gh` can't answer goes on from it.
 */
export type Membership = "member" | "not-a-member";

/** `membership`: the last answer kept with the App; null with none yet (a personal App never has one). */
export type AppRead =
  | { state: "none" }
  | ({ state: "kept"; app: StoredApp; privateKey: string; membership: Membership | null } & KeyKept)
  | ({ state: "lost"; app: StoredApp; why: LostWhy; membership: Membership | null } & KeyKept);

/** The App's record, relative to the data folder. */
const RECORD_FILE = "github/app.json";

export interface AppStore {
  read(): Promise<AppRead>;
  /**
   * Keeps `app` and its key, in place of any App kept before, in one record write with `membership` as its last answer
   * (none when not given: a new App); answers how the key is kept.
   */
  write(app: StoredApp, privateKey: string, membership?: Membership): Promise<{ protection: KeyProtection }>;
  /** Keeps `membership` as the last answer with the App kept, its key untouched; nothing with no App kept. */
  keepMembership(membership: Membership): Promise<void>;
}

/** The person, as `HostLogin` says it. */
const PERSON: z.ZodType<HostLogin> = z.object({ id: z.number().int().positive(), login: z.string().min(1) });

const RECORD = z.object({
  id: z.number().int().positive(),
  slug: z.string().min(1),
  account: z.object({
    id: z.number().int().positive(),
    login: z.string().min(1),
    type: z.enum(["User", "Organization"]),
  }),
  person: PERSON,
  key: secretAt("app", "pem"),
  // Absent until `gh` first answered: a personal App, or an organisation's just kept.
  membership: z.enum(["member", "not-a-member"]).optional(),
});
type AppRecord = z.infer<typeof RECORD>;

/** `app.json` is there but isn't a record the store wrote: not JSON, or not its shape. */
class NotOurRecord extends Error {
  constructor() {
    super(`${RECORD_FILE} is not an App Lookover wrote`);
    this.name = "NotOurRecord";
  }
}

const recordText = (app: StoredApp, key: SecretAt, membership?: Membership) =>
  `${JSON.stringify({ id: app.id, slug: app.slug, account: app.account, person: app.person, key, membership }, null, 2)}\n`;

/**
 * The App as the service keeps it, from its parts: the account's and the person's id and login (the account's type
 * too) copied, nothing else they carry.
 */
export const storedApp = (id: number, slug: string, account: HostAccount, person: HostLogin): StoredApp => ({
  id,
  slug,
  account: { id: account.id, login: account.login, type: account.type },
  person: { id: person.id, login: person.login },
});

/** What the App's key is sealed to: the App's id. */
const aad = (app: StoredApp) => String(app.id);

/** The App a record names. */
const appOf = ({ id, slug, account, person }: AppRecord): StoredApp => storedApp(id, slug, account, person);

/** The JSON in `text`, or `NotOurRecord` when it isn't JSON. */
function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) throw new NotOurRecord();
    throw error;
  }
}

/**
 * The slug of the App kept in the data folder `home` (`LOOKOVER_APP`, for the agent's commands), read from its record
 * alone, the keychain never asked; null when there is none, none the store wrote, or one it can't read (a folder, no
 * access): the agent's command then says no App is named, as with none.
 */
export async function keptSlug(home: string): Promise<string | null> {
  let bytes: Buffer;
  try {
    bytes = await readFile(join(home, RECORD_FILE));
  } catch {
    return null;
  }
  try {
    return RECORD.parse(json(bytes.toString("utf8"))).slug;
  } catch (error) {
    if (error instanceof NotOurRecord || error instanceof z.ZodError) return null;
    throw error;
  }
}

/**
 * The App store of the data folder `home`, its data keys in `keychain`; `userOnly` makes a still empty file user-only
 * (`makeUserOnly`, unless a test injects its own). One store per data folder, in one process: its calls take turns.
 */
export function appStore(o: {
  home: string;
  keychain: Keychain;
  userOnly?: (path: string) => Promise<void>;
}): AppStore {
  const path = (file: string) => join(o.home, file);
  const sealed = sealing({
    home: o.home,
    keychain: o.keychain,
    userOnly: o.userOnly ?? makeUserOnly,
    name: "app",
    plain: "pem",
  });

  const inTurn = turns();

  const record = async (): Promise<AppRecord | null> => {
    const bytes = await bytesOf(path(RECORD_FILE));
    if (bytes === null) return null;
    const parsed = RECORD.safeParse(json(bytes.toString("utf8")));
    if (!parsed.success) throw new NotOurRecord();
    return parsed.data;
  };

  const write = async (
    app: StoredApp,
    privateKey: string,
    membership: Membership | undefined,
  ): Promise<{ protection: KeyProtection }> => {
    // A record the store didn't write is replaced: it named no entry this write could remove.
    const before = await record().catch((error: unknown) => {
      if (error instanceof NotOurRecord) return null;
      throw error;
    });
    return sealed.keep(privateKey, aad(app), before?.key ?? null, (key) =>
      sealed.whole(RECORD_FILE, recordText(app, key, membership)),
    );
  };

  const read = async (): Promise<AppRead> => {
    const kept = await record();
    if (kept === null) return { state: "none" };
    const app = appOf(kept);
    const how: KeyKept =
      kept.key.kept === "file"
        ? { protection: "user-file", fallback: sealed.fileOf(kept.key) }
        : { protection: "keychain" };
    const key = await sealed.open(kept.key, aad(app));
    const membership = kept.membership ?? null;
    return "secret" in key
      ? { state: "kept", app, privateKey: key.secret, membership, ...how }
      : { state: "lost", app, why: key.why, membership, ...how };
  };

  /** The record written again with `membership`, naming the same key. */
  const keepMembership = async (membership: Membership): Promise<void> => {
    const kept = await record();
    if (kept === null) return;
    await sealed.whole(RECORD_FILE, recordText(appOf(kept), kept.key, membership));
  };

  return {
    read: () => inTurn(read),
    write: (app, privateKey, membership) => inTurn(() => write(app, privateKey, membership)),
    keepMembership: (membership) => inTurn(() => keepMembership(membership)),
  };
}
