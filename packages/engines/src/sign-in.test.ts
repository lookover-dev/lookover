// The sign-in command of each engine through the entry (ADR 0047): the vendor's own login, as data, for the
// terminal the service opens, with the environment it gets (ADR 0048). Nothing runs here.
import { expect, test } from "bun:test";
import { createEngines, engineEnv, type Host } from "@lookover/engines";
import { createProcessRunner } from "@lookover/process";
import { NEVER, SHELL } from "./env.test-support.ts";

/** Windows, whatever this machine is, with nothing on PATH and no install folder: neither engine is found. */
const NOWHERE: Host = { platform: "win32", arch: "x64" };
const LINUX: Host = { platform: "linux", arch: "x64" };

const runner = createProcessRunner({ registryFile: "unused.json" });

test("Claude: its documented login subcommand, after the program's own leading arguments", () => {
  const engines = createEngines({
    runner,
    env: {},
    claude: { executable: "C:\\Programs\\claude\\claude.exe", args: ["--bundled"] },
  });
  expect(engines.signInCommand("claude")).toMatchObject({
    executable: "C:\\Programs\\claude\\claude.exe",
    args: ["--bundled", "auth", "login"],
  });
});

test("Codex: codex login", () => {
  const engines = createEngines({ runner, env: {}, codex: { executable: "/opt/codex/codex", args: [] } });
  expect(engines.signInCommand("codex")).toMatchObject({ executable: "/opt/codex/codex", args: ["login"] });
});

test("each login gets its engine's allow-listed environment, never a GitHub token or an API key", () => {
  const engines = createEngines({
    runner,
    env: SHELL,
    host: LINUX,
    claude: { executable: "/opt/claude/claude", args: [] },
    codex: { executable: "/opt/codex/codex", args: [] },
  });
  for (const engine of ["claude", "codex"] as const) {
    const env = engines.signInCommand(engine)?.env;
    expect(env).toEqual(engineEnv(engine, SHELL, LINUX));
    for (const name of NEVER) expect(Object.keys(env ?? {})).not.toContain(name);
  }
});

test("an engine that isn't installed has no sign-in command", () => {
  const engines = createEngines({ runner, env: {}, host: NOWHERE });
  expect(engines.signInCommand("claude")).toBeNull();
  expect(engines.signInCommand("codex")).toBeNull();
});
