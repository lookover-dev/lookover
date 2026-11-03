// Live mode's pieces that need no network (ADR 0039): the machine-wide lock, the live config file, and the
// sign-in terminal's wiring (no terminal opens).
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngines, engineEnv } from "@lookover/engines";
import { createProcessRunner } from "@lookover/process";
import type { TerminalInvocation } from "@lookover/process/terminal";
import { memoryGh } from "@lookover/testkit";
import {
  acquireLiveLock,
  ghPerson,
  LIVE_CONFIG_HELP,
  LiveLockHeld,
  liveConfigPath,
  ORGANISATION_IGNORED,
  readLiveConfig,
  terminalSignIn,
  WATCH_IGNORED,
} from "./index.ts";

const dirs: string[] = [];
const dir = () => {
  const made = mkdtempSync(join(realpathSync.native(tmpdir()), "lookover-live-"));
  dirs.push(made);
  return made;
};

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const T0 = Date.UTC(2026, 9, 7, 9, 30, 0);
const A = { folder: "H:\\worktrees\\a\\.dev\\data-live" };
const B = { folder: "H:\\worktrees\\b\\.dev\\data-live" };

test("a second live run refuses with who holds the lock, in this process too, and runs once it is released", () => {
  const home = dir();
  const first = acquireLiveLock({ home, ...A, now: () => T0 });

  const second = () => acquireLiveLock({ home, ...B, now: () => T0 + 60_000 });
  expect(second).toThrow(LiveLockHeld);
  expect(second).toThrow(
    `Another live run holds the lock: process ${process.pid} on the data folder H:\\worktrees\\a\\.dev\\data-live ` +
      "since 2026-10-07T09:30:00.000Z (1 min ago). One real review at a time on this machine (ADR 0039): wait " +
      "for it to stop.",
  );

  first.release();
  expect(existsSync(first.holderFile)).toBe(false);
  acquireLiveLock({ home, ...B, now: () => T0 }).release();
});

test("a holder file naming a process that still runs, its id reused, blocks nothing: only the held lock does", () => {
  const home = dir();
  const lock = acquireLiveLock({ home, ...A, now: () => T0 });
  lock.release();
  // What a crash leaves: the holder's file, naming a process id the system gave to a live process since.
  writeFileSync(lock.holderFile, JSON.stringify({ pid: process.pid, folder: A.folder, since: T0 }));
  const taken = acquireLiveLock({ home, ...B, now: () => T0 });
  expect(JSON.parse(readFileSync(taken.holderFile, "utf8"))).toEqual({
    pid: process.pid,
    folder: B.folder,
    since: T0,
  });
  taken.release();
});

test("a live run killed without releasing leaves the lock free: the system releases it", async () => {
  const home = dir();
  const entry = join(import.meta.dir, "index.ts");
  const holder = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { acquireLiveLock } = await import(${JSON.stringify(entry)});
       acquireLiveLock({ home: ${JSON.stringify(home)}, folder: "elsewhere" });
       console.log("taken");
       setInterval(() => {}, 1000);`,
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  const { value } = await holder.stdout.getReader().read();
  expect(new TextDecoder().decode(value)).toContain("taken");
  expect(() => acquireLiveLock({ home, ...B, now: () => T0 })).toThrow(LiveLockHeld);

  holder.kill(9);
  await holder.exited;
  acquireLiveLock({ home, ...B, now: () => T0 }).release();
});

test("the live config names the repositories live mode may use and, when given, the App and its key file", () => {
  const home = dir();
  const key = join(home, "app.pem");
  writeFileSync(key, "-----BEGIN RSA PRIVATE KEY-----\nnot a key\n-----END RSA PRIVATE KEY-----\n");
  const path = liveConfigPath(home);
  expect(path).toBe(join(home, "live.json"));
  const write = (config: unknown) => writeFileSync(path, JSON.stringify(config));
  const app = { id: 5202093, keyPath: key };
  const repositories = ["sasensi/lookover-sandbox", "lookover-dev/lookover-private"];
  const listed = [
    { owner: "sasensi", name: "lookover-sandbox" },
    { owner: "lookover-dev", name: "lookover-private" },
  ];

  expect(() => readLiveConfig(path)).toThrow(`No live config at ${path}.\nWrite it as:`);

  write({ app, repositories });
  expect(readLiveConfig(path)).toEqual({ app: { id: 5202093, keyPath: key }, repositories: listed });
  // Without an App: the data folder's own, or the setup screens, give it (ADR 0053).
  write({ repositories });
  expect(readLiveConfig(path)).toEqual({ repositories: listed });
});

test("a live config that still names one repository to watch is taken: the line is ignored, its value never read", () => {
  const path = liveConfigPath(dir());
  const repositories = [{ owner: "sasensi", name: "lookover-sandbox" }];
  // The owner's own file keeps it, and each autopilot cycle copies that file: ignored, whatever it holds.
  for (const watch of ["sasensi/lookover-sandbox", 42, { owner: "secret-value" }]) {
    writeFileSync(path, JSON.stringify({ repositories: ["sasensi/lookover-sandbox"], watch }));
    const config = readLiveConfig(path);
    expect(config).toEqual({ repositories, ignored: ["watch"] });
    expect(JSON.stringify(config)).not.toContain("secret-value");
  }
  expect(WATCH_IGNORED).toBe("`watch` is ignored: every repository in `repositories` is watched.");
  // Without it, nothing is ignored.
  writeFileSync(path, JSON.stringify({ repositories: ["sasensi/lookover-sandbox"] }));
  expect(readLiveConfig(path).ignored).toBeUndefined();
});

test("a live config may name the owner's fork of the sandbox, never one it also lists in repositories", () => {
  const path = liveConfigPath(dir());
  const write = (config: unknown) => writeFileSync(path, JSON.stringify(config));
  const repositories = ["sasensi/lookover-sandbox"];
  const sandbox = { owner: "sasensi", name: "lookover-sandbox" };

  write({ repositories, fork: "lookover-forks/lookover-sandbox" });
  expect(readLiveConfig(path)).toEqual({
    repositories: [sandbox],
    fork: { owner: "lookover-forks", name: "lookover-sandbox" },
  });
  // Absent is fine: `bun run live` skips its fork step.
  write({ repositories });
  expect(readLiveConfig(path).fork).toBeUndefined();

  // The App is never installed on the fork (ADR 0056): listed, it would be watched.
  write({
    repositories: ["lookover-dev/lookover-private", "Lookover-Forks/Lookover-Sandbox"],
    fork: "lookover-forks/lookover-sandbox",
  });
  expect(() => readLiveConfig(path)).toThrow(
    `${path}: "fork" names lookover-forks/lookover-sandbox, which "repositories" lists too: the App is never installed on the fork, so take it out of "repositories".\nWrite it as:`,
  );
  for (const wrong of ["lookover-sandbox", "../x", 42, { owner: "lookover-forks" }]) {
    write({ repositories, fork: wrong });
    expect(() => readLiveConfig(path)).toThrow(
      `${path}: "fork", when given, must be one repository, "owner/name".`,
    );
  }
  expect(LIVE_CONFIG_HELP).toContain(`"fork": "lookover-forks/lookover-sandbox"`);
});

test("the owner's live.json still naming an organisation is taken: the line is ignored, nothing in it read (ADR 0073)", () => {
  const home = dir();
  const key = join(home, "app.pem");
  writeFileSync(key, "-----BEGIN RSA PRIVATE KEY-----\nnot a key\n-----END RSA PRIVATE KEY-----\n");
  const path = liveConfigPath(home);
  const app = { id: 5202093, keyPath: key };
  // Whatever it holds, its key file gone or its shape another: nothing runs on an organisation's App any more.
  for (const organisation of [
    {
      app: { id: 5297673, keyPath: join(home, "org-secret-value.pem") },
      sandbox: "lookover-dev/lookover-sandbox",
      repositories: ["lookover-dev/lookover-private"],
    },
    42,
  ]) {
    writeFileSync(path, JSON.stringify({ app, repositories: ["sasensi/lookover-sandbox"], organisation }));
    const config = readLiveConfig(path);
    expect(config).toEqual({
      app,
      repositories: [{ owner: "sasensi", name: "lookover-sandbox" }],
      ignored: ["organisation"],
    });
    expect(JSON.stringify(config)).not.toContain("secret-value");
  }
  expect(ORGANISATION_IGNORED).toBe(
    "`organisation` is ignored: bun run live runs on the shared App only, on both sandboxes.",
  );
  // Both old lines at once: both named.
  writeFileSync(
    path,
    JSON.stringify({ repositories: ["sasensi/lookover-sandbox"], watch: "x", organisation: 1 }),
  );
  expect(readLiveConfig(path).ignored).toEqual(["watch", "organisation"]);
  // The help says neither.
  expect(LIVE_CONFIG_HELP).not.toContain("organisation");
  expect(LIVE_CONFIG_HELP).not.toContain("export-app-key");
  expect(new Set(LIVE_CONFIG_HELP.match(/\bsasensi\/[\w.-]+/g))).toEqual(
    new Set(["sasensi/lookover-sandbox"]),
  );
});

test("the person is the one gh is signed in as, refused, saying why, when gh names nobody", async () => {
  const gh = memoryGh({ as: { id: 11247504, login: "sasensi" } });
  const person = ghPerson(gh);
  expect(await person()).toEqual({ id: 11247504, login: "sasensi" });
  const refused = "The person is the one gh is signed in as, and";
  gh.signIn(null);
  await expect(person()).rejects.toThrow(`${refused} gh is signed out (gh auth login).`);
  gh.signIn("missing");
  await expect(person()).rejects.toThrow(`${refused} gh is not installed.`);
  gh.signIn({ id: 11247504, login: "sasensi" });
  gh.fail("offline");
  await expect(person()).rejects.toThrow(`${refused} gh gave no answer (offline:`);
});

test("a live config may list two repositories of one name on two accounts: a change is known by its owner and name (ADR 0066)", () => {
  const path = liveConfigPath(dir());
  writeFileSync(
    path,
    JSON.stringify({ repositories: ["sasensi/lookover-sandbox", "lookover-dev/lookover-sandbox"] }),
  );
  expect(readLiveConfig(path).repositories).toEqual([
    { owner: "sasensi", name: "lookover-sandbox" },
    { owner: "lookover-dev", name: "lookover-sandbox" },
  ]);
});

test("a live config listing one repository twice is refused, whatever its case", () => {
  const path = liveConfigPath(dir());
  writeFileSync(
    path,
    JSON.stringify({ repositories: ["lookover-dev/lookover-private", "Lookover-Dev/Lookover-Private"] }),
  );
  expect(() => readLiveConfig(path)).toThrow(
    `${path}: "repositories" lists lookover-dev/lookover-private twice, the second time as ` +
      `Lookover-Dev/Lookover-Private: keep one of them.\nWrite it as:`,
  );
});

test("a live config of another shape is refused with what is wrong and the shape to write", () => {
  const home = dir();
  const key = join(home, "app.pem");
  writeFileSync(key, "-----BEGIN RSA PRIVATE KEY-----\nnot a key\n-----END RSA PRIVATE KEY-----\n");
  const path = liveConfigPath(home);
  const refused = (config: unknown) => {
    writeFileSync(path, JSON.stringify(config));
    return () => readLiveConfig(path);
  };
  const app = { id: 5202093, keyPath: key };
  const repositories = ["sasensi/lookover-sandbox", "lookover-dev/lookover-private"];

  expect(refused({ app: { ...app, id: "5202093" }, repositories })).toThrow(
    `${path}: "app.id" must be the App's numeric id.\nWrite it as:`,
  );
  expect(refused({ app: { ...app, keyPath: `${key}.gone` }, repositories })).toThrow(
    `"app.keyPath" names no file: ${key}.gone`,
  );
  expect(refused({ app: 5202093, repositories })).toThrow(`"app", when given, must be an object`);
  // The shape before the allow-list: one "sandbox" and nothing else.
  expect(refused({ app, sandbox: "sasensi/lookover-sandbox" })).toThrow(
    `"repositories" must list the repositories live mode may use, each "owner/name"`,
  );
  expect(refused({ app, repositories: [] })).toThrow(`"repositories" must list the repositories`);
  expect(refused({ app, repositories: ["lookover-sandbox"] })).toThrow(
    `"repositories" must list the repositories`,
  );
});

test("a repository is GitHub's owner/name: anything that could lead the data folder out of its place is refused", () => {
  const home = dir();
  const key = join(home, "app.pem");
  writeFileSync(key, "-----BEGIN RSA PRIVATE KEY-----\nnot a key\n-----END RSA PRIVATE KEY-----\n");
  const path = liveConfigPath(home);
  const read = (repository: string) => {
    writeFileSync(path, JSON.stringify({ app: { id: 5202093, keyPath: key }, repositories: [repository] }));
    return () => readLiveConfig(path);
  };

  // GitHub's characters: an owner of letters, digits and `-`; a name of letters, digits, `-`, `_` and `.`.
  const fine: [string, { owner: string; name: string }][] = [
    ["lookover-dev/lookover-private", { owner: "lookover-dev", name: "lookover-private" }],
    ["Some-Org/my_repo.v2", { owner: "Some-Org", name: "my_repo.v2" }],
    ["a1/.github", { owner: "a1", name: ".github" }],
    ["o/..x", { owner: "o", name: "..x" }],
  ];
  for (const [written, repo] of fine) expect(read(written)().repositories).toEqual([repo]);

  for (const wrong of [
    "../x",
    "C:/y",
    "sasensi/..",
    "sasensi/.",
    "sa_sensi/x",
    "sasensi/a b",
    "sasensi/x\\..",
    "o.k/x",
  ])
    expect(read(wrong)).toThrow(
      `${path}: "repositories" must list the repositories live mode may use, each "owner/name".\nWrite it as:`,
    );
});

test("the sign-in terminal gets the engine's allow-listed environment, never the service's GitHub token", async () => {
  const opened: TerminalInvocation[] = [];
  const env = { PATH: "/usr/bin", HOME: "/home/me", GH_TOKEN: "ghp_test", GITHUB_TOKEN: "ghs_test" };
  const engines = createEngines({
    runner: createProcessRunner({ registryFile: "unused.json" }),
    env,
    claude: { executable: "/opt/claude/claude", args: [] },
    codex: { executable: "/opt/codex/codex", args: [] },
  });
  const sessions: Record<string, string | undefined>[] = [];
  const signIn = terminalSignIn(engines, env, async (invocation, session = {}) => {
    opened.push(invocation);
    sessions.push(session);
    return { opened: true, pid: 1 };
  });
  await signIn.open("claude");
  await signIn.open("codex");
  expect(opened.map((o) => o.env)).toEqual([engineEnv("claude", env), engineEnv("codex", env)]);
  // The service's environment goes to the terminal as its session, read there for the desktop only.
  expect(sessions).toEqual([env, env]);
  for (const invocation of opened) {
    expect(invocation.env.PATH).toBe("/usr/bin");
    expect(Object.keys(invocation.env)).not.toContain("GH_TOKEN");
    expect(Object.keys(invocation.env)).not.toContain("GITHUB_TOKEN");
  }
});
