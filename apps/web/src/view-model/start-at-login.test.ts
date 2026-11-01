// Start at login, as the app says it (ADR 0054): the owner's choice (`startAtLogin`), what is registered
// (`atLogin`) and where (`loginItem`: the machine's, or development's stand-in) are three facts; the status,
// Settings and the setup's last step say each truthfully, and never claim it starts where nothing is set up.
import { expect, test } from "bun:test";
import {
  atLoginDetail,
  atLoginStatus,
  BACKGROUND_TEXT,
  backgroundLine,
  backgroundLines,
  devCommand,
  offersStartThisOne,
  START_THIS_ONE,
  startAtLoginHelp,
  startCommand,
  takenBy,
} from "./start-at-login.ts";

/** Lookover's command (ADR 0058), as the service says it: found on the PATH, a binary's path, a clone's. */
const ON_PATH = "lookover";
const BINARY = String.raw`& 'C:\Users\Your Name\Downloads\lookover.exe'`;
const CLONE = "bun run lookover --home=/home/me/.lookover-test";
const os = { loginItem: "os", command: ON_PATH } as const;
const on = { ...os, startAtLogin: true, atLogin: "this" } as const;
const off = { ...os, startAtLogin: false, atLogin: "none" } as const;
const notRegistered = { ...os, startAtLogin: true, atLogin: "none" } as const;
const stillRegistered = { ...os, startAtLogin: false, atLogin: "this" } as const;
/** Live mode and a guarded program: the stand-in registers nothing (ADR 0070). */
const dev = (startAtLogin: boolean) =>
  ({ loginItem: "stand-in", command: ON_PATH, startAtLogin, atLogin: "none" }) as const;

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

/** Another install's registration (ADR 0068): the npm install, beside this scratch copy. */
const OTHER = String.raw`"C:\Users\Your Name\AppData\Roaming\npm\node_modules\lookover\bin\lookover.exe" start --no-open`;
const taken = (startAtLogin: boolean) => ({ ...os, startAtLogin, atLogin: { other: OTHER } }) as const;

test("another Lookover holding start at login: the status names it, no warning, whatever the choice (ADR 0068)", () => {
  expect(atLoginStatus(taken(true))).toEqual({ ok: true, text: "another Lookover starts at login" });
  expect(atLoginStatus(taken(false))).toEqual({ ok: true, text: "doesn't start at login" });
});

test("another Lookover holding start at login: Settings' help names its command, on or off (ADR 0068)", () => {
  expect(startAtLoginHelp(taken(true), "program")).toEqual({
    before:
      "So reviews happen while the app is closed. On, but another Lookover starts at login on this computer:",
    command: OTHER,
    after: ".",
  });
  expect(startAtLoginHelp(taken(false), "program")).toEqual({
    before: "So reviews happen while the app is closed. Off: run",
    command: "lookover start",
    after: {
      before: "after you log in. Another Lookover starts at login on this computer:",
      command: OTHER,
      after: ".",
    },
  });
});

test("takenBy names another Lookover's command while it holds start at login, whatever the choice (ADR 0068)", () => {
  expect(takenBy(taken(true))).toBe(OTHER);
  expect(takenBy(taken(false))).toBe(OTHER);
  for (const s of [on, off, notRegistered, stillRegistered, dev(true), dev(false)])
    expect(takenBy(s)).toBeNull();
});

test("Settings offers “Start this one instead” only while it is on and another Lookover holds it (ADR 0068)", () => {
  expect(START_THIS_ONE).toBe("Start this one instead");
  expect(offersStartThisOne(taken(true))).toBe(true);
  for (const s of [taken(false), on, off, notRegistered, stillRegistered, dev(true), dev(false)])
    expect(offersStartThisOne(s)).toBe(false);
});

test("the setup's last step says when another Lookover starts at login and this one won't (ADR 0068)", () => {
  expect(backgroundLine(taken(true), "program")).toEqual({
    before: "Another Lookover starts at login on this computer:",
    command: OTHER,
    after: ". This one won't: choose “Start this one instead” in Settings, under “Start at login”.",
  });
  // Chosen off, this one won't anyway: the line says what to run, as with nothing registered.
  expect(backgroundLine(taken(false), "program")).toEqual(backgroundLine(off, "program"));
});

test("the setup's last step holds every line its button can switch to, so the button row never moves", () => {
  for (const chosen of [true, false]) {
    expect(backgroundLines(taken(chosen), "program")).toEqual([
      backgroundLine(taken(true), "program"),
      backgroundLine(taken(false), "program"),
    ]);
    expect(backgroundLines(chosen ? on : off, "program")).toEqual([
      backgroundLine(on, "program"),
      backgroundLine(off, "program"),
    ]);
    // In development both choices say the same: one line.
    expect(backgroundLines(dev(chosen), "live")).toEqual([backgroundLine(dev(chosen), "live")]);
  }
});

test("the status menu names the command another Lookover starts at login with, on or off, as Settings does (ADR 0068)", () => {
  for (const chosen of [true, false])
    expect(atLoginDetail(taken(chosen))).toEqual({
      before: "At login, this computer runs",
      command: OTHER,
      after: ".",
    });
  for (const s of [on, off, notRegistered, stillRegistered, dev(true)]) expect(atLoginDetail(s)).toBeNull();
});
