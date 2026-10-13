// The confirm pass (ADR 0024, ADR 0044): a second session, on the other engine when it may and is ready, else on
// the finder, judges each new candidate on its own. What a finding, a run and a round record of it lives here;
// what one candidate's verdict is and what a refuted candidate leaves are in `round.ts`, with the candidates.
// Facts only: the words ("Checked by", "Unconfirmed", "Not double-checked") are the app's and `publish`'s.
import type { EngineId, EngineState } from "./engine.ts";
import type { EngineRunOutcome } from "./engines-port.ts";

/** What the confirmer answers for one candidate. `refuted` drops it from the findings, into the round's ruled out. */
export type ConfirmVerdict = "confirmed" | "refuted" | "unsure";

/**
 * A finding's confirmation, set by `core`'s confirm policy when the finding is raised and never changed after
 * (an earlier finding keeps its round's). `confirmed` and `unsure` name the confirmer (`by`), its one-sentence
 * reason and the lines it cites as proof (`path:line`), possibly none. `not_checked`: no confirm judged it (a
 * confirm pass that failed or left it out, a round-2 `consider`, depth Quick); the round says why when the pass
 * failed, and the app says "Not double-checked". Never `refuted`: a refuted candidate is no finding (`RuledOut`).
 * The policy (ADR 0044): the confirmer's severity comes first; a `blocking` finding that isn't confirmed, `unsure`
 * or `not_checked`, becomes `should_fix` with `demoted` true, which the app says "Should fix, unconfirmed"; a
 * confirmed one is never demoted.
 */
export type Confirmation =
  | { verdict: "confirmed"; by: EngineId; reason: string; evidence: string[] }
  | { verdict: "unsure"; by: EngineId; reason: string; evidence: string[]; demoted: boolean }
  | { verdict: "not_checked"; demoted: boolean };

/** The confirmation of a finding no confirm judged, its severity the finder's: the default every producer fills. */
export const NOT_CHECKED: Confirmation = Object.freeze({ verdict: "not_checked", demoted: false });

/**
 * Why the confirm runs on the finder, in a new session, instead of the other engine (ADR 0044), named by the
 * round plan when the job is taken. `engine` is the other engine, the one that doesn't confirm. `settings`: the
 * repository's reviewers leave it out. `not-own`: it may not review this change, which is not the owner's own from
 * the repository: another author's, or a fork's whoever wrote it (Codex reviews only the owner's own changes from
 * the repository while its reads aren't confined, ADR 0048). `not-ready`: it wasn't ready when the job was taken,
 * in that state.
 */
export type ConfirmFallback =
  | { reason: "settings" | "not-own"; engine: EngineId }
  | { reason: "not-ready"; engine: EngineId; state: Exclude<EngineState, "ready"> };

/**
 * Why a confirm pass gave no verdicts (ADR 0044: it never fails the job): the engine run's outcome other than
 * `ok`, or `unreadable` when it answered without a block that could be read. Its candidates are posted as found,
 * not checked. Also why Deep's second find pass gave no round (`SecondFind`), which never fails the job either.
 */
export type ConfirmFailure = Exclude<EngineRunOutcome, "ok"> | "unreadable";
