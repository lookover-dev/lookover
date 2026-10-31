// The contract of the `HostSignIn` port (ADR 0066), written once: GitHub's device flow for the shared App and the
// refresh of a sign-in, run against `FakeGitHost` in every check. The device-flow half needs a person to enter the
// code on GitHub's page, so it never runs live: its setup is the fake's only. The refresh half can run on a real
// sign-in, though each run spends its refresh token (GitHub rotates it): `renewed` is given each renewed sign-in to
// write back. Spending one refresh token twice is the fake's case only (`spentTwice`): live, GitHub may answer its
// reuse by revoking the whole grant. Each case asks `setup` for a fresh adapter in the state it needs; a state it gives none of is skipped.
// Refusals are read as the service reads them, through `connectionCauseOf`.
import { describe, expect, test } from "bun:test";
import {
  type ConnectionCause,
  connectionCauseOf,
  type DeviceCode,
  type DevicePoll,
  HostError,
  type HostFailure,
  type HostLogin,
  type HostSignIn,
  type SignIn,
} from "@lookover/contracts";

export interface SignInFixture {
  signIn: HostSignIn;
}

/** A host whose device flow a test drives: the person at GitHub's page, and the host's clock. */
export interface DeviceFlowFixture extends SignInFixture {
  /** Who signs in: the person the sign-in must name. */
  person: HostLogin;
  /** The person enters the code on GitHub's page and authorises the App. */
  enter(code: DeviceCode): Promise<void>;
  /** The person refuses on GitHub's page. */
  deny(code: DeviceCode): Promise<void>;
  /** Time passes on the host's clock. */
  later(ms: number): void;
  now(): number;
}

/** A sign-in the host gave, to refresh. */
export interface RefreshFixture extends SignInFixture {
  kept: SignIn;
  now(): number;
  /**
   * Given each sign-in a refresh renewed, to write back where `kept` came from: the refresh spent `kept`'s refresh
   * token, so a live run that drops the renewed one signs its person out.
   */
  renewed?(signIn: SignIn): Promise<void>;
}

export interface SignInSetup {
  /** A host to sign in on with the device flow. None (live: nobody enters a code): its cases are skipped. */
  deviceFlow?: () => Promise<DeviceFlowFixture>;
  /** A sign-in to refresh. None: its cases are skipped. */
  signedIn?: () => Promise<RefreshFixture>;
  /**
   * A sign-in whose refresh token may be spent twice. The fake's only: a real refresh token asked again may make
   * GitHub revoke the whole grant, signing its person out. None: skipped.
   */
  spentTwice?: () => Promise<RefreshFixture>;
  /** A sign-in whose App authorisation the person took back on GitHub. None: skipped. */
  revoked?: () => Promise<RefreshFixture>;
  /** The host out of reach. None: skipped. */
  unreachable?: () => Promise<SignInFixture>;
}

const SIGNED_OUT: ConnectionCause = { kind: "signed-out" };

async function refused(call: Promise<unknown>, failure: HostFailure, cause: ConnectionCause) {
  const error = await call.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HostError);
  if (!(error instanceof HostError)) return;
  expect([error.failure, connectionCauseOf(error)]).toEqual([failure, cause]);
}

/** How `call` failed: its `HostError`'s failure, or what it gave instead. */
async function failureOf(call: Promise<unknown>): Promise<unknown> {
  const error = await call.then(
    (given) => given,
    (e: unknown) => e,
  );
  return error instanceof HostError ? error.failure : error;
}

/** A sign-in's tokens and expiries, as any valid one holds them at `now`. */
function expectSignIn(signIn: SignIn, person: HostLogin, now: number) {
  expect(signIn.person).toEqual(person);
  expect(signIn.token).not.toBe("");
  expect(signIn.refreshToken).not.toBe("");
  expect(signIn.refreshToken).not.toBe(signIn.token);
  expect(signIn.expiresAt).toBeGreaterThan(now);
  expect(signIn.refreshExpiresAt).toBeGreaterThan(signIn.expiresAt);
}

/** The sign-in a poll's tokens make, with whose they are asked of the host. */
async function signedInOf(signIn: HostSignIn, poll: DevicePoll): Promise<SignIn> {
  if (poll.kind !== "issued") throw new Error(`Expected tokens, got ${poll.kind}`);
  return { ...poll.tokens, person: await signIn.person(poll.tokens.token) };
}

export function describeSignIn(name: string, setup: SignInSetup): void {
  const { deviceFlow, signedIn, spentTwice, revoked, unreachable } = setup;
  const device = deviceFlow ? test : test.skip;
  const refresh = signedIn ? test : test.skip;
  describe(`HostSignIn port: ${name}`, () => {
    device("a device code says what to enter, where, until when, and how often to ask", async () => {
      if (!deviceFlow) return;
      const f = await deviceFlow();
      const grant = await f.signIn.startSignIn();
      expect(grant.userCode).not.toBe("");
      expect(grant.deviceCode).not.toBe("");
      expect(grant.verificationUri).toBe("https://github.com/login/device");
      expect(grant.expiresAt).toBeGreaterThan(f.now());
      expect(grant.interval).toBeGreaterThanOrEqual(5_000);
    });

    device(
      "a code not entered yet is pending; asked again too soon, the host asks to wait 5 s more",
      async () => {
        if (!deviceFlow) return;
        const f = await deviceFlow();
        const grant = await f.signIn.startSignIn();
        expect(await f.signIn.pollSignIn(grant)).toEqual({ kind: "pending", grant });
        const slowed = await f.signIn.pollSignIn(grant);
        expect(slowed).toEqual({ kind: "slow-down", grant: { ...grant, interval: grant.interval + 5_000 } });
        if (slowed.kind !== "slow-down") return;
        f.later(slowed.grant.interval);
        expect(await f.signIn.pollSignIn(slowed.grant)).toEqual({ kind: "pending", grant: slowed.grant });
      },
    );

    device("the code entered signs the person in: both tokens, their expiries, who they are", async () => {
      if (!deviceFlow) return;
      const f = await deviceFlow();
      const grant = await f.signIn.startSignIn();
      await f.enter(grant);
      expectSignIn(await signedInOf(f.signIn, await f.signIn.pollSignIn(grant)), f.person, f.now());
    });

    device("a code gives its tokens once: polled again, the host refuses it", async () => {
      if (!deviceFlow) return;
      const f = await deviceFlow();
      const grant = await f.signIn.startSignIn();
      await f.enter(grant);
      expect((await f.signIn.pollSignIn(grant)).kind).toBe("issued");
      f.later(grant.interval);
      expect(await failureOf(f.signIn.pollSignIn(grant))).toBe("invalid");
    });

    device("a token the host never issued is refused: nobody's", async () => {
      if (!deviceFlow) return;
      const f = await deviceFlow();
      expect(await failureOf(f.signIn.person("ghu_never_issued"))).toBe("unauthorized");
    });

    device("the code refused on the host's page is denied", async () => {
      if (!deviceFlow) return;
      const f = await deviceFlow();
      const grant = await f.signIn.startSignIn();
      await f.deny(grant);
      expect(await f.signIn.pollSignIn(grant)).toEqual({ kind: "denied" });
    });

    device("a code not entered before it runs out is expired", async () => {
      if (!deviceFlow) return;
      const f = await deviceFlow();
      const grant = await f.signIn.startSignIn();
      f.later(grant.expiresAt - f.now());
      expect(await f.signIn.pollSignIn(grant)).toEqual({ kind: "expired" });
    });

    refresh("a refresh renews both tokens and keeps the person", async () => {
      if (!signedIn) return;
      const f = await signedIn();
      const renewed = await f.signIn.refreshSignIn(f.kept);
      await f.renewed?.(renewed);
      expectSignIn(renewed, f.kept.person, f.now());
      expect(renewed.token).not.toBe(f.kept.token);
      expect(renewed.refreshToken).not.toBe(f.kept.refreshToken);
    });

    (spentTwice ? test : test.skip)(
      "a refresh token renews once: spent, it signs the person out",
      async () => {
        if (!spentTwice) return;
        const f = await spentTwice();
        // Apart, not inside `renewed?.(…)`: with no `renewed`, its argument would never be asked.
        const renewed = await f.signIn.refreshSignIn(f.kept);
        await f.renewed?.(renewed);
        await refused(f.signIn.refreshSignIn(f.kept), "unauthorized", SIGNED_OUT);
      },
    );

    (revoked ? test : test.skip)(
      "the App's authorisation taken back, its refresh token signs the person out",
      async () => {
        if (!revoked) return;
        const f = await revoked();
        await refused(f.signIn.refreshSignIn(f.kept), "unauthorized", SIGNED_OUT);
      },
    );

    (unreachable ? test : test.skip)("the host out of reach is unreachable, never signed out", async () => {
      if (!unreachable) return;
      const f = await unreachable();
      await refused(f.signIn.startSignIn(), "unavailable", { kind: "unreachable" });
    });
  });
}
