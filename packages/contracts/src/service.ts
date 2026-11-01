// The background service: paused or not, and its health checks. A service that answers is running: there is no
// "stopped" state and no command to start one, since a stopped service can't be reached from its own UI (ADR 0046).
import type { CodingAgent } from "./coding-agent.ts";
import type { Connection } from "./connection.ts";
import type { EngineId, EngineState } from "./engine.ts";
import type { EngineUnusable } from "./engines-port.ts";
import type { KeyProtection } from "./github-app.ts";
import type { SettingsFileError } from "./settings.ts";

/**
 * One health check's result, as data: what was checked and what was found. The UI says it in words. `version`'s
 * `upToDate` is null until Lookover can check for a newer version (never before publication, ADR 0047): the UI
 * then shows the version alone. `settings` lists each settings file that doesn't read, ignored until it is fixed
 * (ADR 0049): empty when every file reads.
 */
export type CheckItem =
  | {
      check: "engine";
      engine: EngineId;
      state: EngineState;
      cli: string;
      version: string | null;
      /** Why the program found can't be used (`Engine.unusable`), null otherwise. */
      unusable: EngineUnusable | null;
      /**
       * The service's words for it (`Engine.detail`, `engineDetailText`): written with the service's platform, which
       * the UI doesn't know, so an unusable one's command is this machine's.
       */
      detail: string;
    }
  | {
      check: "connection";
      state: Connection["state"];
      cause: Connection["cause"];
      bot: string | null;
      /** How the App's key is kept (ADR 0053); null when Lookover keeps none. */
      key: KeyProtection | null;
    }
  | {
      check: "service";
      state: "running";
      startAtLogin: boolean;
      atLogin: LoginHolder;
      loginItem: LoginItemKind;
    }
  | { check: "settings"; invalid: SettingsFileError[] }
  | { check: "disk"; freeGb: number }
  | { check: "version"; version: string; upToDate: boolean | null };

/**
 * Where start at login is registered (ADR 0054): `os`, on the machine (the program unguarded, and demo mode, which
 * plays it on a fake); `stand-in`, one that registers nothing and answers "none" (live mode and a guarded program,
 * ADR 0070), so the UI says start at login isn't set up in development rather than that Lookover starts.
 */
export type LoginItemKind = "os" | "stand-in";

/**
 * Who holds start at login on this computer (ADR 0068): there is one registration per user, and it belongs to the
 * install whose command it holds. `this`, this install's command; `none`; or another install's, with the command it
 * holds as the machine shows it (a moved clone or a swapped binary is another install).
 */
export type LoginHolder = "this" | "none" | { other: string };

/** Whether two answers of who holds start at login are the same. */
export const sameLoginHolder = (a: LoginHolder, b: LoginHolder): boolean =>
  typeof a === "string" || typeof b === "string" ? a === b : a.other === b.other;

export interface Service {
  state: "running";
  since: number;
  version: string;
  /**
   * Lookover's command (ADR 0058): the command line that reaches this Lookover from a terminal, which every screen
   * names: `lookover` when the PATH finds this executable, else the binary's absolute path, else `bun run lookover`
   * in a clone; then `--home=<folder>` when the data folder isn't the profile's. Sent with `service.changed` when it
   * changes.
   */
  command: string;
  /**
   * Your coding agent (ADR 0058): whether `lookover` on the PATH reaches this Lookover and whether Lookover offers to
   * make it so, and the skill in each found agent's folder. Read at start and again on each `agent.*` command
   * (`agent.check` reads it alone), sent with `service.changed` when it differs; a change of the PATH sends Lookover's
   * command with it.
   */
  agent: CodingAgent;
  /** The owner's choice to start Lookover at login (ADR 0054: on until they turn it off). */
  startAtLogin: boolean;
  /**
   * Who holds start at login now (ADR 0054, ADR 0068): the machine's answer, where `startAtLogin` is the choice. This
   * install only once the setup is done, and never by taking another install's over unless the owner asks. Demo mode's
   * is a registration kept in memory, which plays the machine's; in live mode and a guarded program, always "none":
   * their stand-in registers nothing, as `lookover status` says (ADR 0070).
   */
  atLogin: LoginHolder;
  /** Where that registration is: the machine's, or development's stand-in that registers nothing. */
  loginItem: LoginItemKind;
  paused: { since: number; until: number | null } | null;
  /** Server mode: reachable over the network, so actions ask to unlock first. */
  remote: boolean;
  unlocked: boolean;
  checks: { at: number; running: boolean; items: CheckItem[] } | null;
}

export type PauseFor = "hour" | "tomorrow" | "forever";
