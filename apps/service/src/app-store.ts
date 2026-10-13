// The App store (ADR 0053, "Where the App is kept"): the GitHub App the service is given or creates, in the data
// folder's `github/` folder. `app.json` holds the record (id, slug, the App's account and the person it works
// for, ADR 0059, with the last answer of that person's `gh` on their membership of an organisation's App) and where
// its key is: under the keychain, with the keychain entry's name, or in the fallback file. Under the keychain, `app.<entry>.key` holds the private
// key encrypted with AES-256-GCM (12-byte nonce, then the 16-byte tag, then the ciphertext) under a random 256-bit
// data key kept in the keychain entry, the App's id as associated data. The entry's name is random, made at each
// write (`lookover-dev-…` for a data folder under `.dev`, `lookover-…` otherwise): two data folders never share one,
// and a moved folder still opens. When the keychain refuses or doesn't answer in time, the key goes unencrypted to
// `app.<id>.pem`, named after a random id of its own that the record names, and the store says so (`protection:
// "user-file"`, `read()` naming the file, the one the key scanner may skip). Every file is user-only, and written whole or
// not at all (a temporary file, then a rename). A new key never overwrites the one the record names, sealed or not:
// its file has a name of its own, so the record's rename is the one moment the App changes, and what the record no
// longer names (the old entry and its file, an unencrypted file) is removed after it lands, or at the next write if
// the service stops first. One process owns a data folder, through one store: the store's reads and writes take
// turns, so a write never removes the files of another still under way. A key that no longer opens (the entry or its
// file gone, the data key or the ciphertext not the ones written together) reads as `lost`, with why. The record is
// the service's own: never a shared type, never in an event, a log or settings.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { HostAccount, HostLogin, KeyProtection } from "@lookover/contracts";
import { z } from "zod";
import { type Keychain, KeychainUnavailable } from "./keychain.ts";
import { makeUserOnly } from "./user-only.ts";

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
 * Why a stored key doesn't open: `gone` (the keychain entry or the key's file removed), `unopened` (the data key
 * and the ciphertext were not written together: another folder's file, the record's id changed), `keychain` (the
 * keychain didn't answer: it may open later).
 */
export type LostWhy = "gone" | "unopened" | "keychain";

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

/** The encrypted key's file, relative to the data folder: named after the keychain entry holding its data key. */
const sealedKeyFile = (entry: string) => `github/app.${entry}.key`;
/** The unencrypted key's file, relative to the data folder, by the name the record gives it. */
const fallbackFile = (name: string) => `github/${name}`;

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

/** A keychain entry's name as the store makes it; a record naming anything else is not the store's. */
const ENTRY = /^lookover-(?:dev-)?[0-9a-f]{24}$/;
/** A sealed key's file name in `github/`, the entry it names captured. */
const SEALED = /^app\.(lookover-(?:dev-)?[0-9a-f]{24})\.key$/;
/** An unencrypted key's file name in `github/`, as the store makes it. */
const PEM = /^app\.[0-9a-f]{24}\.pem$/;

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
  key: z.discriminatedUnion("kept", [
    z.object({ kept: z.literal("keychain"), entry: z.string().regex(ENTRY) }),
    z.object({ kept: z.literal("file"), file: z.string().regex(PEM) }),
  ]),
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

const NONCE = 12;
const TAG = 16;
const DATA_KEY = 32;

const codeOf = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error ? String(error.code) : null;

/** The file's bytes, or null when it isn't there. */
async function bytesOf(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    throw error;
  }
}

/**
 * Writes `path` whole or not at all, user-only: a temporary file of its own, made user-only while still empty, then
 * filled and renamed (a rename in the folder keeps its access list).
 */
async function writeWhole(
  path: string,
  data: string | Buffer,
  userOnly: (path: string) => Promise<void>,
): Promise<void> {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, "", { mode: 0o600, flag: "wx" });
    await userOnly(temporary);
    await writeFile(temporary, data, { flag: "r+" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** A new keychain entry's name: `lookover-dev-…` under a `.dev` folder (the loop's), `lookover-…` otherwise. */
function entryName(home: string): string {
  const fold = (segment: string) => (process.platform === "win32" ? segment.toLowerCase() : segment);
  const dev = resolve(home).split(/[\\/]/).map(fold).includes(".dev");
  return `${dev ? "lookover-dev-" : "lookover-"}${randomBytes(12).toString("hex")}`;
}

const aad = (app: StoredApp) => Buffer.from(String(app.id), "utf8");

function seal(app: StoredApp, dataKey: Buffer, privateKey: string): Buffer {
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv("aes-256-gcm", dataKey, nonce);
  cipher.setAAD(aad(app));
  const sealed = Buffer.concat([cipher.update(privateKey, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), sealed]);
}

/** The key `sealed` holds, or null when it doesn't open under `dataKey` for this App. */
function open(app: StoredApp, dataKey: Buffer, sealed: Buffer): string | null {
  if (dataKey.length !== DATA_KEY || sealed.length < NONCE + TAG) return null;
  const decipher = createDecipheriv("aes-256-gcm", dataKey, sealed.subarray(0, NONCE));
  decipher.setAAD(aad(app));
  decipher.setAuthTag(sealed.subarray(NONCE, NONCE + TAG));
  try {
    return Buffer.concat([decipher.update(sealed.subarray(NONCE + TAG)), decipher.final()]).toString("utf8");
  } catch {
    return null; // GCM refused the tag: not the data key, the id or the bytes written together.
  }
}

/** What the keychain answered, or `UNANSWERED` when it refused or didn't answer in time. */
const UNANSWERED = Symbol("unanswered");
const asked = <T>(call: Promise<T>): Promise<T | typeof UNANSWERED> =>
  call.catch((error: unknown) => {
    if (error instanceof KeychainUnavailable) return UNANSWERED;
    throw error;
  });

const recordText = (app: StoredApp, key: AppRecord["key"], membership?: Membership) =>
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
  const whole = (file: string, data: string | Buffer) =>
    writeWhole(path(file), data, o.userOnly ?? makeUserOnly);

  /** The calls so far, settled or not: each new one starts once they have. */
  let turn: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(call: () => Promise<T>): Promise<T> => {
    const run = turn.then(call, call);
    turn = run.catch(() => {});
    return run;
  };

  const record = async (): Promise<AppRecord | null> => {
    const bytes = await bytesOf(path(RECORD_FILE));
    if (bytes === null) return null;
    const parsed = RECORD.safeParse(json(bytes.toString("utf8")));
    if (!parsed.success) throw new NotOurRecord();
    return parsed.data;
  };

  const fromFile = async (name: string): Promise<{ privateKey: string } | { why: LostWhy }> => {
    const text = await bytesOf(path(fallbackFile(name)));
    return text === null ? { why: "gone" } : { privateKey: text.toString("utf8") };
  };

  const fromKeychain = async (
    app: StoredApp,
    entry: string,
  ): Promise<{ privateKey: string } | { why: LostWhy }> => {
    const sealed = await bytesOf(path(sealedKeyFile(entry)));
    if (sealed === null) return { why: "gone" };
    const held = await asked(o.keychain.get(entry));
    if (held === UNANSWERED) return { why: "keychain" };
    if (held === null) return { why: "gone" };
    const privateKey = open(app, Buffer.from(held, "base64"), sealed);
    return privateKey === null ? { why: "unopened" } : { privateKey };
  };

  /** Removes a keychain entry; answers false when the keychain won't now (the entry stays, unread). */
  const forget = async (entry: string) => (await asked(o.keychain.delete(entry))) !== UNANSWERED;

  /**
   * Removes what the record no longer names, once it has landed: every other sealed key with its entry (the entry
   * first, so a file is left only beside an entry the next write can still remove), every other unencrypted key's
   * file, the record's former entry, and temporary files a stopped write left.
   */
  const sweep = async (kept: AppRecord["key"], former: string | null) => {
    const folder = path("github");
    const entryKept = kept.kept === "keychain" ? kept.entry : null;
    const fileKept = kept.kept === "file" ? kept.file : null;
    const stray = (name: string) => name.endsWith(".tmp") || (PEM.test(name) && name !== fileKept);
    for (const name of await readdir(folder)) {
      const entry = SEALED.exec(name)?.[1];
      const left = stray(name) || (entry !== undefined && entry !== entryKept && (await forget(entry)));
      if (left) await rm(join(folder, name), { force: true });
    }
    if (former !== null && former !== entryKept) await forget(former);
  };

  /** The key unencrypted in a file of its own, then the record; if the record fails, the file is removed. */
  const keepInFile = async (
    app: StoredApp,
    privateKey: string,
    membership: Membership | undefined,
  ): Promise<AppRecord["key"]> => {
    const key = { kept: "file" as const, file: `app.${randomBytes(12).toString("hex")}.pem` };
    await whole(fallbackFile(key.file), privateKey);
    try {
      await whole(RECORD_FILE, recordText(app, key, membership));
    } catch (error) {
      await rm(path(fallbackFile(key.file)), { force: true });
      throw error;
    }
    return key;
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
    const former = before?.key.kept === "keychain" ? before.key.entry : null;
    const entry = entryName(o.home);
    const dataKey = randomBytes(DATA_KEY);
    const sealed = sealedKeyFile(entry);
    await whole(sealed, seal(app, dataKey, privateKey));
    if ((await asked(o.keychain.set(entry, dataKey.toString("base64")))) === UNANSWERED) {
      await rm(path(sealed), { force: true });
      await sweep(await keepInFile(app, privateKey, membership), former);
      return { protection: "user-file" };
    }
    const key = { kept: "keychain" as const, entry };
    try {
      await whole(RECORD_FILE, recordText(app, key, membership));
    } catch (error) {
      await rm(path(sealed), { force: true });
      await forget(entry);
      throw error;
    }
    await sweep(key, former);
    return { protection: "keychain" };
  };

  const read = async (): Promise<AppRead> => {
    const kept = await record();
    if (kept === null) return { state: "none" };
    const app = appOf(kept);
    const how: KeyKept =
      kept.key.kept === "file"
        ? { protection: "user-file", fallback: fallbackFile(kept.key.file) }
        : { protection: "keychain" };
    const key =
      kept.key.kept === "file" ? await fromFile(kept.key.file) : await fromKeychain(app, kept.key.entry);
    const membership = kept.membership ?? null;
    return "privateKey" in key
      ? { state: "kept", app, privateKey: key.privateKey, membership, ...how }
      : { state: "lost", app, why: key.why, membership, ...how };
  };

  /** The record written again with `membership`, naming the same key. */
  const keepMembership = async (membership: Membership): Promise<void> => {
    const kept = await record();
    if (kept === null) return;
    await whole(RECORD_FILE, recordText(appOf(kept), kept.key, membership));
  };

  return {
    read: () => inTurn(read),
    write: (app, privateKey, membership) => inTurn(() => write(app, privateKey, membership)),
    keepMembership: (membership) => inTurn(() => keepMembership(membership)),
  };
}
