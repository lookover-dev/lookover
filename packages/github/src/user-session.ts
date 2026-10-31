// The person's session (ADR 0066): signed in to the shared App, one token for every repository, posting as the
// person. The sign-in is read from the keeper the caller gives (the data folder, sealed: never known here) on first
// use, and renewed five minutes before its token expires, one refresh at a time on the keeper, whichever session on
// it asks (the service builds two, discovery's and the ports'): the keeper is read again first, in
// case another process renewed it, and the renewed sign-in (its refresh token rotated, the old one spent) is written
// back before its token is used, only in place of the one it renews: a new sign-in kept meanwhile (Sign in again)
// stands, the renewal dropped and the new one used. A write that fails is `unavailable`, the renewed sign-in held in
// memory, shared by every session on the keeper, and written again before any of them refreshes or uses a token: it
// is the only one GitHub still takes. A token GitHub refuses (401) while not
// yet expired is renewed once and the call made again; a 401 on a token just renewed, a refresh GitHub refuses, or
// no sign-in kept is the connection's `signed-out`, and it stays so, with no refresh, until the keeper holds another
// sign-in: one kept later is taken with no restart. An act refused (403) with no cause GitHub names is the person's
// own permission, not the connection's: it is `invalid`, the act alone failing.
import {
  type Clock,
  connectionCauseOf,
  HostError,
  type HostSignIn,
  type RepositoryRef,
  SHARED_APP,
  type SignIn,
  type SignInKeeper,
} from "@lookover/contracts";
import { GitHubRefusal, message, ssoAsked } from "./api.ts";
import type { Poster, Session } from "./session.ts";
import { signedOut } from "./sign-in.ts";

/** A token is renewed this long before GitHub would expire it. */
const RENEW_MARGIN_MS = 5 * 60_000;

/** GitHub no longer takes the token: a 401, which a renewal may cure. */
const tokenRefused = (error: unknown): error is HostError =>
  error instanceof GitHubRefusal && error.status === 401;

const isSignedOut = (error: unknown) =>
  error instanceof HostError && connectionCauseOf(error)?.kind === "signed-out";

const sameSignIn = (a: SignIn, b: SignIn) => a.token === b.token && a.refreshToken === b.refreshToken;

/** A renewed sign-in not written yet, with the one it renews: the keeper's copy is spent, so this one is written first. */
interface Unkept {
  renewed: SignIn;
  from: SignIn;
}

/**
 * What the sessions on one keeper share (the service's discovery and its ports): their turn, so they renew one after
 * the other and the second reads the sign-in the first kept instead of spending the refresh token again, which GitHub
 * would refuse, signing the person out; and the renewal the keeper failed to write, whichever session renewed it,
 * written again before any of them refreshes or uses a token.
 */
interface KeeperShare {
  turn: Promise<unknown>;
  unkept: Unkept | null;
}

const shares = new WeakMap<SignInKeeper, KeeperShare>();

function shareOf(keeper: SignInKeeper): KeeperShare {
  let share = shares.get(keeper);
  if (share === undefined) {
    share = { turn: Promise.resolve(), unkept: null };
    shares.set(keeper, share);
  }
  return share;
}

/** `act` run once every turn asked before it on `share`'s keeper has settled. */
function inTurn<T>(share: KeeperShare, act: () => Promise<T>): Promise<T> {
  const run = share.turn.then(act, act);
  share.turn = run.catch(() => {});
  return run;
}

export class UserSession implements Session {
  readonly appId: number = SHARED_APP.id;
  private readonly signIn: HostSignIn;
  private readonly keeper: SignInKeeper;
  private readonly clock: Clock;
  private readonly secret: (value: string) => void;
  private readonly share: KeeperShare;
  private held: SignIn | null = null;
  /** The sign-in GitHub refused: while the keeper holds it, the person is signed out, nothing refreshed. */
  private refused: SignIn | null = null;
  private renewing: Promise<SignIn> | null = null;

  constructor(signIn: HostSignIn, keeper: SignInKeeper, clock: Clock, secret: (value: string) => void) {
    this.signIn = signIn;
    this.keeper = keeper;
    this.clock = clock;
    this.secret = secret;
    this.share = shareOf(keeper);
  }

  /** Runs `call` with the person's token, whatever the repository or the scope: a user token can't be narrowed. */
  async withToken<T>(repo: RepositoryRef, call: (token: string) => Promise<T>): Promise<T> {
    try {
      return await this.asPerson(call);
    } catch (error) {
      throw actOnly(error, repo.owner);
    }
  }

  /**
   * Runs `call` with the person's token, on no repository (who they are, the installations they reach): a token
   * GitHub no longer takes renewed once, and signed out after a renewal; any other refusal as GitHub gave it.
   */
  async asPerson<T>(call: (token: string) => Promise<T>): Promise<T> {
    const { signIn, renewed } = await this.current();
    try {
      return await call(signIn.token);
    } catch (error) {
      if (!tokenRefused(error)) throw error;
      if (renewed) throw this.signOut(signIn, error);
    }
    const again = await this.renew(signIn);
    try {
      return await call(again.token);
    } catch (error) {
      if (tokenRefused(error)) throw this.signOut(again, error);
      throw error;
    }
  }

  /** Who posts: the signed-in person, as the sign-in names them (`GET /user` when they signed in). */
  async poster(): Promise<Poster> {
    const { signIn } = await this.current();
    return { id: signIn.person.id, login: signIn.person.login, bot: false };
  }

  /** The sign-in to use now: one renewed but unkept written first, renewed when its token expires within the margin. */
  private async current(): Promise<{ signIn: SignIn; renewed: boolean }> {
    if (this.share.unkept !== null) await inTurn(this.share, () => this.keepUnkept());
    this.held ??= await this.read();
    const held = this.held;
    if (this.fresh(held)) return { signIn: held, renewed: false };
    return { signIn: await this.renew(held), renewed: true };
  }

  /**
   * One renewal at a time: a call that needs one while another runs waits for it, and so does one of another session
   * on the same keeper.
   */
  private renew(stale: SignIn): Promise<SignIn> {
    this.renewing ??= inTurn(this.share, async () => {
      await this.keepUnkept();
      return this.refresh(stale);
    })
      .catch((error: unknown) => {
        this.held = null;
        throw error;
      })
      .finally(() => {
        this.renewing = null;
      });
    return this.renewing;
  }

  /**
   * The kept sign-in read again: one another process renewed (another token, still fresh) is taken as it is;
   * otherwise it is refreshed and written back before its token is used. A refresh GitHub refuses signs it out. A
   * sign-in kept while GitHub renewed (the person signed in again) wins: the renewal is dropped, the new one used.
   */
  private async refresh(stale: SignIn): Promise<SignIn> {
    const kept = await this.read();
    if (kept.token !== stale.token && this.fresh(kept)) {
      this.held = kept;
      return kept;
    }
    let renewed: SignIn;
    try {
      renewed = await this.signIn.refreshSignIn(kept);
    } catch (error) {
      if (isSignedOut(error)) this.refused = kept;
      throw error;
    }
    if (await this.keep(renewed, kept)) return renewed;
    return this.replacement();
  }

  /**
   * The renewal the keeper failed to write, by any session on it, written now (in the keeper's turn): until it is,
   * nothing is refreshed (the kept refresh token is spent) or used (`unavailable` again).
   */
  private async keepUnkept(): Promise<void> {
    const unkept = this.share.unkept;
    if (unkept === null) return;
    await this.keep(unkept.renewed, unkept.from);
  }

  /** The sign-in kept in place of the one renewed: used as it is while fresh, else renewed in turn. */
  private async replacement(): Promise<SignIn> {
    const now = await this.read();
    this.held = now;
    return this.fresh(now) ? now : this.refresh(now);
  }

  /**
   * `renewed` written to the keeper in place of `from`, then held: false, nothing held, when another sign-in replaced
   * `from` meanwhile. A write that fails keeps it as unkept and is `unavailable`.
   */
  private async keep(renewed: SignIn, from: SignIn): Promise<boolean> {
    let written: boolean;
    try {
      written = await this.keeper.write(renewed, from);
    } catch (error) {
      this.share.unkept = { renewed, from };
      throw new HostError("unavailable", `The renewed sign-in could not be kept: ${message(error)}`);
    }
    this.share.unkept = null;
    this.held = written ? renewed : null;
    return written;
  }

  /** `signIn` refused by GitHub: forgotten, and the person signed out while the keeper holds it. */
  private signOut(signIn: SignIn, error: HostError): HostError {
    this.held = null;
    this.refused = signIn;
    return signedOut(error.message);
  }

  /** The kept sign-in; none, or the one GitHub refused, is signed out. */
  private async read(): Promise<SignIn> {
    const kept = await this.keeper.read();
    if (kept === null) throw signedOut("Nobody is signed in to the shared App");
    if (this.refused !== null && sameSignIn(kept, this.refused))
      throw signedOut("GitHub refused this sign-in: the person must sign in again");
    this.refused = null;
    this.secret(kept.token);
    this.secret(kept.refreshToken);
    return kept;
  }

  private fresh(signIn: SignIn): boolean {
    return signIn.expiresAt - RENEW_MARGIN_MS > this.clock.now();
  }
}

/**
 * A refusal of the act alone: an act refused (a 403, GraphQL's `FORBIDDEN`; a 401 never reaches here) asking for
 * SAML SSO is the cause `sso` of the repository's account, `organisation` (ADR 0066: that account's, never the
 * connection's); one with no cause GitHub names is the person's own permission on that repository, never the
 * connection's, so it is `invalid` (sent again unchanged, refused again). Any other error as it is.
 */
function actOnly(error: unknown, organisation: string): unknown {
  if (!(error instanceof HostError) || error.failure !== "unauthorized") return error;
  if (error.connectionCause !== undefined) return error;
  const sso = ssoAsked(error);
  if (sso !== null)
    return new HostError("unauthorized", error.message, {
      connectionCause: { kind: "sso", organisation, url: sso.url },
    });
  return new HostError("invalid", error.message);
}
