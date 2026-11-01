// Start at login, in words (ADR 0054). Three facts: the owner's choice (`startAtLogin`, on until they turn it off),
// who holds the registration (`atLogin`: this install, none, or another install, ADR 0068) and where (`loginItem`): on
// the machine (the program, and demo mode, which plays it), or a stand-in (live mode and a guarded program), which
// registers nothing (ADR 0070): nothing starts at login and the app says start at login isn't set up in development.
// The status and Settings say the registration, never the choice alone; when the two differ (the machine refused to
// change it), they say so, and the alert band carries the fix (`problems`). Another install holding it is no mismatch:
// no band; the status menu and Settings name its command (`takenBy`), and while it is on, Settings offers "Start this
// one instead" (`offersStartThisOne`, ADR 0068).
import type { Service } from "@lookover/contracts";
import type { WebMode } from "../dev/mode.ts";
import type { WithCommand } from "./format.ts";

type Registration = Pick<Service, "startAtLogin" | "atLogin" | "loginItem">;
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
  s.loginItem === "os" && typeof s.atLogin === "string" && s.startAtLogin !== (s.atLogin === "this");

/**
 * The command another install registered to start at login (ADR 0068), or null when none did: Settings and the status
 * menu name it while it holds the registration, whatever the choice. Never in development, where nothing is on the
 * machine.
 */
export function takenBy(s: Registration): string | null {
  if (s.loginItem === "stand-in" || typeof s.atLogin === "string") return null;
  return s.atLogin.other;
}

/** The one action that takes another install's registration on purpose (ADR 0068), as Settings and setup name it. */
export const START_THIS_ONE = "Start this one instead";

/**
 * Whether Settings offers `START_THIS_ONE`: while the choice is on and another install holds the registration. Off,
 * this one wouldn't start anyway, so there is nothing to take.
 */
export const offersStartThisOne = (s: Registration): boolean => s.startAtLogin && takenBy(s) !== null;

/**
 * Start at login as the status menu and "Run all checks" say it after "running": `ok` false when it isn't as chosen.
 * Another install holding it is said, never warned: a test copy is always so and needs nothing (ADR 0068).
 */
export function atLoginStatus(s: Registration): { ok: boolean; text: string } {
  if (s.loginItem === "stand-in") return { ok: true, text: NOT_SET_UP };
  if (s.atLogin === "this")
    return { ok: s.startAtLogin, text: s.startAtLogin ? "starts at login" : "still starts at login" };
  if (s.startAtLogin && takenBy(s) !== null) return { ok: true, text: "another Lookover starts at login" };
  return { ok: !s.startAtLogin, text: "doesn't start at login" };
}

/**
 * Under the status menu's line, while another install holds it, on or off as Settings' help: the command the computer
 * runs at login, so the person knows which Lookover starts (ADR 0068). Null otherwise.
 */
export function atLoginDetail(s: Registration): WithCommand | null {
  const other = takenBy(s);
  if (other === null) return null;
  return { before: "At login, this computer runs", command: other, after: "." };
}

const WHY = "So reviews happen while the app is closed.";
/** Another install's registration, as Settings and the setup's last step say it (ADR 0068). */
const ANOTHER = "another Lookover starts at login on this computer";
const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** Settings' help under "Start at login": why, then what happens at the next login. */
export function startAtLoginHelp(s: AtLogin, mode: WebMode): string | WithCommand {
  if (s.loginItem === "stand-in")
    return `${WHY} Start at login isn't set up in development: your choice is kept, and nothing starts when you log in.`;
  const { startAtLogin } = s;
  const startsAtLogin = s.atLogin === "this";
  const other = takenBy(s);
  if (startAtLogin && startsAtLogin) return `${WHY} Lookover starts each time you log in to this computer.`;
  if (startAtLogin && other !== null)
    return { before: `${WHY} On, but ${ANOTHER}:`, command: other, after: "." };
  if (!startAtLogin && !startsAtLogin) {
    const after = "after you log in.";
    return {
      before: `${WHY} Off: run`,
      command: startCommand(mode, s.command),
      after: other === null ? after : { before: `${after} ${capital(ANOTHER)}:`, command: other, after: "." },
    };
  }
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
 * ("Go to my reviews"), so this says the choice; Settings says the registration from then on. The finish never takes
 * another install's registration (ADR 0068): chosen on, the line says this one won't start, and where to change that.
 */
export function backgroundLine(
  s: Pick<AtLogin, "startAtLogin" | "atLogin" | "loginItem" | "command">,
  mode: WebMode,
): string | WithCommand {
  if (s.loginItem === "stand-in")
    return "Start at login isn't set up in development: nothing starts when you log in.";
  const other = takenBy(s);
  if (s.startAtLogin && other !== null)
    return {
      before: `${capital(ANOTHER)}:`,
      command: other,
      after: `. This one won't: choose “${START_THIS_ONE}” in Settings, under “Start at login”.`,
    };
  if (s.startAtLogin) return `It starts each time you log in to this computer. ${CHANGE_IT}`;
  return {
    before: "It won't start at login: run",
    command: startCommand(mode, s.command),
    after: `after you log in. ${CHANGE_IT}`,
  };
}

/**
 * Every line the last step's button can switch `backgroundLine` to, chosen on then off, each once: the step holds
 * the height of the tallest (`HeldDetail`), so the buttons under it stay under the pointer (rule 5).
 */
export function backgroundLines(
  s: Pick<AtLogin, "startAtLogin" | "atLogin" | "loginItem" | "command">,
  mode: WebMode,
): (string | WithCommand)[] {
  const lines = [
    backgroundLine({ ...s, startAtLogin: true }, mode),
    backgroundLine({ ...s, startAtLogin: false }, mode),
  ];
  return lines.filter((line, i) => lines.findIndex((l) => JSON.stringify(l) === JSON.stringify(line)) === i);
}
