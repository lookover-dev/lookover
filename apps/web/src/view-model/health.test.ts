// What the status menu says about the AIs, GitHub and the service, and about each health check. The snapshot
// carries states and facts; these are the only words for them.
import { expect, test } from "bun:test";
import type {
  CheckItem,
  ConnectionCause,
  Engine,
  EngineId,
  EngineState,
  HostAccount,
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
  ];
  for (const [state, text] of cases)
    expect([state, engineStateText({ state, unusable: null })]).toEqual([state, text]);
  // Not installed because the program found is too old for its model: said so, not "not installed".
  expect(engineStateText({ state: "missing", unusable: TOO_OLD })).toBe("too old");
  expect(engineStateText({ state: "missing", unusable: { kind: "npm-launcher" } })).toBe("not installed");
});

test("GitHub and the service in a few words", () => {
  const line = (patch: Partial<Parameters<typeof connectionText>[0]>) =>
    connectionText({ state: "connected", cause: null, bot: "sam-reviewer[bot]", app: null, ...patch });
  expect(line({})).toBe("connected as sam-reviewer[bot]");
  expect(line({ state: "disconnected" })).toBe("disconnected");
  expect(line({ state: "not-connected", bot: null })).toBe("not connected");
  // The status menu names the account the App is on (ADR 0059): the person's own, or the organisation.
  const app = (account: HostAccount) => ({
    id: 1,
    slug: "lookover-x",
    account,
    person: { id: 7, login: "sam" },
  });
  expect(line({ bot: "x[bot]", app: app({ id: 9, login: "ledger-dev", type: "Organization" }) })).toBe(
    "connected as x[bot], on the ledger-dev organisation",
  );
  expect(line({ bot: "x[bot]", app: app({ id: 7, login: "sam", type: "User" }) })).toBe(
    "connected as x[bot], on your GitHub account",
  );
  expect(serviceStatus({ startAtLogin: true, startsAtLogin: true, loginItem: "os" })).toEqual({
    ok: true,
    text: "running, starts at login",
  });
  expect(serviceStatus({ startAtLogin: true, startsAtLogin: false, loginItem: "os" })).toEqual({
    ok: false,
    text: "running, doesn't start at login",
  });
  expect(serviceStatus({ startAtLogin: true, startsAtLogin: true, loginItem: "memory" })).toEqual({
    ok: true,
    text: "running, start at login isn't set up in development",
  });
});

test("GitHub disconnected says its cause in a few words (ADR 0053)", () => {
  const text = (cause: ConnectionCause) =>
    connectionText({ state: "disconnected", cause, bot: null, app: null });
  expect(text({ kind: "unreachable" })).toBe("unreachable");
  expect(text({ kind: "uninstalled", suspended: false })).toBe("App uninstalled");
  expect(text({ kind: "uninstalled", suspended: true })).toBe("App suspended");
  expect(text({ kind: "key-refused", why: "revoked" })).toBe("key refused");
  expect(text({ kind: "key-lost" })).toBe("key lost");
  expect(text({ kind: "not-a-member", organisation: "acme" })).toBe("membership lost");
});

test("the service's check says whether Lookover starts at login for real, warning when it isn't as chosen (ADR 0054)", () => {
  const line = (startAtLogin: boolean, startsAtLogin: boolean, loginItem: "os" | "memory" = "os") =>
    checkLine(ENGINES, { check: "service", state: "running", startAtLogin, startsAtLogin, loginItem });
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
  expect(line(true, true, "memory")).toEqual({
    label: "Service",
    ok: true,
    detail: "running, start at login isn't set up in development",
  });
});

test("each health check says what it checked, whether it is fine, and the detail", () => {
  const cases: [CheckItem, { label: string; ok: boolean | null; detail: string }][] = [
    [
      { check: "engine", engine: "claude", state: "ready", cli: "claude", version: "2.4.1", unusable: null },
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
      },
      {
        label: "Codex",
        ok: false,
        detail:
          "gpt-6.1-sol needs Codex 0.162.0 or later; this one is 0.154.0. Update it, then check again: npm install -g @openai/codex@latest",
      },
    ],
    [
      { check: "connection", state: "connected", cause: null, bot: "sam-reviewer[bot]", key: null },
      { label: "GitHub", ok: true, detail: "connected as sam-reviewer[bot]" },
    ],
    [
      {
        check: "connection",
        state: "disconnected",
        cause: { kind: "unreachable" },
        bot: "sam-reviewer[bot]",
        key: null,
      },
      { label: "GitHub", ok: false, detail: "unreachable" },
    ],
    // How the App's key is kept (ADR 0053): said beside the connection, unencrypted named for what it is.
    [
      { check: "connection", state: "connected", cause: null, bot: "sam-reviewer[bot]", key: "keychain" },
      { label: "GitHub", ok: true, detail: "connected as sam-reviewer[bot] · key in the keychain" },
    ],
    [
      { check: "connection", state: "connected", cause: null, bot: "sam-reviewer[bot]", key: "user-file" },
      {
        label: "GitHub",
        ok: true,
        detail: "connected as sam-reviewer[bot] · key unencrypted in a user-only file: no keychain",
      },
    ],
    [
      { check: "service", state: "running", startAtLogin: true, startsAtLogin: true, loginItem: "os" },
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
