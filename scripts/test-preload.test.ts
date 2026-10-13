// The test runner's own mark (`scripts/test-preload.ts`, bunfig.toml's `[test] preload`): every `bun test` started in
// this repository carries it, so the real start at login refuses to run whatever `NODE_ENV` says (ADR 0045, ADR 0054).
// `bun test` sets `NODE_ENV` to `test` only when it is unset: a shell that exports another would otherwise let a test
// write the owner's registry.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { osLoginItem, windowsLoginItem } from "@lookover/service";

const ROOT = join(import.meta.dir, "..");
const COMMAND = ["C:\bun.exe", "C:main.ts", "start", "--no-open"];
const system = { platform: "win32", homedir: "C:Userssam", env: {}, which: () => null } as const;

test("this test process carries the mark, and the real adapters refuse with NODE_ENV at production", () => {
  expect(process.env.LOOKOVER_UNDER_TEST).toBe("1");
  const was = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    for (const platform of ["win32", "darwin", "linux"] as const)
      expect(() => osLoginItem(COMMAND, { ...system, platform })).toThrow(/bun test/);
    expect(() => windowsLoginItem(COMMAND)).toThrow(/bun test/);
  } finally {
    if (was === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = was;
  }
});

test("`bun run test`'s own run, from the root with NODE_ENV at production, still refuses", () => {
  const { LOOKOVER_UNDER_TEST: _mark, ...env } = process.env;
  const run = Bun.spawnSync(
    ["bun", "test", "./apps/service/src/login-item.test.ts", "-t", "refuse to run under bun test"],
    { cwd: ROOT, env: { ...env, NODE_ENV: "production" }, stdout: "pipe", stderr: "pipe" },
  );
  const said = `${run.stdout.toString()}${run.stderr.toString()}`;
  expect(said).toContain(" 1 pass");
  expect(run.exitCode).toBe(0);
});
