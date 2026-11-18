// "Show Lookover in the tray", as the app says it (ADR 0105 §11-13): Settings' help says why, then what the computer
// shows (shown, starting, off, or unavailable with its reason); on Windows, in every state, where a new icon sits and
// how to keep it on the taskbar, in Windows 11's words, so switching it moves nothing under the row (ADR 0086); setup's
// last step says that line too, while the choice is on.
import { expect, test } from "bun:test";
import type { Service, ServiceOs, TrayShown } from "@lookover/contracts";
import { TRAY_TITLE, trayFindLine, trayHelp } from "./in-the-tray.ts";

const tray = (
  os: ServiceOs,
  shown: TrayShown,
  reason: string | null = null,
): Pick<Service, "tray" | "os"> => ({
  os,
  tray: { on: shown !== "off", shown, reason },
});

const WHY = "Its icon says what Lookover is doing, and opens or pauses it.";
const FIND =
  "Windows puts a new icon under the taskbar's ^. To keep it on the taskbar, drag it from there onto the taskbar, or switch Lookover on in Windows Settings › Personalization › Taskbar › Other system tray icons.";

test("the row is named as the ADR names the choice", () => {
  expect(TRAY_TITLE).toBe("Show Lookover in the tray");
});

test("Settings' help says why, then what this computer shows", () => {
  expect(trayHelp(tray("linux", "shown"))).toBe(`${WHY} On: its icon is in the tray.`);
  expect(trayHelp(tray("linux", "starting"))).toBe(`${WHY} On: its icon is on its way to the tray.`);
  expect(trayHelp(tray("linux", "off"))).toBe(`${WHY} Off: no icon is shown.`);
  expect(trayHelp(tray("linux", "unavailable", "No desktop to show an icon on"))).toBe(
    `${WHY} On, but its icon can't be shown. No desktop to show an icon on.`,
  );
});

test("on macOS the icon sits in the menu bar", () => {
  expect(trayHelp(tray("macos", "shown"))).toBe(`${WHY} On: its icon is in the menu bar.`);
  expect(trayHelp(tray("macos", "starting"))).toBe(`${WHY} On: its icon is on its way to the menu bar.`);
});

test("on Windows the help says, in every state, where a new icon sits and how to keep it", () => {
  expect(trayHelp(tray("windows", "shown"))).toBe(`${WHY} On: its icon is in the tray. ${FIND}`);
  expect(trayHelp(tray("windows", "starting"))).toBe(
    `${WHY} On: its icon is on its way to the tray. ${FIND}`,
  );
  // Off too: only the short On/Off clause changes, so nothing under the row moves when it is switched.
  expect(trayHelp(tray("windows", "off"))).toBe(`${WHY} Off: no icon is shown. ${FIND}`);
  expect(trayHelp(tray("windows", "unavailable", "No lookover-tray beside this executable"))).toBe(
    `${WHY} On, but its icon can't be shown. No lookover-tray beside this executable. ${FIND}`,
  );
});

test("a reason is said as a sentence of its own, with one full stop", () => {
  expect(trayHelp(tray("linux", "unavailable", "No tray host on this desktop."))).toBe(
    `${WHY} On, but its icon can't be shown. No tray host on this desktop.`,
  );
});

test("a reason that starts with a name is said as it is", () => {
  expect(
    trayHelp(tray("linux", "unavailable", "Lookover shows no tray icon while it runs for development")),
  ).toBe(
    `${WHY} On, but its icon can't be shown. Lookover shows no tray icon while it runs for development.`,
  );
});

test("setup's last step says where to find the icon on Windows only, while the choice is on", () => {
  expect(trayFindLine(tray("windows", "shown"))).toBe(FIND);
  expect(trayFindLine(tray("windows", "starting"))).toBe(FIND);
  // On, whatever the helper does after start, so the footer under the card never moves.
  expect(trayFindLine(tray("windows", "unavailable", "No tray to show an icon in"))).toBe(FIND);
  expect(trayFindLine(tray("windows", "off"))).toBeNull();
  for (const os of ["macos", "linux"] as const)
    for (const shown of ["shown", "starting", "off", "unavailable"] as const)
      expect(trayFindLine(tray(os, shown))).toBeNull();
});
