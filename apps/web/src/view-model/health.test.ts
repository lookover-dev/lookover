// What the status menu says about the AIs, GitHub and the service, and about each health check. The snapshot
// carries states and facts; these are the only words for them.
import { expect, test } from "bun:test";
import {
  type CheckItem,
  type ConnectionCause,
  type Engine,
  type EngineId,
  type EngineState,
  engineDetailText,
} from "@lookover/contracts";
import { checkLine, connectionText, engineStateText, serviceStatus } from "./health.ts";

function engine(id: EngineId, name: string): Engine {
  return {
    id,
    name,
    cli: id,
    version: "2.4.1",
    state: "ready",
    detail: "",
    unusable: null,
    since: 0,
    limitUntil: null,
    signingIn: false,
  };
}
const ENGINES = { claude: engine("claude", "Claude"), codex: engine("codex", "Codex") };
const TOO_OLD = { kind: "too-old", version: "0.154.0", model: "gpt-6.1-sol", needs: "0.162.0" } as const;

test("an AI's state in a few words", () => {
  const cases: [EngineState, string][] = [
    ["ready", "ready"],
    ["signed-out", "signed out"],
    ["missing", "not installed"],
    ["limit", "at its limit"],
    ["failed-self-test", "didn't pass Lookover's safety check"],
    ["self-test-unfinished", "couldn't finish Lookover's safety check"],
  ];
  for (const [state, text] of cases)
    expect([state, engineStateText({ state, unusable: null })]).toEqual([state, text]);
  // Not installed because the program found is too old for its model: said so, not "not installed".
  expect(engineStateText({ state: "missing", unusable: TOO_OLD })).toBe("too old");
  expect(engineStateText({ state: "missing", unusable: { kind: "npm-launcher" } })).toBe("not installed");
});

test("GitHub and the service in a few words", () => {
  const line = (patch: Partial<Parameters<typeof connectionText>[0]>) =>
    connectionText({ state: "connected", cause: null, person: { id: 7, login: "sam" }, ...patch });
  // Signed in (ADR 0066, ADR 0073): connected as the person who posts, and never as nobody.
  expect(line({})).toBe("connected as sam");
  expect(line({ person: null })).toBe("connected");
  expect(line({ state: "disconnected" })).toBe("disconnected");
  expect(line({ state: "not-connected", person: null })).toBe("not connected");
  expect(serviceStatus({ startAtLogin: true, atLogin: "this", loginItem: "os" })).toEqual({
    ok: true,
    text: "running, starts at login",
  });
  expect(serviceStatus({ startAtLogin: true, atLogin: "none", loginItem: "os" })).toEqual({
    ok: false,
    text: "running, doesn't start at login",
  });
  // Another install holds it (ADR 0068): said, not warned; a test copy is always so and needs nothing.
  expect(
    serviceStatus({ startAtLogin: true, atLogin: { other: "lookover start" }, loginItem: "os" }),
  ).toEqual({
    ok: true,
    text: "running, another Lookover starts at login",
  });
  expect(serviceStatus({ startAtLogin: true, atLogin: "none", loginItem: "stand-in" })).toEqual({
    ok: true,
    text: "running, start at login isn't set up in development",
  });
});

test("GitHub disconnected says its cause in a few words (ADR 0053)", () => {
  const text = (cause: ConnectionCause) => connectionText({ state: "disconnected", cause });
  expect(text({ kind: "unreachable" })).toBe("unreachable");
  expect(text({ kind: "uninstalled", suspended: false })).toBe("App uninstalled");
  expect(text({ kind: "uninstalled", suspended: true })).toBe("App suspended");
  expect(text({ kind: "signed-out" })).toBe("signed out");
  expect(text({ kind: "sso", organisation: "acme", url: null })).toBe("SSO needed");
});

test("the service's check says whether Lookover starts at login for real, warning when it isn't as chosen (ADR 0054)", () => {
  const line = (startAtLogin: boolean, startsAtLogin: boolean, loginItem: "os" | "stand-in" = "os") =>
    checkLine(ENGINES, {
      check: "service",
      state: "running",
      startAtLogin,
      atLogin: startsAtLogin ? "this" : "none",
      loginItem,
    });
  expect(line(true, true)).toEqual({ label: "Service", ok: true, detail: "running, starts at login" });
  expect(line(false, false)).toEqual({
    label: "Service",
    ok: true,
    detail: "running, doesn't start at login",
  });
  expect(line(true, false)).toEqual({
    label: "Service",
    ok: false,
    detail: "running, doesn't start at login",
  });
  expect(line(false, true)).toEqual({
    label: "Service",
    ok: false,
    detail: "running, still starts at login",
  });
  // In development (live mode, a guarded program) the registration is the fake's: never said to start.
  expect(line(true, true, "stand-in")).toEqual({
    label: "Service",
    ok: true,
    detail: "running, start at login isn't set up in development",
  });
});

test("each health check says what it checked, whether it is fine, and the detail", () => {
  const cases: [CheckItem, { label: string; ok: boolean | null; detail: string }][] = [
    [
      {
        check: "engine",
        engine: "claude",
        state: "ready",
        cli: "claude",
        version: "2.4.1",
        unusable: null,
        detail: "",
      },
      { label: "Claude", ok: true, detail: "signed in · claude 2.4.1" },
    ],
    [
      {
        check: "engine",
        engine: "codex",
        state: "signed-out",
        cli: "codex",
        version: "0.162.1",
        unusable: null,
        detail: "",
      },
      { label: "Codex", ok: false, detail: "signed out" },
    ],
    [
      {
        check: "engine",
        engine: "codex",
        state: "missing",
        cli: "codex",
        version: "0.154.0",
        unusable: TOO_OLD,
        detail:
          "gpt-6.1-sol needs Codex 0.162.0 or later; this one is 0.154.0. Update it, then check again: npm install -g @openai/codex@latest",
      },
      {
        label: "Codex",
        ok: false,
        detail:
          "gpt-6.1-sol needs Codex 0.162.0 or later; this one is 0.154.0. Update it, then check again: npm install -g @openai/codex@latest",
      },
    ],
    // The service's words, written on its platform: a Mac's command, never Windows' the web would guess.
    [
      {
        check: "engine",
        engine: "claude",
        state: "missing",
        cli: "claude",
        version: null,
        unusable: { kind: "npm-launcher" },
        detail: engineDetailText("claude", { installed: true, why: { kind: "npm-launcher" } }, "darwin"),
      },
      {
        label: "Claude",
        ok: false,
        detail:
          "Only npm's claude launcher was found, and it runs Claude through Node. Install the native claude program, then check again: curl -fsSL https://claude.ai/install.sh | bash",
      },
    ],
    [
      { check: "connection", state: "connected", cause: null },
      { label: "GitHub", ok: true, detail: "connected" },
    ],
    [
      {
        check: "connection",
        state: "disconnected",
        cause: { kind: "unreachable" },
      },
      { label: "GitHub", ok: false, detail: "unreachable" },
    ],
    [
      { check: "service", state: "running", startAtLogin: true, atLogin: "this", loginItem: "os" },
      { label: "Service", ok: true, detail: "running, starts at login" },
    ],
    [
      { check: "settings", invalid: [] },
      { label: "Settings", ok: true, detail: "every file reads" },
    ],
    // A file that doesn't read is ignored, named with the key at fault (ADR 0049).
    [
      {
        check: "settings",
        invalid: [
          { file: "settings.yaml", problem: "unknown_key", key: "depht" },
          { file: "acme/api/settings.yaml", problem: "wrong_type", key: "onPush" },
        ],
      },
      {
        label: "Settings",
        ok: false,
        detail:
          "settings.yaml ignored: depht isn't a setting · acme/api/settings.yaml ignored: onPush has a wrong value",
      },
    ],
    [
      {
        check: "settings",
        invalid: [
          { file: "settings.yaml", problem: "not_yaml", key: null },
          { file: "acme/api/settings.yaml", problem: "wrong_version", key: "version" },
        ],
      },
      {
        label: "Settings",
        ok: false,
        detail:
          "settings.yaml ignored: it isn't YAML · acme/api/settings.yaml ignored: its version is unknown",
      },
    ],
    [
      { check: "settings", invalid: [{ file: "settings.yaml", problem: "unreadable", key: null }] },
      { label: "Settings", ok: false, detail: "settings.yaml ignored: it can't be opened" },
    ],
    [
      { check: "disk", freeGb: 41 },
      { label: "Disk", ok: true, detail: "41 GB free" },
    ],
    [
      { check: "version", version: "0.1.0", upToDate: true },
      { label: "Version", ok: true, detail: "0.1.0, up to date" },
    ],
    [
      { check: "version", version: "0.1.0", upToDate: false },
      { label: "Version", ok: false, detail: "0.1.0, an update is available" },
    ],
    // Not checked against a newer version (never before publication, ADR 0047): the version alone, no verdict.
    [
      { check: "version", version: "0.1.0", upToDate: null },
      { label: "Version", ok: null, detail: "0.1.0" },
    ],
  ];
  for (const [item, line] of cases) expect([item, checkLine(ENGINES, item)]).toEqual([item, line]);
});
