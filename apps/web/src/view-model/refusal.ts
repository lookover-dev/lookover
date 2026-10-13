// A command the service refused, and the words for it: the band's Refused line and the toast say "Lookover
// couldn't do that." and the reason the UI knows from the status and the service's answer (spec #105): its
// `error` line, or a settings refusal's data and code (ADR 0049), is read to pick the sentence, never shown. A
// status or answer with no words here gets the title alone; the console keeps the service's. The session screen's sentence is here too: the one screen shown without a state.

import {
  type AgentRefusal,
  APP_PERMISSIONS,
  type AppPermission,
  type Command,
  type CreateAppRefusal,
  createAppRefusalText,
  type GhRefusal,
  type GhWhy,
  type SettingsFileError,
  type SettingsRefusal,
  type SettingsWriteFailure,
  type UseAppRefusal,
} from "@lookover/contracts";
import { Refused } from "../api/http.ts";
import type { WebMode } from "../dev/mode.ts";
import type { WithCommand } from "./format.ts";
import { isSettingsFileProblem, settingsFileProblemText } from "./health.ts";
import { useAppRefusalText } from "./onboarding.ts";
import { devCommand } from "./start-at-login.ts";

/**
 * A command the service refused: the status it answered (0: the request never reached it), its own words, and the
 * data a settings save was refused with (ADR 0049): the file that doesn't read, the file that couldn't be written, or
 * the code of a refusal no file is at fault for; or why an App was refused (ADR 0053): `useApp` for "Use an existing
 * App", `createApp` for "Create it on GitHub", which the setup's GitHub step shows in place too; or why Your coding
 * agent's command did nothing (`agent`, ADR 0058). With the command refused, when the app sent one: Your coding
 * agent's are said on the refusal line under its rows (`agentRefusal`), not in the toast.
 */
export interface Refusal {
  status: number;
  error: string | null;
  invalid?: SettingsFileError;
  unwritten?: SettingsWriteFailure;
  refused?: SettingsRefusal;
  useApp?: UseAppRefusal;
  createApp?: CreateAppRefusal;
  agent?: AgentRefusal;
  command?: Command;
}

/**
 * A settings command refused with no file at fault (ADR 0049), by the code the service sent: a rule gone from the rules
 * files, "Too noisy?" on a finding the pull request hasn't or that follows no rule, "This finding is wrong" on one
 * settled meanwhile or while a round runs, a repository whose name can't be a folder (`con` on Windows).
 */
const REFUSED: Record<SettingsRefusal, string> = {
  no_such_rule: "That rule isn't in the rules files any more.",
  no_such_finding: "That finding isn't on this pull request.",
  no_rule: "That finding follows no rule.",
  settled: "That finding is already settled, or isn't on the pull request.",
  reviewing: "A review of this pull request is running. Try again once it is posted.",
  unnamed: "This repository's name can't be a folder on this computer, so its settings can't be saved.",
};
const WHY: Record<SettingsWriteFailure["why"], true> = { "held-open": true, other: true };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isRefused = (value: unknown): value is SettingsRefusal =>
  typeof value === "string" && Object.hasOwn(REFUSED, value);
const isWhy = (value: unknown): value is SettingsWriteFailure["why"] =>
  typeof value === "string" && Object.hasOwn(WHY, value);

/** The answer's `invalid`, when it is a settings file's error. */
function invalidOf(answer: unknown): SettingsFileError | null {
  if (!isRecord(answer) || !isRecord(answer.invalid)) return null;
  const { file, problem, key } = answer.invalid;
  if (
    typeof file !== "string" ||
    !isSettingsFileProblem(problem) ||
    !(typeof key === "string" || key === null)
  )
    return null;
  return { file, problem, key };
}

/** The answer's `unwritten`, when it is a settings file that couldn't be written. */
function unwrittenOf(answer: unknown): SettingsWriteFailure | null {
  if (!isRecord(answer) || !isRecord(answer.unwritten)) return null;
  const { file, why } = answer.unwritten;
  return typeof file === "string" && isWhy(why) ? { file, why } : null;
}

/** Every kind of `UseAppRefusal` and of `CreateAppRefusal`: a kind the UI doesn't know is not taken. */
const USE_APP: Record<UseAppRefusal["kind"], true> = {
  "not-a-key": true,
  "key-refused": true,
  "gh-missing": true,
  "gh-signed-out": true,
  "gh-unanswered": true,
  "not-a-member": true,
  "another-person": true,
  "missing-permissions": true,
  "another-app": true,
  unreachable: true,
  "live-config": true,
};
const CREATE_APP: Record<CreateAppRefusal["kind"], true> = {
  "live-config": true,
  "already-made": true,
  "gh-missing": true,
  "gh-signed-out": true,
  "gh-unanswered": true,
  "not-an-admin": true,
};

/** Why the person's own `gh` couldn't answer (ADR 0059). */
const GH_WHY: Record<GhWhy, true> = { offline: true, sso: true, scope: true, timeout: true, failed: true };

const isGhWhy = (value: unknown): value is GhWhy => typeof value === "string" && Object.hasOwn(GH_WHY, value);
const isPermission = (value: unknown): value is AppPermission =>
  typeof value === "string" && Object.hasOwn(APP_PERMISSIONS, value);
const isUseAppKind = (value: unknown): value is UseAppRefusal["kind"] =>
  typeof value === "string" && Object.hasOwn(USE_APP, value);
const isCreateAppKind = (value: unknown): value is CreateAppRefusal["kind"] =>
  typeof value === "string" && Object.hasOwn(CREATE_APP, value);

/** `gh` gave no answer (ADR 0059): `gh-unanswered` only with a why the UI knows. */
function ghRefusalOf(kind: GhRefusal["kind"], why: unknown): GhRefusal | null {
  switch (kind) {
    case "gh-missing":
    case "gh-signed-out":
      return { kind };
    case "gh-unanswered":
      return isGhWhy(why) ? { kind, why } : null;
  }
}
/** Why an `agent.*` command did nothing, by its code: the one list of the codes, said on Your coding agent's rows. */
export const AGENT_REFUSED: Record<AgentRefusal, string> = {
  not_offered: "Lookover puts itself on the PATH only when it runs as its own program.",
  no_such_agent: "Lookover doesn't find that agent on this computer any more.",
  not_ours: "Lookover didn't write this skill, so it leaves it there. Replace it, or remove it by hand.",
};
const isAgent = (value: unknown): value is AgentRefusal =>
  typeof value === "string" && Object.hasOwn(AGENT_REFUSED, value);

/** The answer's `useApp`, when it is why "Use an existing App" was refused (ADR 0053). */
function useAppOf(answer: unknown): UseAppRefusal | null {
  if (!isRecord(answer) || !isRecord(answer.useApp)) return null;
  const { kind, missing, why, organisation, person, invited, kept } = answer.useApp;
  if (!isUseAppKind(kind)) return null;
  switch (kind) {
    case "not-a-key":
    case "key-refused":
    case "another-app":
    case "unreachable":
    case "live-config":
      return { kind };
    case "gh-missing":
    case "gh-signed-out":
    case "gh-unanswered":
      return ghRefusalOf(kind, why);
    case "missing-permissions":
      return Array.isArray(missing) && missing.every(isPermission) ? { kind, missing } : null;
    case "not-a-member":
      return typeof organisation === "string" && typeof person === "string" && typeof invited === "boolean"
        ? { kind, organisation, person, invited }
        : null;
    case "another-person":
      return typeof person === "string" && typeof kept === "string" ? { kind, person, kept } : null;
  }
}

/** The answer's `createApp`, when it is why "Create it on GitHub" was refused (ADR 0053, ADR 0059). */
function createAppOf(answer: unknown): CreateAppRefusal | null {
  if (!isRecord(answer) || !isRecord(answer.createApp)) return null;
  const { kind, why } = answer.createApp;
  if (!isCreateAppKind(kind)) return null;
  switch (kind) {
    case "live-config":
    case "already-made":
    case "not-an-admin":
      return { kind };
    case "gh-missing":
    case "gh-signed-out":
    case "gh-unanswered":
      return ghRefusalOf(kind, why);
  }
}

/**
 * The refusal a request rejected with: the service's status, `error` line and the data it carried (a settings
 * refusal's, an App's, Your coding agent's), or status 0 and no words when the request never reached it (the console
 * keeps that error); with the command refused, when it is given.
 */
export function refusalOf(error: unknown, command?: Command): Refusal {
  const sent = command === undefined ? {} : { command };
  if (!(error instanceof Refused)) return { status: 0, error: null, ...sent };
  const { answer } = error;
  const agent = isRecord(answer) && isAgent(answer.agent) ? answer.agent : null;
  const invalid = invalidOf(answer);
  const unwritten = unwrittenOf(answer);
  const refused = isRecord(answer) && isRefused(answer.refused) ? answer.refused : null;
  // The App's refusals, as the service sends them beside `error` (#197, #198): `answer.useApp` (UseAppRefusal) and
  // `answer.createApp` (CreateAppRefusal). Exactly these names: anything else is only the toast's generic line.
  const useApp = useAppOf(answer);
  const createApp = createAppOf(answer);
  return {
    status: error.status,
    error: error.reason,
    ...(invalid === null ? {} : { invalid }),
    ...(unwritten === null ? {} : { unwritten }),
    ...(refused === null ? {} : { refused }),
    ...(useApp === null ? {} : { useApp }),
    ...(createApp === null ? {} : { createApp }),
    ...(agent === null ? {} : { agent }),
    ...sent,
  };
}

/** The band's line (`title.` then `detail`) and the toast (both in one sentence). */
export function refusalText(refusal: Refusal): { title: string; detail: string } {
  return {
    title: "Lookover couldn't do that",
    detail: appReason(refusal) ?? settingsReason(refusal) ?? reason(refusal),
  };
}

/** An App refused (ADR 0053): "Use an existing App", or "Create it on GitHub". */
function appReason({ useApp, createApp }: Refusal): string | null {
  if (useApp !== undefined) return useAppRefusalText(useApp);
  return createApp === undefined ? null : createAppRefusalText(createApp);
}

/**
 * A settings command refused (ADR 0049): the file that doesn't read and why, the one that couldn't be written, or the
 * refusal's code.
 */
function settingsReason({ invalid, unwritten, refused }: Refusal): string | null {
  if (refused !== undefined) return REFUSED[refused];
  if (invalid !== undefined)
    return `${whereIs(invalid.file)} doesn't read: ${settingsFileProblemText(invalid)}. Fix the file, then try again.`;
  if (unwritten === undefined) return null;
  return unwritten.why === "held-open"
    ? `${whereIs(unwritten.file)} is open in another program. Close it, then try again.`
    : `${whereIs(unwritten.file)} couldn't be saved.`;
}

/**
 * A settings file as the owner looks for it: a repository's by its path (`<owner>/<name>/settings.yaml`), the owner's
 * defaults, alone at the data folder's root, with where that is.
 */
const whereIs = (file: string) => (file.includes("/") ? file : `${file} in Lookover's data folder`);

/** What was missing, by the service's 404 words: a pull request, a repository. */
const MISSING: Record<string, string> = {
  "no such change": "There is no such pull request.",
  "no such repository": "Lookover doesn't watch that repository.",
};

/** A 404's words: what was missing, or a demo scenario. */
function missing(error: string | null): string {
  if (error !== null && Object.hasOwn(MISSING, error)) return MISSING[error] ?? "";
  return error?.startsWith("no scenario ") ? "There is no such scenario." : "";
}

function reason({ status, error }: Refusal): string {
  switch (status) {
    case 0:
      return "The service didn't answer.";
    case 404:
      return missing(error);
    case 409: {
      // A conflict with words of its own; a thing already going on says "already running" (the checks). Any other
      // conflict has no words here: the console keeps the service's.
      if (error === "loading") return "A scenario is loading.";
      if (error?.includes("already running")) return "It is already running.";
      return "";
    }
    case 501:
      // A control not wired yet says so; any other 501 (the drawer's demo verbs in live mode) has no words here.
      if (error === "not available yet") return "It is not available yet.";
      return "";
    default:
      return "";
  }
}

/** The toast's one line. */
export function refusalLine(refusal: Refusal): string {
  const { title, detail } = refusalText(refusal);
  return `${title}.${detail ? ` ${detail}` : ""}`;
}

/**
 * The toast's line, or null when the refusal is said in place: an App refused (ADR 0053), under "Use an existing
 * App"'s key or on the setup's GitHub step; Your coding agent's writes (ADR 0058), on their row. One problem, said
 * once.
 */
export function refusalToast(refusal: Refusal): string | null {
  const type = refusal.command?.type;
  if (type === "agent.path" || type === "agent.skill") return null;
  return refusal.useApp !== undefined || refusal.createApp !== undefined ? null : refusalLine(refusal);
}

const NOT_SIGNED_IN = "This tab isn't signed in.";

/**
 * The session screen (#68, ADR 0058): the service answered 401, whether the tab never had a session (opened on the
 * bare address) or its session ended. One true sentence for both: with the command the 401 named (`open`, Lookover's
 * command then `open`, which opens a signed-in tab); in development, which names none, the link `bun dev` printed;
 * and when the program's 401 named nothing (a body that didn't parse), the sentence without a command.
 */
export function sessionLost(mode: WebMode, open: string | null): string | WithCommand {
  if (open !== null) return { before: `${NOT_SIGNED_IN} Run`, command: open, after: "to open Lookover." };
  if (mode === "program") return `${NOT_SIGNED_IN} Open Lookover again from your terminal.`;
  return {
    before: `${NOT_SIGNED_IN} Open the link`,
    command: devCommand(mode),
    after: "printed.",
  };
}
