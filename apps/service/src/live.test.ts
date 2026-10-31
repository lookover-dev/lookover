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
  readLiveConfig,
  servedLiveConfig,
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

test("a live config may name an organisation's App and sandbox, apart from its repositories and its App", () => {
  const home = dir();
  const key = join(home, "app.pem");
  writeFileSync(key, "-----BEGIN RSA PRIVATE KEY-----\nnot a key\n-----END RSA PRIVATE KEY-----\n");
  const path = liveConfigPath(home);
  const write = (config: unknown) => writeFileSync(path, JSON.stringify(config));
  const app = { id: 5202093, keyPath: key };
  const repositories = ["sasensi/lookover-sandbox"];
  const orgKey = join(home, "org.pem");
  const organisation = { app: { id: 6100001, keyPath: orgKey }, sandbox: "lookover-dev/lookover-sandbox" };

  // Its key file may be missing: `bun run live` skips the organisation's path then, saying so.
  write({ app, repositories, organisation });
  expect(readLiveConfig(path)).toEqual({
    app,
    repositories: [{ owner: "sasensi", name: "lookover-sandbox" }],
    organisation: {
      app: { id: 6100001, keyPath: orgKey },
      sandbox: { owner: "lookover-dev", name: "lookover-sandbox" },
    },
  });
  write({ app, repositories });
  expect(readLiveConfig(path).organisation).toBeUndefined();

  // Listed, its sandbox would be watched by the personal App.
  write({
    app,
    repositories: ["lookover-dev/lookover-private", "Lookover-Dev/Lookover-Sandbox"],
    organisation,
  });
  expect(() => readLiveConfig(path)).toThrow(
    `${path}: "organisation.sandbox" names lookover-dev/lookover-sandbox, which "repositories" lists too: the organisation's App watches it, so take it out of "repositories".\nWrite it as:`,
  );
  write({ app, repositories, organisation: { ...organisation, app: { ...organisation.app, id: app.id } } });
  expect(() => readLiveConfig(path)).toThrow(
    `${path}: "organisation.app" names App 5202093, which "app" names too: the organisation's App is another one.\nWrite it as:`,
  );
  for (const wrong of [
    42,
    { sandbox: organisation.sandbox },
    { ...organisation, sandbox: "lookover-sandbox" },
    { ...organisation, app: { id: "6100001", keyPath: orgKey } },
    { ...organisation, app: { id: 6100001, keyPath: "" } },
  ]) {
    write({ app, repositories, organisation: wrong });
    expect(() => readLiveConfig(path)).toThrow(
      `${path}: "organisation", when given, must be { "app": { "id": <its id>, "keyPath": "<its key>" }, "sandbox": "owner/name", "repositories": ["owner/name"] }, its "repositories" optional.`,
    );
  }
  expect(LIVE_CONFIG_HELP).toContain(`"organisation": {`);
});

/** A data folder with the test App's key and the organisation App's, and a `live.json` to write in it. */
function withKeys() {
  const home = dir();
  const key = join(home, "app.pem");
  const orgKey = join(home, "org.pem");
  for (const file of [key, orgKey])
    writeFileSync(file, "-----BEGIN RSA PRIVATE KEY-----\nnot a key\n-----END RSA PRIVATE KEY-----\n");
  const path = liveConfigPath(home);
  const write = (config: unknown) => writeFileSync(path, JSON.stringify(config));
  return { path, write, app: { id: 5202093, keyPath: key }, orgApp: { id: 5297673, keyPath: orgKey } };
}

test("the owner's live.json is taken: the test App on the sandbox, and the organisation's App on its sandbox and Lookover's own", () => {
  const { path, write, app, orgApp } = withKeys();
  write({
    app,
    repositories: ["sasensi/lookover-sandbox"],
    fork: "lookover-forks/lookover-sandbox",
    organisation: {
      app: orgApp,
      sandbox: "lookover-dev/lookover-sandbox",
      repositories: ["lookover-dev/lookover-private"],
    },
  });
  // `lookover-sandbox` twice, apart: the personal App is given one, the organisation's the other.
  expect(readLiveConfig(path)).toEqual({
    app,
    repositories: [{ owner: "sasensi", name: "lookover-sandbox" }],
    fork: { owner: "lookover-forks", name: "lookover-sandbox" },
    organisation: {
      app: orgApp,
      sandbox: { owner: "lookover-dev", name: "lookover-sandbox" },
      repositories: [{ owner: "lookover-dev", name: "lookover-private" }],
    },
  });
  expect(LIVE_CONFIG_HELP).toContain(`"repositories": ["lookover-dev/lookover-private"]`);
  // The owner's only repository it names is the sandbox: no other, private or old.
  expect(new Set(LIVE_CONFIG_HELP.match(/\bsasensi\/[\w.-]+/g))).toEqual(
    new Set(["sasensi/lookover-sandbox"]),
  );
});

test("the organisation's repositories are its own, apart from its sandbox and from repositories, each refusal saying what to change", () => {
  const { path, write, app, orgApp } = withKeys();
  const repositories = ["sasensi/lookover-sandbox"];
  const sandbox = "lookover-dev/lookover-sandbox";
  const refused = (listed: unknown, top = repositories) => {
    write({ app, repositories: top, organisation: { app: orgApp, sandbox, repositories: listed } });
    return () => readLiveConfig(path);
  };

  // Its login ignores case, as GitHub's does.
  write({
    app,
    repositories,
    organisation: { app: orgApp, sandbox, repositories: ["Lookover-Dev/lookover-private"] },
  });
  expect(readLiveConfig(path).organisation?.repositories).toEqual([
    { owner: "Lookover-Dev", name: "lookover-private" },
  ]);

  for (const wrong of [
    [],
    "lookover-dev/lookover-private",
    ["lookover-private"],
    ["lookover-dev/../x"],
    [42],
  ])
    expect(refused(wrong)).toThrow(
      `${path}: "organisation.repositories", when given, must list the organisation's repositories live mode watches besides its sandbox, each "owner/name".\nWrite it as:`,
    );
  expect(refused(["sasensi/lookover-private"])).toThrow(
    `${path}: "organisation.repositories" names sasensi/lookover-private, which lookover-dev doesn't own: the organisation's App watches the repositories of the organisation that owns "organisation.sandbox", so take it out.\nWrite it as:`,
  );
  expect(refused(["Lookover-Dev/Lookover-Sandbox"])).toThrow(
    `${path}: "organisation.repositories" names Lookover-Dev/Lookover-Sandbox, which is "organisation.sandbox": it is watched already, so take it out of "organisation.repositories".\nWrite it as:`,
  );
  expect(
    refused(["lookover-dev/lookover-private"], [...repositories, "Lookover-Dev/Lookover-Private"]),
  ).toThrow(
    `${path}: "organisation.repositories" names lookover-dev/lookover-private, which "repositories" lists too: the two Apps never watch one repository, so take it out of one of them.\nWrite it as:`,
  );
  expect(refused(["lookover-dev/lookover-private", "lookover-dev/Lookover-Private"])).toThrow(
    `${path}: "organisation.repositories" lists lookover-dev/lookover-private twice, the second time as lookover-dev/Lookover-Private: keep one of them.\nWrite it as:`,
  );
});

test("live mode serves the organisation's App on its sandbox and repositories when it lists some, and the config as read otherwise", () => {
  const { path, write, app, orgApp } = withKeys();
  const organisation = { app: orgApp, sandbox: "lookover-dev/lookover-sandbox" };
  const personal = {
    app,
    repositories: ["sasensi/lookover-sandbox"],
    fork: "lookover-forks/lookover-sandbox",
  };

  write({ ...personal, organisation: { ...organisation, repositories: ["lookover-dev/lookover-private"] } });
  const read = readLiveConfig(path);
  // No `fork`, no `organisation`: nothing later reads the personal fork on the organisation's App.
  expect(servedLiveConfig(read, path)).toEqual({
    live: {
      app: orgApp,
      repositories: [
        { owner: "lookover-dev", name: "lookover-sandbox" },
        { owner: "lookover-dev", name: "lookover-private" },
      ],
    },
    said: "Runs as lookover-dev's App 5297673 on lookover-dev/lookover-sandbox and lookover-dev/lookover-private.",
  });

  write({ ...personal, organisation });
  const asWritten = readLiveConfig(path);
  expect(servedLiveConfig(asWritten, path)).toEqual({ live: asWritten });

  // Its `watch` is still said to be ignored.
  write({
    ...personal,
    watch: "x",
    organisation: { ...organisation, repositories: ["lookover-dev/lookover-private"] },
  });
  expect(servedLiveConfig(readLiveConfig(path), path).live.ignored).toEqual(["watch"]);
});

test("live mode on the organisation's repositories needs its App's key file, which bun run live may go without", () => {
  const { path, write, app, orgApp } = withKeys();
  const gone = `${orgApp.keyPath}.gone`;
  write({
    app,
    repositories: ["sasensi/lookover-sandbox"],
    organisation: {
      app: { ...orgApp, keyPath: gone },
      sandbox: "lookover-dev/lookover-sandbox",
      repositories: ["lookover-dev/lookover-private"],
    },
  });
  const read = readLiveConfig(path);
  expect(() => servedLiveConfig(read, path)).toThrow(
    `${path}: "organisation.app.keyPath" names no file: ${gone}. Write it with bun run export-app-key, or take "repositories" out of "organisation": with them, a live service runs as the organisation's App.\nWrite it as:`,
  );
});

test("live.json's organisation App works for the person gh is signed in as, and is refused, saying why, when gh names nobody", async () => {
  const gh = memoryGh({ as: { id: 11247504, login: "sasensi" } });
  const person = ghPerson(gh);
  expect(await person()).toEqual({ id: 11247504, login: "sasensi" });
  const refused = "An organisation's App works for the person gh is signed in as, and";
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
