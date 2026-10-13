// The planted sandbox: the same commits on every machine (the recordings and the demo name them), a bare
// repository holding every branch, and the fix commit pushed once.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitSha } from "@lookover/contracts";
import { plantSandbox, pushSandboxFix } from "./index.ts";

// A test plants the sandbox (a dozen git commands), once or twice: about 1.5 s on an idle machine, past
// Bun's 5 s when other test runs share the machine.
setDefaultTimeout(15_000);

const GIT = Bun.which("git") ?? "";
const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function folder(): string {
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), "lookover-sandbox-"));
  made.push(dir);
  return join(dir, "sandbox");
}

/** Git in the bare repository, outside this process's environment (a hook's `GIT_*` stays out). */
function inBare(cloneUrl: string, ...args: string[]): string {
  const r = spawnSync(GIT, args, {
    cwd: cloneUrl,
    env: { HOME: cloneUrl, USERPROFILE: cloneUrl },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

const BASE = commitSha("610d86d8a2803f372824568f561862ad97de6880");
const PLANTED = commitSha("703205dec59961a3a08427d7b4af007e278451a4");
const FIXED = commitSha("4700cffcc191fa0290cc7d91340f924a74c7f803");

test("the sandbox is planted with the same commits everywhere, every branch in the bare repository", () => {
  const sandbox = plantSandbox(folder(), GIT);

  expect(sandbox.base).toBe(BASE);
  expect(sandbox.changes.map((c) => [c.number, c.head.ref, c.head.sha, c.base.sha])).toEqual([
    [1, "feature/invoice-filters", PLANTED, BASE],
    [2, "export-csv", "412369790eb712c5856aabfb5c392895a7fe6086", BASE],
    [3, "webhook-retry", "b4ce97d950e82ba750910f3fdd3b2b876b80a79d", BASE],
  ]);
  expect(inBare(sandbox.cloneUrl, "for-each-ref", "--format=%(refname) %(objectname)").split("\n")).toEqual([
    "refs/heads/export-csv 412369790eb712c5856aabfb5c392895a7fe6086",
    `refs/heads/feature/invoice-filters ${PLANTED}`,
    `refs/heads/main ${BASE}`,
    "refs/heads/webhook-retry b4ce97d950e82ba750910f3fdd3b2b876b80a79d",
  ]);
  expect(inBare(sandbox.cloneUrl, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  // Pull request #1 removes a file of the base and adds a binary one.
  expect(
    inBare(sandbox.cloneUrl, "diff", "--name-status", "--no-renames", BASE, PLANTED).split("\n"),
  ).toEqual([
    "A\tassets/invoice-badge.png",
    "A\tsrc/greeting.ts",
    "M\tsrc/invoices.ts",
    "D\tsrc/legacy-name.ts",
  ]);
});

test("a fix pushed to a folder holding no planted sandbox is refused, naming the folder", () => {
  const dir = folder();
  expect(() => pushSandboxFix(dir, GIT)).toThrow(`${dir} holds no planted sandbox`);
});

test("the fix commit is pushed once on pull request #1, and a sandbox planted again keeps it", () => {
  const dir = folder();
  const sandbox = plantSandbox(dir, GIT);

  expect(pushSandboxFix(dir, GIT).sha).toBe(FIXED);
  expect(pushSandboxFix(dir, GIT).sha).toBe(FIXED);

  expect(inBare(sandbox.cloneUrl, "rev-parse", "refs/heads/feature/invoice-filters")).toBe(String(FIXED));
  expect(inBare(sandbox.cloneUrl, "rev-parse", `${FIXED}^`)).toBe(String(PLANTED));
  expect(plantSandbox(dir, GIT).changes[0]?.head.sha).toBe(FIXED);
});
