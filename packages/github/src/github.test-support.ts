// What the adapter's tests share: GitHub's API stubbed as a list of routes, a throwaway App key that signs real
// JWTs, and the checks GitHub makes of a JWT. Imported by tests only.
import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";

// A throwaway key: the tests sign real JWTs with it, and never see the App's.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const KEY = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
export const APP = { id: 5202093, privateKey: KEY };
const PUBLIC_KEY = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();

export type Call = {
  method: string;
  path: string;
  body: unknown;
  authorization: string;
  /** The ETag the request was sent with, if any. */
  ifNoneMatch: string | null;
  /** The address's origin: where the request went. */
  origin: string;
};
type Answer = { status: number; body?: unknown; headers?: Record<string, string> };
export type Route = (call: Call) => Answer | undefined;

/** GitHub's API as a list of routes: the first that answers wins. Records every call it got. */
export function stubGitHub(...routes: Route[]) {
  const calls: Call[] = [];
  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const headers = new Headers(init.headers);
    const call = {
      method: init.method ?? "GET",
      path: url.pathname + url.search,
      body,
      authorization: headers.get("authorization") ?? "",
      ifNoneMatch: headers.get("if-none-match"),
      origin: url.origin,
    };
    calls.push(call);
    const answer = routes.map((r) => r(call)).find((a) => a !== undefined) ?? {
      status: 404,
      body: { message: "Not Found" },
    };
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json", ...answer.headers },
    });
  };
  return { fetch, calls };
}

export const AT = Date.UTC(2026, 9, 6, 12, 0, 0);
export const HOUR = 3_600_000;
export const iso = (ms: number) => new Date(ms).toISOString();

/** The claims of a JWT whose signature the App's public key accepts, or `null` for anything else. */
export function verifiedClaims(authorization: string): Record<string, unknown> | null {
  const [, jwt] = authorization.split(" ");
  const [header, claims, signature] = (jwt ?? "").split(".");
  if (!header || !claims || !signature) return null;
  const ok = createVerify("RSA-SHA256")
    .update(`${header}.${claims}`)
    .verify(PUBLIC_KEY, signature, "base64url");
  return ok ? JSON.parse(Buffer.from(claims, "base64url").toString()) : null;
}

/**
 * A JWT GitHub takes at `now`: the App's own signature and id (the spike App's unless `appId` is given), issued
 * already and not yet expired, for ten minutes at most.
 */
export function acceptedJwt(authorization: string, now: number, appId = 5202093): boolean {
  const claims = verifiedClaims(authorization);
  if (claims === null || claims.iss !== String(appId)) return false;
  const { iat, exp } = claims;
  if (typeof iat !== "number" || typeof exp !== "number") return false;
  const nowS = Math.floor(now / 1000);
  return iat <= nowS && exp > nowS && exp - iat <= 600;
}

/** A route that answers only to its token: with another one, the stub falls through to its 404. */
export const withToken =
  (token: string, route: Route): Route =>
  (call) =>
    call.authorization === `Bearer ${token}` ? route(call) : undefined;
