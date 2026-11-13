// "Sign in with GitHub", and Sign in again (ADR 0066): GitHub's device flow, run by the service. A start asks GitHub
// for a device code and shows it on the connection (`signIn`: the code, GitHub's page, its expiry); then the code is
// polled on the room's timers every `interval` GitHub gave; when GitHub asks to slow down, at the interval its answer
// carries, or 5 s more when it carries none, until the person enters it, refuses it, the code expires (it ends then,
// on a timer of its own, whatever a poll is doing; never polled past it: a code still shown past its expiry was
// entered), or the sign-in is cancelled. Entered, the code gives the tokens and is spent: it is never polled again.
// Whose they are is asked of GitHub with the token (`person`), again after the interval when GitHub can't answer (or
// once its limit lifts), until the token expires; only GitHub refusing the token (401) ends it there. The sign-in is
// then handed to `signedIn`, which keeps it before the code goes. A poll GitHub can't answer for now (down, a rate
// limit) is polled again after the interval, or once the limit lifts; any other refusal ends it. Each end clears the
// code shown and says why in the log. A poll that failed `unavailable` may have reached GitHub and lost the tokens'
// answer, spending the code (ADR 0095): the run remembers it until GitHub next says the code waits (`pending`,
// `slow-down`; a rate limit neither sets nor clears it), and while it does, the code's end (GitHub's `expired`, its
// refusal for good, its own expiry by the timer or the poll's guard) logs that the answer was lost, to sign in again,
// in place of "expired" or "refused". `denied`, an error that is no refusal of GitHub's, and what ends a sign-in once
// the tokens came keep their own words. The mark is the run's: each start begins clean. One sign-in at a time: a second start while one waits is refused. A
// cancel while GitHub gives the code is kept: the code is never shown. A cancel once the sign-in is being kept changes
// nothing: it ends as the keeping does. Stopping drops the poll armed, sending nothing more; a code a stopped service
// left on the connection is cleared by the next start (the room's).
// It must never know: where the sign-in is kept, the setup's steps, or how GitHub is reached (the `HostSignIn` port).
// It never logs or sends the device code GitHub polls with, nor a token.
import {
  type DeviceGrant,
  type EventBody,
  HostError,
  type HostSignIn,
  type SignIn,
  type SignInStartRefusal,
  type SignInTokens,
} from "@lookover/contracts";
import { signInLines } from "./log-lines.ts";
import { said } from "./said.ts";
import type { Timers } from "./timers.ts";

export interface DeviceFlowDeps {
  /** GitHub's side of it: the shared App's sign-in. */
  host: HostSignIn;
  timers: Timers;
  clock: { now(): number };
  emit(body: EventBody): void;
  /** The sign-in made: kept and held. What it throws is logged, the sign-in not kept (the store refused it). */
  signedIn(signIn: SignIn): Promise<void>;
  log(line: string): void;
}

export interface DeviceFlow {
  /**
   * A device code asked of GitHub and shown, then polled. Refused while one waits. Throws GitHub's refusal of the code (`HostError`), nothing shown then.
   */
  start(): Promise<"ok" | { refused: SignInStartRefusal }>;
  /**
   * The sign-in waiting given up: its code no longer shown; one GitHub is giving a code for, never shown. Nothing when
   * none waits, or once the sign-in is being kept.
   */
  cancel(): void;
  /** Nothing armed any more; a poll under way changes nothing once it answers. */
  stop(): void;
}

/**
 * What one poll leads to: another after `ms` with the grant as it now is (`unanswered`: why GitHub didn't answer, for
 * the log; `mark`: whether the code may now be spent unseen, `set`, `clear` or `kept` as it was), the code's own end
 * with the log's line (its expiry, GitHub refusing it: a lost answer may explain it), any other end with its line
 * (`denied`, an error that is no refusal of GitHub's), or the tokens, the code spent.
 */
type Next =
  | { wait: DeviceGrant; ms: number; unanswered: string | null; mark: "set" | "clear" | "kept" }
  | { codeEnd: string }
  | { end: string }
  | { issued: SignInTokens };

/** Whether GitHub can't answer for now (down, a rate limit): asked again later. */
const unanswered = (error: unknown): error is HostError =>
  error instanceof HostError && (error.failure === "unavailable" || error.failure === "rate_limited");

/** How long to wait after `error`, GitHub's limit lifting or the interval, whichever is later. */
const waitAfter = (error: HostError, interval: number, now: number) =>
  error.retryAt === undefined ? interval : Math.max(interval, error.retryAt - now);

/** One poll of `grant` at `now`: never past its expiry, and a poll GitHub can't answer for now is polled again. */
async function polled(host: HostSignIn, grant: DeviceGrant, now: number): Promise<Next> {
  if (now >= grant.expiresAt) return { codeEnd: signInLines.expired };
  try {
    const answer = await host.pollSignIn(grant);
    switch (answer.kind) {
      case "pending":
      case "slow-down":
        return { wait: answer.grant, ms: answer.grant.interval, unanswered: null, mark: "clear" };
      case "expired":
        return { codeEnd: signInLines.expired };
      case "denied":
        return { end: signInLines.denied };
      case "issued":
        return { issued: answer.tokens };
    }
  } catch (error) {
    if (!(error instanceof HostError)) return { end: signInLines.refused(said(error)) };
    if (!unanswered(error)) return { codeEnd: signInLines.refused(said(error)) };
    return {
      wait: grant,
      ms: waitAfter(error, grant.interval, now),
      unanswered: said(error),
      // Down may mean the poll reached GitHub and its answer was lost; a rate limit is GitHub answering.
      mark: error.failure === "unavailable" ? "set" : "kept",
    };
  }
}

/**
 * Whose `tokens` are, asked once at `now`: the sign-in, the end with the log's line (the token expired, or GitHub
 * refused it), or asked again after `ms` (GitHub can't answer for now, or answered something else).
 */
async function whose(
  host: HostSignIn,
  tokens: SignInTokens,
  interval: number,
  now: number,
): Promise<{ signIn: SignIn } | { end: string } | { ms: number; unanswered: string }> {
  if (now >= tokens.expiresAt)
    return { end: signInLines.refused("the token expired before GitHub said whose it is") };
  try {
    return { signIn: { ...tokens, person: await host.person(tokens.token) } };
  } catch (error) {
    if (error instanceof HostError && error.failure === "unauthorized")
      return { end: signInLines.refused(said(error)) };
    return {
      ms: unanswered(error) ? waitAfter(error, interval, now) : interval,
      unanswered: said(error),
    };
  }
}

export function createDeviceFlow(d: DeviceFlowDeps): DeviceFlow {
  /**
   * The sign-in waiting, by a token of its own: a poll that answers for an ended one does nothing. `keeping`: the
   * sign-in is in `signedIn`'s hands, a cancel no longer ends it.
   */
  let waiting: { cancel: () => void; keeping: boolean } | null = null;
  /** A code asked of GitHub and not given yet; `cancelled` once given up meanwhile. */
  let starting: { cancelled: boolean } | null = null;
  let stopping = false;

  const shown = (patch: { signIn: DeviceGrant | null }) => {
    const signIn =
      patch.signIn === null
        ? null
        : {
            userCode: patch.signIn.userCode,
            verificationUri: patch.signIn.verificationUri,
            expiresAt: patch.signIn.expiresAt,
          };
    d.emit({ type: "connection.changed", at: d.clock.now(), patch: { signIn } });
  };

  const run = (host: HostSignIn, first: DeviceGrant): void => {
    // `next`: the poll (or the ask) armed; `expiry`: the code's end at its expiry, dropped once the code is spent.
    const self = {
      next: () => {},
      expiry: () => {},
      cancel: () => {
        self.next();
        self.expiry();
      },
      keeping: false,
    };
    /** A poll's answer may have been lost since GitHub last said the code waits: the code may be spent unseen. */
    let answerLost = false;
    /** The line for the code's own end, `line` unless a lost answer explains it. */
    const codeEnd = (line: string) => (answerLost ? signInLines.answerLost : line);
    waiting = self;
    const live = () => waiting === self && !stopping;
    const end = (line: string) => {
      self.cancel();
      if (waiting !== self) return;
      waiting = null;
      d.log(line);
      if (!stopping) shown({ signIn: null });
    };
    const arm = (grant: DeviceGrant, ms: number) => {
      // Never polled past the code's expiry: it ends then, by `expiry`.
      if (d.clock.now() + ms >= grant.expiresAt) return;
      self.next = d.timers.after(ms, () => void poll(grant));
    };
    /** The poll's end, a lost answer saying why the code ended when it is the code's own. */
    const ended = (next: Extract<Next, { codeEnd: string }> | Extract<Next, { end: string }>) =>
      end("codeEnd" in next ? codeEnd(next.codeEnd) : next.end);
    /** Polled again as `next` says, why GitHub didn't answer logged when it didn't. */
    const again = (next: Extract<Next, { wait: DeviceGrant }>) => {
      if (next.mark !== "kept") answerLost = next.mark === "set";
      if (next.unanswered !== null) d.log(signInLines.unanswered(next.unanswered));
      arm(next.wait, next.ms);
    };
    /** The sign-in kept, then the code gone: the app sees the way move as the code leaves. */
    const keep = async (signIn: SignIn): Promise<void> => {
      self.keeping = true;
      const line = await d.signedIn(signIn).then(
        () => signInLines.signedIn(signIn.person.login),
        (error: unknown) => signInLines.notKept(said(error)),
      );
      // Stopped meanwhile, what happened is still said.
      if (waiting === self) end(line);
      else d.log(line);
    };
    /** Whose the tokens are asked, again on the timers while GitHub can't say; the code is never polled again. */
    const ask = async (tokens: SignInTokens, interval: number): Promise<void> => {
      if (!live()) return;
      const next = await whose(host, tokens, interval, d.clock.now());
      if (!live()) return;
      if ("end" in next) return end(next.end);
      if ("ms" in next) {
        d.log(signInLines.unanswered(next.unanswered));
        self.next = d.timers.after(next.ms, () => void ask(tokens, interval));
        return;
      }
      await keep(next.signIn);
    };
    const poll = async (grant: DeviceGrant): Promise<void> => {
      if (!live()) return;
      const next = await polled(host, grant, d.clock.now());
      if (!live()) return;
      if ("wait" in next) return again(next);
      if (!("issued" in next)) return ended(next);
      // The code is spent: from now on only the token's expiry ends the sign-in.
      self.expiry();
      await ask(next.issued, grant.interval);
    };
    shown({ signIn: first });
    // Ended at its expiry whatever a poll is doing then (GitHub slow, a rate limit): a code still shown past its
    // expiry was entered, and the sign-in is being finished.
    self.expiry = d.timers.after(Math.max(0, first.expiresAt - d.clock.now()), () =>
      end(codeEnd(signInLines.expired)),
    );
    arm(first, first.interval);
  };

  return {
    start: async () => {
      const { host } = d;
      if (waiting !== null || starting !== null) return { refused: "pending" };
      const asked = { cancelled: false };
      starting = asked;
      try {
        const grant = await host.startSignIn();
        // Given up while GitHub gave the code: never shown.
        if (!stopping && !asked.cancelled) run(host, grant);
      } finally {
        starting = null;
      }
      return "ok";
    },
    cancel: () => {
      if (starting !== null && !starting.cancelled) {
        starting.cancelled = true;
        d.log(signInLines.cancelled);
        return;
      }
      const now = waiting;
      if (now === null || now.keeping) return;
      now.cancel();
      waiting = null;
      d.log(signInLines.cancelled);
      if (!stopping) shown({ signIn: null });
    },
    stop: () => {
      stopping = true;
      waiting?.cancel();
      waiting = null;
    },
  };
}
