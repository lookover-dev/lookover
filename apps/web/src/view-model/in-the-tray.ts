// "Show Lookover in the tray", in words (ADR 0105 §11-13). Two facts: the owner's choice (`Service.tray.on`, kept by
// the store, on until they turn it off) and what this start's tray shows (`shown`: there, on its way, off, or
// unavailable with the service's reason); and the computer's system (`Service.os`), which says where the icon sits:
// the menu bar on macOS, the tray elsewhere. On Windows a new icon goes to the overflow under the taskbar's `^`, so
// Settings says how to keep it on the taskbar in every state, so switching the row changes only its short On/Off
// clause and nothing under it moves (ADR 0086); setup's last step says it once while the choice is on (no flag kept:
// it is said there, each time the step shows). The entry in Windows Settings reads "Lookover": the helper's
// FileDescription.
import { asSentence, type Service } from "@lookover/contracts";

type InTheTray = Pick<Service, "tray" | "os">;

/** The Settings row's title and its switch's label: the choice as ADR 0105 names it. */
export const TRAY_TITLE = "Show Lookover in the tray";

const WHY = "Its icon says what Lookover is doing, and opens or pauses it.";

/** Where Windows 11 puts a new icon, and the two ways it keeps one on the taskbar. */
const FIND_ON_WINDOWS =
  "Windows puts a new icon under the taskbar's ^. To keep it on the taskbar, drag it from there onto the taskbar, or switch Lookover on in Windows Settings › Personalization › Taskbar › Other system tray icons.";

/** Where the icon sits on this computer's system. */
const placeOf = (os: Service["os"]): string => (os === "macos" ? "the menu bar" : "the tray");

/** A reason as a sentence of its own, ending on one full stop whether or not the service gave it one. */
const reasonSaid = (reason: string): string => asSentence(reason.replace(/\.+$/, ""));

/** What the computer shows, after "On" or "Off". */
function shownSaid(s: InTheTray): string {
  const place = placeOf(s.os);
  switch (s.tray.shown) {
    case "shown":
      return `On: its icon is in ${place}.`;
    case "starting":
      return `On: its icon is on its way to ${place}.`;
    case "off":
      return "Off: no icon is shown.";
    case "unavailable":
      return s.tray.reason === null
        ? "On, but its icon can't be shown."
        : `On, but its icon can't be shown. ${reasonSaid(s.tray.reason)}`;
    default:
      return s.tray.shown satisfies never;
  }
}

/**
 * Settings' help under "Show Lookover in the tray": why, what this computer shows, and on Windows, in every state,
 * where a new icon sits and how to keep it on the taskbar, so switching the row moves nothing under it (ADR 0086).
 */
export const trayHelp = (s: InTheTray): string =>
  [WHY, shownSaid(s), ...(s.os === "windows" ? [FIND_ON_WINDOWS] : [])].join(" ");

/**
 * Setup's last step (ADR 0105 §13): on Windows, while the choice is on, where the icon sits and how to keep it on the
 * taskbar; null elsewhere, or with the choice off. It follows the choice, not what the helper shows, so a helper that
 * fails after start doesn't move the footer under the card.
 */
export const trayFindLine = (s: InTheTray): string | null =>
  s.os === "windows" && s.tray.on ? FIND_ON_WINDOWS : null;
