// Start at login, as the app says it (ADR 0054): the owner's choice (`startAtLogin`), what is registered
// (`startsAtLogin`) and where (`loginItem`: the machine's, or development's in memory) are three facts; the status,
// Settings and the setup's last step say each truthfully, and never claim it starts where nothing is set up.
import { expect, test } from "bun:test";
import {
  atLoginStatus,
  BACKGROUND_TEXT,
  backgroundLine,
  devCommand,
  startAtLoginHelp,
  startCommand,
} from "./start-at-login.ts";

/** Lookover's command (ADR 0058), as the service says it: found on the PATH, a binary's path, a clone's. */
const ON_PATH = "lookover";
const BINARY = String.raw`& 'C:\Users\Your Name\Downloads\lookover.exe'`;
const CLONE = "bun run lookover --home=/home/me/.lookover-test";
const os = { loginItem: "os", command: ON_PATH } as const;
const on = { ...os, startAtLogin: true, startsAtLogin: true };
const off = { ...os, startAtLogin: false, startsAtLogin: false };
const notRegistered = { ...os, startAtLogin: true, startsAtLogin: false };
const stillRegistered = { ...os, startAtLogin: false, startsAtLogin: true };
/** Live mode and a guarded program: the registration is the fake's, kept in memory. */
const dev = (startAtLogin: boolean) =>
  ({ loginItem: "memory", command: ON_PATH, startAtLogin, startsAtLogin: startAtLogin }) as const;

test("the command that starts Lookover: the program's own command (ADR 0058), which demo mode plays, or live mode's", () => {
  expect(startCommand("program", ON_PATH)).toBe("lookover start");
  expect(startCommand("program", BINARY)).toBe(
    String.raw`& 'C:\Users\Your Name\Downloads\lookover.exe' start`,
  );
  expect(startCommand("program", CLONE)).toBe("bun run lookover --home=/home/me/.lookover-test start");
  // Demo mode plays the program: the same command its coding agent's rows name.
  expect(startCommand("demo", ON_PATH)).toBe("lookover start");
  expect(startCommand("demo", BINARY)).toBe(String.raw`& 'C:\Users\Your Name\Downloads\lookover.exe' start`);
  expect(startCommand("live", ON_PATH)).toBe("bun dev --live");
  expect(devCommand("demo")).toBe("bun dev");
  expect(devCommand("live")).toBe("bun dev --live");
});

test("the status says what the machine has registered, and warns when it differs from the choice", () => {
  expect(atLoginStatus(on)).toEqual({ ok: true, text: "starts at login" });
  expect(atLoginStatus(off)).toEqual({ ok: true, text: "doesn't start at login" });
  expect(atLoginStatus(notRegistered)).toEqual({ ok: false, text: "doesn't start at login" });
  expect(atLoginStatus(stillRegistered)).toEqual({ ok: false, text: "still starts at login" });
});

test("in development the status says start at login isn't set up, whatever the choice", () => {
  for (const chosen of [true, false])
    expect(atLoginStatus(dev(chosen))).toEqual({
      ok: true,
      text: "start at login isn't set up in development",
    });
});

test("Settings' help says why, then whether Lookover starts at login for real, the command in code", () => {
  expect(startAtLoginHelp(on, "program")).toBe(
    "So reviews happen while the app is closed. Lookover starts each time you log in to this computer.",
  );
  expect(startAtLoginHelp(off, "program")).toEqual({
    before: "So reviews happen while the app is closed. Off: run",
    command: "lookover start",
    after: "after you log in.",
  });
  expect(startAtLoginHelp({ ...off, command: BINARY }, "program")).toEqual({
    before: "So reviews happen while the app is closed. Off: run",
    command: String.raw`& 'C:\Users\Your Name\Downloads\lookover.exe' start`,
    after: "after you log in.",
  });
  expect(startAtLoginHelp({ ...off, command: CLONE }, "program")).toEqual({
    before: "So reviews happen while the app is closed. Off: run",
    command: "bun run lookover --home=/home/me/.lookover-test start",
    after: "after you log in.",
  });
  expect(startAtLoginHelp({ ...off, command: BINARY }, "demo")).toEqual({
    before: "So reviews happen while the app is closed. Off: run",
    command: String.raw`& 'C:\Users\Your Name\Downloads\lookover.exe' start`,
    after: "after you log in.",
  });
  expect(startAtLoginHelp(notRegistered, "program")).toBe(
    "So reviews happen while the app is closed. On, but this computer refused to start Lookover at login: turn it off and on to try again.",
  );
  expect(startAtLoginHelp(stillRegistered, "program")).toBe(
    "So reviews happen while the app is closed. Off, but this computer still starts Lookover at login: turn it on and off to try again.",
  );
});

test("in development Settings' help says start at login isn't set up, never that it starts", () => {
  for (const chosen of [true, false])
    expect(startAtLoginHelp(dev(chosen), "live")).toBe(
      "So reviews happen while the app is closed. Start at login isn't set up in development: your choice is kept, and nothing starts when you log in.",
    );
});

test("the setup's last step says the terminal can close, and what the choice does at the next login", () => {
  expect(BACKGROUND_TEXT).toBe(
    "Lookover runs quietly in the background. Close the terminal whenever you like. Pull requests opened while it was off are reviewed when it is back.",
  );
  expect(backgroundLine(on, "program")).toBe(
    "It starts each time you log in to this computer. Change it any time in Settings, under “Start at login”.",
  );
  expect(backgroundLine(off, "program")).toEqual({
    before: "It won't start at login: run",
    command: "lookover start",
    after: "after you log in. Change it any time in Settings, under “Start at login”.",
  });
  expect(backgroundLine({ ...off, command: BINARY }, "program")).toMatchObject({
    command: String.raw`& 'C:\Users\Your Name\Downloads\lookover.exe' start`,
  });
  expect(backgroundLine({ ...off, command: CLONE }, "program")).toMatchObject({
    command: "bun run lookover --home=/home/me/.lookover-test start",
  });
  expect(backgroundLine({ ...off, command: BINARY }, "demo")).toEqual({
    before: "It won't start at login: run",
    command: String.raw`& 'C:\Users\Your Name\Downloads\lookover.exe' start`,
    after: "after you log in. Change it any time in Settings, under “Start at login”.",
  });
  for (const chosen of [true, false])
    expect(backgroundLine(dev(chosen), "live")).toBe(
      "Start at login isn't set up in development: nothing starts when you log in.",
    );
});
