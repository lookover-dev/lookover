// An engine: the AI program that reviews, named after the program (`claude`, `codex`), never after the plan
// it signs in with (ADR 0030). Whether it can review right now.
import type { EngineUnusable } from "./engines-port.ts";

export type EngineId = "claude" | "codex";
/**
 * `failed-self-test`: the installed version failed Lookover's self-test (ADR 0044): the engine isn't used until a
 * version passes. While the self-test runs, the engine counts as busy, not as another state.
 */
export type EngineState = "ready" | "signed-out" | "missing" | "limit" | "failed-self-test";

export interface Engine {
  id: EngineId;
  name: string;
  cli: string;
  version: string | null;
  state: EngineState;
  /**
   * Plan or account, shown when ready; when signed out or not installed, why, when the engine said more (Codex
   * signed in with an API key or a token counts as signed out, ADR 0044), for the status menu: the service words
   * `EngineHealth.why` with `engineHealthText`.
   */
  detail: string;
  /**
   * Why a program that was found can't be used, as a fact (`EngineHealth.why`): what `detail` words, so the UI can
   * name the cause in its own few words (a Codex too old says "too old", not "not installed"). Null otherwise.
   */
  unusable: EngineUnusable | null;
  /** When the state last changed. */
  since: number;
  limitUntil: number | null;
  /** The user opened a terminal to sign in and we are polling. */
  signingIn: boolean;
}
