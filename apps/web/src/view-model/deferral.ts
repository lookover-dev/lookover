// Why a review waits (ADR 0029): the one wording of a deferral, contracts' `copy.ts`, which the check on GitHub says
// too. Every screen that says why a review waits (the row, the review page, the history, the simulated GitHub page)
// says it with these words.
import type { Deferral, Engine, EngineId, Service, State } from "@lookover/contracts";
import { asSentence, deferralText, unusableFixedText } from "@lookover/contracts";
import { clock, startsAt } from "./format.ts";

export { deferralText };

const STARTS: Record<Deferral["reason"], string> = {
  paused: "This one starts when you resume.",
  connection: "This review starts when it is back.",
  "engine-signed-out": "This review starts by itself once you sign in.",
  "engine-missing": "This review starts by itself once it is.",
  "engine-limit": "This review starts when the limit resets.",
  "engine-failed-self-test": "This review starts by itself once a version passes it.",
};

/** What a deferred review's notice reads beside its deferral: the service's clock, the pause, each AI's limit. */
export interface Around extends Pick<State, "now"> {
  paused: Service["paused"];
  engines: Record<EngineId, Pick<Engine, "limitUntil">>;
}

/**
 * The notice on a deferred review's page: why it waits, and when it starts. A timed pause says until when
 * (ADR 0040); an AI's limit with a known reset says when it resets, on the service's clock (ADR 0055). One waiting
 * its turn says what it waits behind (`select.ts`'s `waitNotice`).
 */
export function waitingNotice(deferral: Deferral, around: Around): string {
  const { paused } = around;
  if (deferral.reason === "paused" && paused?.until) {
    return `Reviews are paused until ${clock(paused.until)}. This one starts then.`;
  }
  const text = deferralText(deferral);
  const reset = deferral.reason === "engine-limit" ? around.engines[deferral.engine].limitUntil : null;
  const starts = reset ? `This review starts ${startsAt(around.now, reset)}.` : startsWhen(deferral);
  return `${asSentence(text)} ${starts}`;
}

/** When a deferred review starts, beside its deferral: a program found but not usable says what fixes it. */
function startsWhen(deferral: Deferral): string {
  if (deferral.reason !== "engine-missing" || deferral.unusable === null) return STARTS[deferral.reason];
  return `This review starts by itself once ${unusableFixedText(deferral.unusable, deferral.engine, "you")}.`;
}
