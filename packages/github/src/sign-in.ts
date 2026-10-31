// Signing in to the shared App (ADR 0066), contracts' `HostSignIn`: GitHub's device flow with the App's client ID
// and no secret, and the refresh of a sign-in, on GitHub's OAuth endpoints (its web address, not the API's). They
// answer a refusal with status 200 and an `error` field; the device flow's own (`authorization_pending`,
// `slow_down`, `expired_token`, `access_denied`) are polls' outcomes, the refresh's `bad_refresh_token` signs the
// person out, as does `incorrect_client_credentials` (what GitHub answers a refresh token it doesn't know, with the
// App's right client ID and no secret: seen live), and any other is `invalid`. A network failure or a 5xx is `unavailable`; a 429, or a limit's headers, is
// `rate_limited`, read as the API's answers are (`waitAsked`). The poll gives the tokens as soon as GitHub issues them,
// the code spent; who the person is, the one Lookover posts as, is `GET /user` with the new token (`person`), asked
// apart so a failure there never loses the tokens; a refresh keeps them.
import {
  type Clock,
  type DeviceGrant,
  type DevicePoll,
  HostError,
  type HostLogin,
  type HostSignIn,
  SHARED_APP,
  type SignIn,
  type SignInTokens,
} from "@lookover/contracts";
import type { z } from "zod";
import { type Fetch, type GitHubApi, message, waitAsked } from "./api.ts";
import { deviceCode, oauthAnswer, oauthRefusal, type oauthToken, parse, person } from "./schemas.ts";

/** What GitHub asks a device flow's poll to add to its interval when it says `slow_down`. */
const SLOW_DOWN_MS = 5_000;
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const TOKEN_PATH = "/login/oauth/access_token";

/** The refresh's refusals that sign the person out: a refresh token expired, revoked, spent, or unknown to GitHub. */
const REFRESH_REFUSED = new Set(["bad_refresh_token", "incorrect_client_credentials"]);

export interface SignInParts {
  api: GitHubApi;
  fetch: Fetch;
  /** GitHub's web address, where its OAuth endpoints are. */
  web: string;
  clock: Clock;
  secret: (value: string) => void;
}

/** A refusal of the refresh: the connection is signed out until the person signs in again. */
export const signedOut = (words: string) =>
  new HostError("unauthorized", words, { connectionCause: { kind: "signed-out" } });

export function createSignIn({ api, fetch, web, clock, secret }: SignInParts): HostSignIn {
  /** One POST to an OAuth endpoint, its JSON answer given back unparsed; a network failure or a 5xx is unavailable. */
  async function post(path: string, body: Record<string, string>): Promise<unknown> {
    let status: number;
    let headers: Headers;
    let text: string;
    try {
      const response = await fetch(`${web}${path}`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", "user-agent": "lookover" },
        body: JSON.stringify(body),
      });
      status = response.status;
      headers = response.headers;
      text = await response.text();
    } catch (error) {
      throw new HostError("unavailable", `GitHub could not be reached: ${message(error)}`);
    }
    const wait = waitAsked(status, headers, text, clock.now());
    if (wait !== null) throw wait;
    if (status >= 500) throw new HostError("unavailable", `GitHub answered POST ${path} with ${status}`);
    if (status < 200 || status >= 300)
      throw new HostError("invalid", `GitHub refused POST ${path} (${status})`);
    try {
      return JSON.parse(text);
    } catch {
      throw new HostError("unavailable", `GitHub answered POST ${path} with no JSON`);
    }
  }

  /** The tokens of an answer, with when each expires; the person is the caller's. */
  function tokens(answer: z.infer<typeof oauthToken>): SignInTokens {
    secret(answer.access_token);
    secret(answer.refresh_token);
    const now = clock.now();
    return {
      token: answer.access_token,
      expiresAt: now + answer.expires_in * 1000,
      refreshToken: answer.refresh_token,
      refreshExpiresAt: now + answer.refresh_token_expires_in * 1000,
    };
  }

  return {
    async startSignIn(): Promise<DeviceGrant> {
      const path = "/login/device/code";
      const answer = await post(path, { client_id: SHARED_APP.clientId });
      const refused = oauthRefusal.safeParse(answer);
      if (refused.success)
        throw new HostError("invalid", `GitHub refused a device code: ${refused.data.error}`);
      const code = parse(deviceCode, answer, `POST ${path}`);
      secret(code.device_code);
      return {
        deviceCode: code.device_code,
        userCode: code.user_code,
        verificationUri: code.verification_uri,
        expiresAt: clock.now() + code.expires_in * 1000,
        interval: code.interval * 1000,
      };
    },

    async pollSignIn(grant: DeviceGrant): Promise<DevicePoll> {
      secret(grant.deviceCode);
      const answer = parse(
        oauthAnswer,
        await post(TOKEN_PATH, {
          client_id: SHARED_APP.clientId,
          device_code: grant.deviceCode,
          grant_type: DEVICE_GRANT,
        }),
        `POST ${TOKEN_PATH}`,
      );
      if ("error" in answer) {
        switch (answer.error) {
          case "authorization_pending":
            return { kind: "pending", grant };
          case "slow_down":
            return { kind: "slow-down", grant: { ...grant, interval: grant.interval + SLOW_DOWN_MS } };
          case "expired_token":
            return { kind: "expired" };
          case "access_denied":
            return { kind: "denied" };
          default:
            throw new HostError("invalid", `GitHub refused the sign-in: ${answer.error}`);
        }
      }
      return { kind: "issued", tokens: tokens(answer) };
    },

    async person(token: string): Promise<HostLogin> {
      secret(token);
      const who = parse(person, (await api.request({ path: "/user", bearer: token })).body, "GET /user");
      return { id: who.id, login: who.login };
    },

    async refreshSignIn(signIn: SignIn): Promise<SignIn> {
      secret(signIn.refreshToken);
      const answer = parse(
        oauthAnswer,
        await post(TOKEN_PATH, {
          client_id: SHARED_APP.clientId,
          grant_type: "refresh_token",
          refresh_token: signIn.refreshToken,
        }),
        `POST ${TOKEN_PATH}`,
      );
      if ("error" in answer) {
        if (REFRESH_REFUSED.has(answer.error))
          throw signedOut(`GitHub no longer renews the sign-in (${answer.error})`);
        throw new HostError("invalid", `GitHub refused to renew the sign-in: ${answer.error}`);
      }
      return { ...tokens(answer), person: { ...signIn.person } };
    },
  };
}
