// Signing a person in to the shared App (ADR 0065, ADR 0066): GitHub's device flow, with the App's client ID and no
// secret, gives a token for every repository the person reaches through the App, a refresh token that renews it,
// and their expiries. The host's side is a port (`HostSignIn`); where the sign-in is kept is another
// (`SignInKeeper`), so the adapter never knows the disk or the keychain.
import type { HostLogin } from "./github-app.ts";

/** What the person is shown while a sign-in waits: the code to enter, GitHub's page to enter it on, until when. */
export interface DeviceCode {
  /** The code the person types on GitHub's page, as GitHub gives it (`ABCD-1234`). */
  userCode: string;
  /** GitHub's page where the code is entered (`https://github.com/login/device`). */
  verificationUri: string;
  /** When the code expires, in milliseconds since the Unix epoch. */
  expiresAt: number;
}

/** A device code as the host gave it: what the person is shown, and what only the host and Lookover hold. */
export interface DeviceGrant extends DeviceCode {
  /** The code Lookover polls with: a credential, never shown or logged. */
  deviceCode: string;
  /** How long to wait before the next poll, in milliseconds: GitHub's `interval`, 5 s more after each `slow_down`. */
  interval: number;
}

/**
 * A sign-in as Lookover keeps it: the person's token, the refresh token that renews it, each one's expiry (ms since
 * the Unix epoch), and who the person is (`GET /user`), the one Lookover posts as. Both tokens are credentials.
 */
export interface SignIn {
  token: string;
  expiresAt: number;
  refreshToken: string;
  refreshExpiresAt: number;
  person: HostLogin;
}

/** A sign-in's tokens as the host issued them, before Lookover knows whose they are (`HostSignIn.person`). */
export type SignInTokens = Omit<SignIn, "person">;

/**
 * One poll of a device code. `pending`: the person hasn't entered it yet, poll again after `grant.interval`;
 * `slow-down`: the same, GitHub asked to wait 5 s more, which `grant.interval` holds now. `expired`: the code ran out
 * before it was entered; `denied`: the person refused on GitHub's page. `issued`: the tokens, the code spent with
 * them: never polled again, whatever happens next.
 */
export type DevicePoll =
  | { kind: "pending"; grant: DeviceGrant }
  | { kind: "slow-down"; grant: DeviceGrant }
  | { kind: "expired" }
  | { kind: "denied" }
  | { kind: "issued"; tokens: SignInTokens };

/**
 * The host's side of a sign-in (ADR 0066). `startSignIn` asks for a device code; `pollSignIn` asks once whether it was
 * entered, never waiting itself, and gives the tokens as soon as the host issues them; `person` reads whose a token is
 * (asked again, never the code, when the host can't answer: `unavailable`, `rate_limited`; a token it refuses is
 * `unauthorized`); `refreshSignIn` renews a sign-in with its refresh token, which the host rotates: the
 * answer holds a new one, the old one spent. A refresh the host refuses (`bad_refresh_token`: expired, revoked or
 * already spent; `incorrect_client_credentials`: unknown to it) is `unauthorized` with the connection's cause `signed-out`; an unreachable host is `unavailable`.
 * Every refusal is a `HostError`.
 */
export interface HostSignIn {
  startSignIn(): Promise<DeviceGrant>;
  pollSignIn(grant: DeviceGrant): Promise<DevicePoll>;
  person(token: string): Promise<HostLogin>;
  refreshSignIn(signIn: SignIn): Promise<SignIn>;
}

/**
 * Where the sign-in is kept (ADR 0066: sealed in the data folder, like the App's key): read again before each
 * refresh, in case another process renewed it first, and written with the rotated refresh token before the new
 * token is used. `read` gives null when none is kept. `write` keeps `renewed` in place of `from`, the sign-in it
 * renews, only while `from` is still the one kept (the same token and refresh token), in one turn with the keeper's
 * other writes: false, nothing written, when another replaced it meanwhile (the person signed in again), so a
 * renewal never puts back the sign-in a new one replaced.
 */
export interface SignInKeeper {
  read(): Promise<SignIn | null>;
  write(renewed: SignIn, from: SignIn): Promise<boolean>;
}

/**
 * Why "Sign in with GitHub" didn't start (`connection.signIn`, answered as the 409's `signIn`), as data the app words:
 * `unavailable`, no shared App is offered here; `own-app`, Lookover runs as its own App here; `pending`, a sign-in
 * already waits for its code.
 */
export type SignInStartRefusal = "unavailable" | "own-app" | "pending";
