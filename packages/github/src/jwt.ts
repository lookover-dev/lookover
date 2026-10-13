// The App's JWT (ADR 0006): signed RS256 with its private key, dated a minute back for clock skew, good for nine
// minutes. And what the connection shows when GitHub refuses it or a token bought with it (ADR 0053).
import { createSign } from "node:crypto";
import { type Clock, type ConnectionCause, HostError } from "@lookover/contracts";
import type { CauseOf } from "./api.ts";

/** A JWT is good for ten minutes at most; this one is dated a minute back for clock skew. */
const JWT_BACKDATE_S = 60;
const JWT_LIFE_S = 540;

const KEY_REFUSED: ConnectionCause = { kind: "key-refused", why: null };

/**
 * A fresh JWT for the App. A key that isn't one is refused like a key GitHub rejects: `unauthorized`, key-refused,
 * before any request leaves.
 */
export function appJwt(app: { id: number; key: string }, clock: Clock): string {
  const now = Math.floor(clock.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", typ: "JWT" });
  const claims = encode({ iat: now - JWT_BACKDATE_S, exp: now + JWT_LIFE_S, iss: String(app.id) });
  const unsigned = `${header}.${claims}`;
  try {
    return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(app.key, "base64url")}`;
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new HostError("unauthorized", `The GitHub App's private key can't sign: ${why}`, {
      connectionCause: KEY_REFUSED,
    });
  }
}

/** GitHub's words for an App id it has not (deleted, or never made): a 404 on every JWT request, seen live (#192). */
const APP_GONE = /integration not found/i;

/**
 * A request signed with the JWT, refused: the key is refused (401), and why when GitHub's words say it. It names
 * the `exp` claim when the computer's clock runs a minute or two ahead (a larger gap either way is only "Bad
 * credentials", seen live), says it can't decode a token signed with a key it no longer holds (revoked, or another
 * App's), and finds no App for an id it deleted, which it answers with a 404, not a 401.
 */
export const jwtCause: CauseOf = (status, words) => {
  if ((status === 401 || status === 404) && APP_GONE.test(words))
    return { kind: "key-refused", why: "app-deleted" };
  if (status !== 401) return undefined;
  if (/\('?(iat|exp)'?\)/i.test(words)) return { kind: "key-refused", why: "clock" };
  if (/could not be decoded/i.test(words)) return { kind: "key-refused", why: "revoked" };
  return KEY_REFUSED;
};

/**
 * The App read with its own JWT (`GET /app`), refused: as any JWT request, and a 404 is an App GitHub no longer has.
 */
export const appCause: CauseOf = (status, words) =>
  status === 404 ? { kind: "key-refused", why: "app-deleted" } : jwtCause(status, words);

/**
 * An installation token bought with the JWT, or a request made with it, refused: the installation is gone (404, but
 * the App itself when GitHub finds no App), or refuses what GitHub took the credentials for (403: suspended, or a
 * permission it no longer grants), which its settings page fixes, never the key; else as the JWT's refusal. A rate
 * limit's 403 never comes here (`refusal`).
 */
export const tokenCause: CauseOf = (status, words) => {
  if (status === 404 && !APP_GONE.test(words)) return { kind: "uninstalled", suspended: false };
  if (status === 403) return { kind: "uninstalled", suspended: true };
  return jwtCause(status, words);
};
