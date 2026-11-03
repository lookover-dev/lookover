// The health of what Lookover depends on, in words: the AIs, GitHub, the service, and each result of "Run all
// checks". The snapshot carries states and facts (`CheckItem` included); the status menu says them with these.
import {
  type CheckItem,
  type Connection,
  type ConnectionCause,
  type Engine,
  type EngineState,
  FAILED_SAFETY_CHECK,
  type Service,
  type SettingsFileError,
  type SettingsFileProblem,
  type State,
  UNFINISHED_SAFETY_CHECK,
  unusableStateText,
} from "@lookover/contracts";
import { type SignedOutCause, saidSignedOut } from "./accounts.ts";
import { atLoginStatus } from "./start-at-login.ts";

const ENGINE_STATE_TEXT: Record<EngineState, string> = {
  ready: "ready",
  "signed-out": "signed out",
  missing: "not installed",
  limit: "at its limit",
  "failed-self-test": FAILED_SAFETY_CHECK,
  "self-test-unfinished": UNFINISHED_SAFETY_CHECK,
};

/** "signed out"; "too old" for a program found too old for its model, which counts as not installed. */
export function engineStateText({ state, unusable }: Pick<Engine, "state" | "unusable">): string {
  return unusableStateText(unusable) ?? ENGINE_STATE_TEXT[state];
}

/**
 * An engine's fixes that read the engines again (`engine.check`, which tests at once every engine whose program hasn't
 * passed), as setup's AI row, the status menu and the alert band offer them: **Check again**, and **Try again** for a
 * safety check that couldn't finish (ADR 0075).
 */
export const ENGINE_CHECK_AGAIN = { label: "Check again", command: { type: "engine.check" } } as const;
export const ENGINE_TRY_AGAIN = { label: "Try again", command: { type: "engine.check" } } as const;

/**
 * Why GitHub can't be used, in a few words (ADR 0053): "App uninstalled", which a problem says after "GitHub".
 */
export function causeText(cause: ConnectionCause): string {
  if (saidSignedOut(cause)) return "signed out";
  if (cause.kind === "uninstalled") return cause.suspended ? "App suspended" : "App uninstalled";
  return CAUSE_TEXT[cause.kind];
}

/** The words of each cause said neither as signed out nor as the App's. */
const CAUSE_TEXT: Record<Exclude<ConnectionCause["kind"], SignedOutCause["kind"] | "uninstalled">, string> = {
  unreachable: "unreachable",
  sso: "SSO needed",
};

/**
 * "connected as sam", the person signed in, who posts (ADR 0066), or "connected" when the line doesn't know them (Run
 * checks'); "App uninstalled".
 */
export function connectionText({
  state,
  cause,
  person,
}: Pick<Connection, "state" | "cause"> & { person?: Connection["person"] }): string {
  if (state === "connected") return person ? `connected as ${person.login}` : "connected";
  if (state === "not-connected") return "not connected";
  return cause ? causeText(cause) : "disconnected";
}

/**
 * "running, starts at login": a service that answers is running (ADR 0046), then whether the machine has it
 * registered to start at login (ADR 0054); warned (`ok` false) when that isn't what the owner chose, the fix being
 * the alert band's (`problems`). In development: that start at login isn't set up.
 */
export function serviceStatus(service: Pick<Service, "startAtLogin" | "atLogin" | "loginItem">): {
  ok: boolean;
  text: string;
} {
  const { ok, text } = atLoginStatus(service);
  return { ok, text: `running, ${text}` };
}

const SETTINGS_FILE_PROBLEM: Record<SettingsFileProblem, (key: string | null) => string> = {
  unreadable: () => "it can't be opened",
  not_yaml: () => "it isn't YAML",
  wrong_version: () => "its version is unknown",
  unknown_key: (key) => `${key} isn't a setting`,
  wrong_type: (key) => `${key} has a wrong value`,
};

/** Whether `value` is a problem a settings file can have: the guard for a refusal's `invalid` (ADR 0049). */
export const isSettingsFileProblem = (value: unknown): value is SettingsFileProblem =>
  typeof value === "string" && Object.hasOwn(SETTINGS_FILE_PROBLEM, value);

/** "depht isn't a setting": why a settings file doesn't read (ADR 0049), as Run checks and a refused save say it. */
export function settingsFileProblemText({
  problem,
  key,
}: Pick<SettingsFileError, "problem" | "key">): string {
  return SETTINGS_FILE_PROBLEM[problem](key);
}

/** "settings.yaml ignored: depht isn't a setting": a settings file that doesn't read, and why (ADR 0049). */
function settingsFileText(error: SettingsFileError): string {
  return `${error.file} ignored: ${settingsFileProblemText(error)}`;
}

/**
 * One line of "Run all checks": what was checked, whether it is fine (`ok` null: no verdict, the fact alone), and
 * the detail.
 */
export function checkLine(
  engines: State["engines"],
  item: CheckItem,
): { label: string; ok: boolean | null; detail: string } {
  switch (item.check) {
    case "engine":
      return {
        label: engines[item.engine].name,
        ok: item.state === "ready",
        // One that can't be used says why, as the status menu does: the service's words, with this machine's
        // command that fixes it.
        detail:
          item.state === "ready"
            ? `signed in · ${item.cli} ${item.version}`
            : item.unusable
              ? item.detail
              : engineStateText(item),
      };
    case "connection":
      return {
        label: "GitHub",
        ok: item.state === "connected",
        detail: connectionText({ state: item.state, cause: item.cause }),
      };
    case "service": {
      const { ok, text } = serviceStatus(item);
      return { label: "Service", ok, detail: text };
    }
    case "settings": {
      const { invalid } = item;
      if (invalid.length === 0) return { label: "Settings", ok: true, detail: "every file reads" };
      return { label: "Settings", ok: false, detail: invalid.map(settingsFileText).join(" · ") };
    }
    case "disk":
      return { label: "Disk", ok: true, detail: `${item.freeGb} GB free` };
    case "version": {
      // Not checked against a newer version (null, ADR 0047): the version alone, and no verdict.
      const { version, upToDate } = item;
      if (upToDate === null) return { label: "Version", ok: null, detail: version };
      return {
        label: "Version",
        ok: upToDate,
        detail: `${version}, ${upToDate ? "up to date" : "an update is available"}`,
      };
    }
  }
}
