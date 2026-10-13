// The health of what Lookover depends on, in words: the AIs, GitHub, the service, and each result of "Run all
// checks". The snapshot carries states and facts (`CheckItem` included); the status menu says them with these.
import {
  type CheckItem,
  type Connection,
  type ConnectionApp,
  type ConnectionCause,
  type Engine,
  type EngineState,
  engineHealthText,
  FAILED_SAFETY_CHECK,
  type KeyProtection,
  type Service,
  type SettingsFileError,
  type SettingsFileProblem,
  type State,
  unusableStateText,
} from "@lookover/contracts";
import { atLoginStatus } from "./start-at-login.ts";

const ENGINE_STATE_TEXT: Record<EngineState, string> = {
  ready: "ready",
  "signed-out": "signed out",
  missing: "not installed",
  limit: "at its limit",
  "failed-self-test": FAILED_SAFETY_CHECK,
};

/** "signed out"; "too old" for a program found too old for its model, which counts as not installed. */
export function engineStateText({ state, unusable }: Pick<Engine, "state" | "unusable">): string {
  return unusableStateText(unusable) ?? ENGINE_STATE_TEXT[state];
}

/** Why GitHub can't be used, in a few words (ADR 0053): "App uninstalled", which a problem says after "GitHub". */
export function causeText(cause: ConnectionCause): string {
  switch (cause.kind) {
    case "unreachable":
      return "unreachable";
    case "uninstalled":
      return cause.suspended ? "App suspended" : "App uninstalled";
    case "key-refused":
      return "key refused";
    case "key-lost":
      return "key lost";
    case "not-a-member":
      return "membership lost";
  }
}

/**
 * Where the App is (ADR 0059): "the ledger-dev organisation", or "your GitHub account" when the account is the
 * person's own.
 */
export function accountText({ account, person }: Pick<ConnectionApp, "account" | "person">): string {
  if (account.type === "Organization") return `the ${account.login} organisation`;
  return account.id === person.id ? "your GitHub account" : `${account.login}'s GitHub account`;
}

/**
 * "connected as sam-reviewer[bot]", "App uninstalled"; with the App, the status menu names its account: "connected as
 * sam-reviewer[bot], on the ledger-dev organisation". Run checks' line has no App (`app` null).
 */
export function connectionText({
  state,
  cause,
  bot,
  app,
}: Pick<Connection, "state" | "cause" | "bot" | "app">): string {
  if (state === "connected")
    return app ? `connected as ${bot}, on ${accountText(app)}` : `connected as ${bot}`;
  if (state === "not-connected") return "not connected";
  return cause ? causeText(cause) : "disconnected";
}

/** How the App's key is kept (ADR 0053), as Run checks says it beside the connection. */
const KEY_TEXT: Record<KeyProtection, string> = {
  keychain: "key in the keychain",
  "user-file": "key unencrypted in a user-only file: no keychain",
};

/**
 * "running, starts at login": a service that answers is running (ADR 0046), then whether the machine has it
 * registered to start at login (ADR 0054); warned (`ok` false) when that isn't what the owner chose, the fix being
 * the alert band's (`problems`). In development: that start at login isn't set up.
 */
export function serviceStatus(service: Pick<Service, "startAtLogin" | "startsAtLogin" | "loginItem">): {
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
        // One that can't be used says why, as the status menu does: the command that fixes it included.
        detail:
          item.state === "ready"
            ? `signed in · ${item.cli} ${item.version}`
            : item.unusable
              ? engineHealthText(item.unusable, item.engine)
              : engineStateText(item),
      };
    case "connection":
      return {
        label: "GitHub",
        ok: item.state === "connected",
        detail: item.key
          ? `${connectionText({ ...item, app: null })} · ${KEY_TEXT[item.key]}`
          : connectionText({ ...item, app: null }),
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
