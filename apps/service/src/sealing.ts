// The one sealing of the data folder's secrets (ADR 0053's pattern, ADR 0066: "one sealing for both"): the App's key
// (`app-store.ts`) and the sign-in to the shared App (`sign-in-store.ts`), each in `github/` under a name of its own
// (`app`, `sign-in`). Under the keychain, `<name>.<entry>.key` holds the secret encrypted with AES-256-GCM (12-byte
// nonce, then the 16-byte tag, then the ciphertext) under a random 256-bit data key kept in the keychain entry, the
// caller's associated data binding it to what it is for. The entry's name is random, made at each write
// (`lookover-dev-…` for a data folder under `.dev`, `lookover-…` otherwise): two data folders never share one, and a
// moved folder still opens. When the keychain refuses or doesn't answer in time, the secret goes unencrypted to
// `<name>.<24 hex>.<plain>`, and the caller is told (`protection: "user-file"`). Every file is user-only, and written
// whole or not at all (a temporary file, then a rename). A new secret never overwrites the one the record names: its
// file has a name of its own, so the record's rename, which is the caller's, is the one moment the secret changes;
// what the record no longer names (the old entry and its file, an unencrypted file, a stopped write's temporary
// files) is removed after it lands, or at the next write. Each name sweeps only its own files, so the App's and the
// sign-in's never touch each other's. A secret that no longer opens (the entry or its file gone, the data key or the
// ciphertext not the ones written together) is `lost`, with why.
// It must never know: what the secret is, or what the record holds beside where the secret is.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { KeyProtection } from "@lookover/contracts";
import { z } from "zod";
import { type Keychain, KeychainUnavailable } from "./keychain.ts";

/**
 * Why a sealed secret doesn't open: `gone` (the keychain entry or the secret's file removed), `unopened` (the data key
 * and the ciphertext were not written together: another folder's file, the record's associated data changed),
 * `keychain` (the keychain didn't answer: it may open later).
 */
export type LostWhy = "gone" | "unopened" | "keychain";

/** Where a secret is, as its record names it: under a keychain entry, or in an unencrypted file of `github/`. */
export type SecretAt = { kept: "keychain"; entry: string } | { kept: "file"; file: string };

/** A keychain entry's name as the sealing makes it; a record naming anything else is not Lookover's. */
const ENTRY = /^lookover-(?:dev-)?[0-9a-f]{24}$/;

/** The file names of the secrets named `name`: a sealed one, its entry captured, and an unencrypted one. */
function namesOf(name: string, plain: string): { sealed: RegExp; plain: RegExp } {
  return {
    sealed: new RegExp(`^${name}\\.(lookover-(?:dev-)?[0-9a-f]{24})\\.key$`),
    plain: new RegExp(`^${name}\\.[0-9a-f]{24}\\.${plain}$`),
  };
}

/**
 * Where a record says its secret named `name` is, as the sealing names it (its fallback ending `.<plain>`): a record
 * naming another place is not Lookover's.
 */
export function secretAt(name: SecretName, plain: string): z.ZodType<SecretAt> {
  return z.discriminatedUnion("kept", [
    z.object({ kept: z.literal("keychain"), entry: z.string().regex(ENTRY) }),
    z.object({ kept: z.literal("file"), file: z.string().regex(namesOf(name, plain).plain) }),
  ]);
}

/** The secrets the data folder seals, each its own name in `github/`: letters and dashes, no pattern's character. */
export type SecretName = "app" | "sign-in";

const NONCE = 12;
const TAG = 16;
const DATA_KEY = 32;

const codeOf = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error ? String(error.code) : null;

/** The file's bytes, or null when it isn't there. */
export async function bytesOf(path: string): Promise<Buffer | null> {
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

function seal(aad: string, dataKey: Buffer, secret: string): Buffer {
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv("aes-256-gcm", dataKey, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const sealed = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), sealed]);
}

/** The secret `sealed` holds, or null when it doesn't open under `dataKey` for `aad`. */
function unseal(aad: string, dataKey: Buffer, sealed: Buffer): string | null {
  if (dataKey.length !== DATA_KEY || sealed.length < NONCE + TAG) return null;
  const decipher = createDecipheriv("aes-256-gcm", dataKey, sealed.subarray(0, NONCE));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(sealed.subarray(NONCE, NONCE + TAG));
  try {
    return Buffer.concat([decipher.update(sealed.subarray(NONCE + TAG)), decipher.final()]).toString("utf8");
  } catch {
    return null; // GCM refused the tag: not the data key, the associated data or the bytes written together.
  }
}

/** What the keychain answered, or `UNANSWERED` when it refused or didn't answer in time. */
const UNANSWERED = Symbol("unanswered");
const asked = <T>(call: Promise<T>): Promise<T | typeof UNANSWERED> =>
  call.catch((error: unknown) => {
    if (error instanceof KeychainUnavailable) return UNANSWERED;
    throw error;
  });

export interface Sealing {
  /** Writes `file` (relative to the data folder) whole or not at all, user-only: the caller's record. */
  whole(file: string, data: string): Promise<void>;
  /**
   * Seals `secret` for `aad` in a place of its own, then has `record` write the record naming it: under the keychain,
   * else, the keychain refusing or not answering in time, in the unencrypted file. A record that fails removes the new
   * place, and throws. Once it lands, every other place of this name is removed, `former` (the entry the record named
   * before) too. Answers how the secret is kept.
   */
  keep(
    secret: string,
    aad: string,
    former: SecretAt | null,
    record: (at: SecretAt) => Promise<void>,
  ): Promise<{ protection: KeyProtection }>;
  /** The secret at `at`, sealed for `aad`; why it doesn't open when it doesn't. */
  open(at: SecretAt, aad: string): Promise<{ secret: string } | { why: LostWhy }>;
  /** The unencrypted file of `at`, from the data folder with `/` (`github/<name>.<id>.<plain>`): the one to skip. */
  fileOf(at: Extract<SecretAt, { kept: "file" }>): string;
}

/**
 * The sealing of the secrets named `name` in the data folder `home`'s `github/`, their data keys in `keychain`, the
 * unencrypted fallback ending `.<plain>`; `userOnly` makes a still empty file user-only.
 */
export function sealing(o: {
  home: string;
  keychain: Keychain;
  userOnly: (path: string) => Promise<void>;
  name: SecretName;
  plain: string;
}): Sealing {
  const path = (file: string) => join(o.home, file);
  const whole = (file: string, data: string | Buffer) => writeWhole(path(file), data, o.userOnly);
  const sealedFile = (entry: string) => `github/${o.name}.${entry}.key`;
  const plainFile = (file: string) => `github/${file}`;
  const { sealed: SEALED, plain: PLAIN } = namesOf(o.name, o.plain);

  /** Removes a keychain entry; answers false when the keychain won't now (the entry stays, unread). */
  const forget = async (entry: string) => (await asked(o.keychain.delete(entry))) !== UNANSWERED;

  /**
   * Removes what the record no longer names, once it has landed: every other sealed secret of this name with its entry
   * (the entry first, so a file is left only beside an entry the next write can still remove), every other
   * unencrypted file of it, the record's former entry, and the temporary files a stopped write of this name left.
   */
  const sweep = async (kept: SecretAt, former: SecretAt | null) => {
    const folder = path("github");
    const entryKept = kept.kept === "keychain" ? kept.entry : null;
    const fileKept = kept.kept === "file" ? kept.file : null;
    const stray = (file: string) =>
      (file.startsWith(`${o.name}.`) && file.endsWith(".tmp")) || (PLAIN.test(file) && file !== fileKept);
    for (const file of await readdir(folder)) {
      const entry = SEALED.exec(file)?.[1];
      const left = stray(file) || (entry !== undefined && entry !== entryKept && (await forget(entry)));
      if (left) await rm(join(folder, file), { force: true });
    }
    if (former?.kept === "keychain" && former.entry !== entryKept) await forget(former.entry);
  };

  /** The secret unencrypted in a file of its own, then the record; if the record fails, the file is removed. */
  const inFile = async (secret: string, record: (at: SecretAt) => Promise<void>): Promise<SecretAt> => {
    const kept = { kept: "file" as const, file: `${o.name}.${randomBytes(12).toString("hex")}.${o.plain}` };
    await whole(plainFile(kept.file), secret);
    try {
      await record(kept);
    } catch (error) {
      await rm(path(plainFile(kept.file)), { force: true });
      throw error;
    }
    return kept;
  };

  return {
    whole: (file, data) => whole(file, data),
    keep: async (secret, aad, former, record) => {
      const entry = entryName(o.home);
      const dataKey = randomBytes(DATA_KEY);
      const sealed = sealedFile(entry);
      await whole(sealed, seal(aad, dataKey, secret));
      if ((await asked(o.keychain.set(entry, dataKey.toString("base64")))) === UNANSWERED) {
        await rm(path(sealed), { force: true });
        await sweep(await inFile(secret, record), former);
        return { protection: "user-file" };
      }
      const kept = { kept: "keychain" as const, entry };
      try {
        await record(kept);
      } catch (error) {
        await rm(path(sealed), { force: true });
        await forget(entry);
        throw error;
      }
      await sweep(kept, former);
      return { protection: "keychain" };
    },
    open: async (where, aad) => {
      if (where.kept === "file") {
        const text = await bytesOf(path(plainFile(where.file)));
        return text === null ? { why: "gone" } : { secret: text.toString("utf8") };
      }
      const sealed = await bytesOf(path(sealedFile(where.entry)));
      if (sealed === null) return { why: "gone" };
      const held = await asked(o.keychain.get(where.entry));
      if (held === UNANSWERED) return { why: "keychain" };
      if (held === null) return { why: "gone" };
      const secret = unseal(aad, Buffer.from(held, "base64"), sealed);
      return secret === null ? { why: "unopened" } : { secret };
    },
    fileOf: (where) => plainFile(where.file),
  };
}
