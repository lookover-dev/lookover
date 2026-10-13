// Start at login, in words (ADR 0054). Three facts: the owner's choice (`startAtLogin`, on until they turn it off),
// whether Lookover is registered (`startsAtLogin`) and where (`loginItem`): on the machine (the program, and demo mode,
// which plays it), or in memory (live mode and a guarded program), where nothing starts at login and the app says start
// at login isn't set up in development. The status and Settings say the registration, never the choice alone; when the
// two differ (the machine refused to change it), they say so, and the alert band carries the fix (`problems`).
import type { Service } from "@lookover/contracts";
import type { WebMode } from "../dev/mode.ts";
import type { WithCommand } from "./format.ts";

type Registration = Pick<Service, "startAtLogin" | "startsAtLogin" | "loginItem">;
/** The registration, and Lookover's command (ADR 0058), which the help names to start it by hand. */
type AtLogin = Registration & Pick<Service, "command">;

/** What starts Lookover in development, by the web app's mode: `bun dev`, which prints the link to open. */
export const devCommand = (mode: WebMode): string => (mode === "live" ? "bun dev --live" : "bun dev");

/**
 * The command that starts Lookover: the program's own (`Service.command`, ADR 0058: `lookover`, the binary's path
 * or the clone's `bun run lookover`, with its `--home`) then `start`, in demo mode too, which plays the program and
 * names its command everywhere else (your coding agent's rows); in live mode, the developer's.
 */
export function startCommand(mode: WebMode, command: string): string {
  return mode === "live" ? devCommand(mode) : `${command} start`;
}

/** What development's registration says everywhere: nothing on the machine, so nothing starts. */
const NOT_SET_UP = "start at login isn't set up in development";

/** Whether the registration differs from the choice: only the machine's can (it refused to change). */
export const atLoginMismatch = (s: Registration): boolean =>
  s.loginItem === "os" && s.startAtLogin !== s.startsAtLogin;

/** Start at login as the status menu and "Run all checks" say it after "running": `ok` false when it isn't as chosen. */
export function atLoginStatus(s: Registration): { ok: boolean; text: string } {
  if (s.loginItem === "memory") return { ok: true, text: NOT_SET_UP };
  if (s.startsAtLogin)
    return { ok: s.startAtLogin, text: s.startAtLogin ? "starts at login" : "still starts at login" };
  return { ok: !s.startAtLogin, text: "doesn't start at login" };
}

const WHY = "So reviews happen while the app is closed.";

/** Settings' help under "Start at login": why, then what happens at the next login. */
export function startAtLoginHelp(s: AtLogin, mode: WebMode): string | WithCommand {
  if (s.loginItem === "memory")
    return `${WHY} Start at login isn't set up in development: your choice is kept, and nothing starts when you log in.`;
  const { startAtLogin, startsAtLogin } = s;
  if (startAtLogin && startsAtLogin) return `${WHY} Lookover starts each time you log in to this computer.`;
  if (!startAtLogin && !startsAtLogin)
    return { before: `${WHY} Off: run`, command: startCommand(mode, s.command), after: "after you log in." };
  if (startAtLogin)
    return `${WHY} On, but this computer refused to start Lookover at login: turn it off and on to try again.`;
  return `${WHY} Off, but this computer still starts Lookover at login: turn it on and off to try again.`;
}

/** The setup's last step (06b 2d): reviews go on with the terminal closed. */
export const BACKGROUND_TEXT =
  "Lookover runs quietly in the background. Close the terminal whenever you like. Pull requests opened while it was off are reviewed when it is back.";

const CHANGE_IT = "Change it any time in Settings, under “Start at login”.";

/**
 * The line under it: what the choice does at the next login. Nothing is registered before the setup is finished
 * ("Go to my reviews"), so this says the choice; Settings says the registration from then on.
 */
export function backgroundLine(
  s: Pick<AtLogin, "startAtLogin" | "loginItem" | "command">,
  mode: WebMode,
): string | WithCommand {
  if (s.loginItem === "memory")
    return "Start at login isn't set up in development: nothing starts when you log in.";
  if (s.startAtLogin) return `It starts each time you log in to this computer. ${CHANGE_IT}`;
  return {
    before: "It won't start at login: run",
    command: startCommand(mode, s.command),
    after: `after you log in. ${CHANGE_IT}`,
  };
}
