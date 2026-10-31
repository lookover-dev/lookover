// The sign-in store (ADR 0066, "The sign-in is kept like the key"): the person signed in to the shared App, in a data
// folder's `github/` folder. `sign-in.json` holds the record (the person, as `GET /user` named them, and where their
// tokens are); the token, the refresh token and their expiries are sealed as the App's key is (`sealing.ts`, the one
// sealing), sealed to the person's id: under a data key in the keychain, `lookover-dev-…` for a folder under `.dev`,
// or in a user-only `sign-in.<24 hex>.token`, named after a random id of its own, when the keychain can't. A new sign-in replaces the last, whoever it names;
// a renewed one is a new sign-in to the store. A sign-in that no longer opens reads as `lost`, naming the person.
// One store per folder in one process: its calls take turns, so a renewal, written only in place of the sign-in it
// renews, never puts back one a new sign-in replaced while GitHub renewed it. Its folder is the data folder, unless the service is
// given another (`bun run live` keeps one sign-in in the live data folder for every run, ADR 0066).
// It must never know: GitHub, or what a sign-in lets Lookover do; and it never logs or sends a token.
import { join } from "node:path";
import type { HostLogin, KeyProtection, SignIn, SignInKeeper } from "@lookover/contracts";
import { z } from "zod";
import type { Keychain } from "./keychain.ts";
import { bytesOf, type LostWhy, type SecretAt, sealing, secretAt } from "./sealing.ts";
import { turns } from "./turns.ts";
import { makeUserOnly } from "./user-only.ts";

/** What the store holds: no sign-in, one kept (how its tokens are kept), or one whose tokens no longer open. */
export type SignInRead =
  | { state: "none" }
  | { state: "kept"; signIn: SignIn; protection: KeyProtection }
  | { state: "lost"; person: HostLogin; why: LostWhy };

export interface SignInStore {
  read(): Promise<SignInRead>;
  /** Keeps `signIn` in place of any kept before; answers how its tokens are kept. */
  write(signIn: SignIn): Promise<{ protection: KeyProtection }>;
  /**
   * The store as the GitHub adapter reads and renews the sign-in: one that doesn't open is none; a renewal is written
   * only while the one it renews is still kept (a keychain that doesn't answer throws: it is written again later).
   */
  readonly keeper: SignInKeeper;
}

/** The record, relative to the folder. */
const RECORD_FILE = "github/sign-in.json";

const RECORD = z.object({
  person: z.object({ id: z.number().int().positive(), login: z.string().min(1) }),
  key: secretAt("sign-in", "token"),
});
type SignInRecord = z.infer<typeof RECORD>;

/** The tokens and their expiries, as they are sealed. */
const TOKENS = z.object({
  token: z.string().min(1),
  expiresAt: z.number(),
  refreshToken: z.string().min(1),
  refreshExpiresAt: z.number(),
});

/** What the tokens are sealed to: the person they are for. */
const aad = (person: HostLogin) => `sign-in:${person.id}`;

const sameTokens = (a: SignIn, b: SignIn) => a.token === b.token && a.refreshToken === b.refreshToken;

const recordText = (person: HostLogin, key: SecretAt) =>
  `${JSON.stringify({ person: { id: person.id, login: person.login }, key }, null, 2)}\n`;

/** `text` as JSON, or null when it isn't (a fallback file left half-written or changed by hand). */
function jsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/** The record, or null when there is none, or one the store didn't write (it names nothing this store can open). */
function parsed(bytes: Buffer | null): SignInRecord | null {
  if (bytes === null) return null;
  const read = RECORD.safeParse(jsonOrNull(bytes.toString("utf8")));
  return read.success ? read.data : null;
}

/**
 * The sign-in store of the folder `home`, its data keys in `keychain`; `userOnly` makes a still empty file user-only
 * (`makeUserOnly`, unless a test injects its own).
 */
export function signInStore(o: {
  home: string;
  keychain: Keychain;
  userOnly?: (path: string) => Promise<void>;
}): SignInStore {
  const sealed = sealing({
    home: o.home,
    keychain: o.keychain,
    userOnly: o.userOnly ?? makeUserOnly,
    name: "sign-in",
    plain: "token",
  });
  const inTurn = turns();
  const record = async () => parsed(await bytesOf(join(o.home, RECORD_FILE)));

  const read = async (): Promise<SignInRead> => {
    const kept = await record();
    if (kept === null) return { state: "none" };
    const opened = await sealed.open(kept.key, aad(kept.person));
    if ("why" in opened) return { state: "lost", person: kept.person, why: opened.why };
    const tokens = TOKENS.safeParse(jsonOrNull(opened.secret));
    if (!tokens.success) return { state: "lost", person: kept.person, why: "unopened" };
    const protection: KeyProtection = kept.key.kept === "file" ? "user-file" : "keychain";
    return { state: "kept", signIn: { ...tokens.data, person: { ...kept.person } }, protection };
  };

  const write = async (signIn: SignIn): Promise<{ protection: KeyProtection }> => {
    const before = await record();
    const { person, ...tokens } = signIn;
    return sealed.keep(JSON.stringify(TOKENS.parse(tokens)), aad(person), before?.key ?? null, (key) =>
      sealed.whole(RECORD_FILE, recordText(person, key)),
    );
  };

  return {
    read: () => inTurn(read),
    write: (signIn) => inTurn(() => write(signIn)),
    keeper: {
      read: async () => {
        const kept = await inTurn(read);
        return kept.state === "kept" ? kept.signIn : null;
      },
      write: (renewed, from) =>
        inTurn(async () => {
          const kept = await read();
          if (kept.state === "lost" && kept.why === "keychain")
            throw new Error("The keychain didn't answer: the renewed sign-in can't be kept yet");
          if (kept.state !== "kept" || !sameTokens(kept.signIn, from)) return false;
          await write(renewed);
          return true;
        }),
    },
  };
}
