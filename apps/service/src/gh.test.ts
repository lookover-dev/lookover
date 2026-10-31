// The person's own `gh` (ADR 0059) through its real adapter, `ghCli`, on a scripted `gh`: a Bun script that answers
// each `gh api` path as the real one did (its `--include`d status, headers and body, recorded 2026-10-12 with the
// owner's `gh` 2.102.0, ids kept, request ids dropped), and writes down what it was run with. The port's suite runs on
// it; then what only the real adapter does: the time limit, nothing on standard input, the allow-listed environment
// with `gh`'s own variables, reads only, `gh` found as `lookover` on the PATH is, and never the real `gh` under
// `bun test`.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { HostLogin } from "@lookover/contracts";
import { describeGh } from "@lookover/testkit";
import { ghCli, osGh, realSystem } from "./index.ts";

// Each read starts a Bun process: seconds apiece on a busy machine.
setDefaultTimeout(30_000);

/** This machine's environment: PATH and the system's variables a program needs to start. */
const ENV = realSystem().env;

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "lookover-gh-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let made = 0;
const folder = () => {
  const dir = join(scratch, `gh ${++made}`);
  mkdirSync(dir);
  return dir;
};

/** One answer of the scripted `gh`: what it prints, its exit code, and how long it waits first. */
interface Answer {
  out?: string;
  err?: string;
  code?: number;
  waitMs?: number;
}

const CRLF = "\r\n";
/** A response as `gh api --include` prints it. */
function http(status: string, headers: Record<string, string>, body: unknown): string {
  const lines = [`HTTP/2.0 ${status}`, "Content-Type: application/json; charset=utf-8", "Server: github.com"];
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
  return `${lines.join(CRLF)}${CRLF}${CRLF}${JSON.stringify(body)}`;
}

/** The scopes `gh auth login` gives by default, as GitHub echoes them on every response. */
const SCOPES = { "X-Oauth-Scopes": "gist, read:org, repo, workflow" };
/** What a membership's endpoints accept. */
const ACCEPTS = { "X-Accepted-Oauth-Scopes": "admin:org, read:org, repo, user, write:org" };

const sam: HostLogin = { id: 11247504, login: "sasensi" };
const lookoverDev: HostLogin = { id: 338456971, login: "lookover-dev" };
const orbit: HostLogin = { id: 339000101, login: "orbit" };
const harbor: HostLogin = { id: 846000, login: "harbor" };

const user = { login: "sasensi", id: 11247504, type: "User", site_admin: false, name: "Samuel Asensi" };
const membershipOf = (organisation: HostLogin, role: string, state = "active") => ({
  url: `https://api.github.com/orgs/${organisation.login}/memberships/sasensi`,
  state,
  role,
  organization_url: `https://api.github.com/orgs/${organisation.login}`,
  organization: { login: organisation.login, id: organisation.id, description: null },
  user,
});
const notFound = {
  message: "Not Found",
  documentation_url:
    "https://docs.github.com/rest/orgs/members#get-an-organization-membership-for-the-authenticated-user",
  status: "404",
};

/** The path of the person's active memberships, first page. */
const LIST = "user/memberships/orgs?state=active&per_page=100";

/** Sam's answers, by path: signed in, an admin of two organisations, a member of one. */
const SIGNED_IN: Record<string, Answer> = {
  user: { out: http("200 OK", SCOPES, user) },
  [LIST]: {
    out: http("200 OK", { ...SCOPES, ...ACCEPTS }, [
      membershipOf(harbor, "member"),
      membershipOf(lookoverDev, "admin"),
      membershipOf(orbit, "admin"),
    ]),
  },
  "user/memberships/orgs/lookover-dev": { out: http("200 OK", SCOPES, membershipOf(lookoverDev, "admin")) },
  "user/memberships/orgs/LOOKOVER-DEV": { out: http("200 OK", SCOPES, membershipOf(lookoverDev, "admin")) },
  "user/memberships/orgs/orbit": { out: http("200 OK", SCOPES, membershipOf(orbit, "admin")) },
  "user/memberships/orgs/harbor": { out: http("200 OK", SCOPES, membershipOf(harbor, "member")) },
  "user/memberships/orgs/acme-labs": {
    out: http("200 OK", SCOPES, membershipOf({ id: 412000, login: "acme-labs" }, "member", "pending")),
  },
  "user/memberships/orgs/github": {
    out: http("404 Not Found", { ...SCOPES, ...ACCEPTS }, notFound),
    err: 'gh: Not Found (HTTP 404)\ngh: This API operation needs the "admin:org" scope.',
    code: 1,
  },
};

/** Every path answered the same. */
const always = (answer: Answer): Record<string, Answer> => ({ "*": answer });

const SIGNED_OUT = always({
  err: "To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n",
  code: 4,
});
const OFFLINE = always({
  err: 'Get "https://api.github.com/user": proxyconnect tcp: dial tcp 127.0.0.1:9: connectex: No connection could be made because the target machine actively refused it.\n',
  code: 1,
});
/** A token of `gist` alone: who answers, an organisation's reads are refused for their scope. */
const NO_READ_ORG: Record<string, Answer> = {
  user: { out: http("200 OK", { "X-Oauth-Scopes": "gist" }, user) },
  "*": {
    out: http(
      "403 Forbidden",
      { "X-Oauth-Scopes": "gist", ...ACCEPTS },
      { message: "You need at least read:org scope or user scope to list your organization memberships." },
    ),
    code: 1,
  },
};
/** Orbit behind SAML the token isn't authorised for: its membership refused, the list left without it, saying so. */
const SSO: Record<string, Answer> = {
  ...SIGNED_IN,
  [LIST]: {
    out: http(
      "200 OK",
      { ...SCOPES, ...ACCEPTS, "X-Github-Sso": `partial-results; organizations=${orbit.id}` },
      [membershipOf(harbor, "member"), membershipOf(lookoverDev, "admin")],
    ),
  },
  "user/memberships/orgs/orbit": {
    out: http(
      "403 Forbidden",
      {
        ...SCOPES,
        "X-Github-Sso": "required; url=https://github.com/orgs/orbit/sso?authorization_request=A",
      },
      {
        message:
          "Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization.",
      },
    ),
    code: 1,
  },
};

/**
 * A scripted `gh` in its own folder: it answers `answers` by the last argument, `*` for any other, and writes its
 * arguments, environment and standard input to `ran.json`. The command that runs it, and where it writes.
 */
function scriptedGh(answers: Record<string, Answer>): { command: () => Promise<string[]>; ran: string } {
  const dir = folder();
  const ran = join(dir, "ran.json");
  const script = join(dir, "gh.ts");
  writeFileSync(
    script,
    `const answers = ${JSON.stringify(answers)};
const args = process.argv.slice(2);
const answer = answers[args[args.length - 1]] ?? answers["*"] ?? { err: "no answer scripted", code: 1 };
const stdin = await new Response(Bun.stdin.stream()).text();
await Bun.write(${JSON.stringify(ran)}, JSON.stringify({ args, env: process.env, stdin }));
if (answer.waitMs) await Bun.sleep(answer.waitMs);
process.stdout.write(answer.out ?? "");
process.stderr.write(answer.err ?? "");
process.exit(answer.code ?? 0);
`,
  );
  return { command: async () => [process.execPath, script], ran };
}

/** The real adapter on a scripted `gh`, with this process's environment. */
const ghOn = (
  answers: Record<string, Answer>,
  o: { env?: Record<string, string | undefined>; timeoutMs?: number } = {},
) =>
  ghCli({
    env: o.env ?? ENV,
    platform: process.platform,
    homedir: scratch,
    command: scriptedGh(answers).command,
    ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
  });

describeGh("ghCli on a scripted gh", {
  signedIn: async () => ({
    gh: ghOn(SIGNED_IN),
    person: sam,
    admin: [lookoverDev, orbit],
    member: [harbor],
    pending: { id: 412000, login: "acme-labs" },
    absent: "github",
  }),
  signedOut: async () => ghOn(SIGNED_OUT),
  missing: async () =>
    ghCli({ env: ENV, platform: process.platform, homedir: scratch, command: async () => null }),
  offline: async () => ghOn(OFFLINE),
  noReadOrg: async () => ghOn(NO_READ_ORG),
  sso: async () => ({ gh: ghOn(SSO), organisation: "orbit" }),
});

describe("the real adapter", () => {
  test("never runs the real gh under bun test (ADR 0045)", () => {
    expect(() => osGh(realSystem())).toThrow(/bun test/);
    expect(() => ghCli({ env: ENV, platform: process.platform, homedir: homedir() })).toThrow(/bun test/);
  });

  test("reads only, from api.github.com whatever GH_HOST says, nothing on standard input", async () => {
    const { command, ran } = scriptedGh(SIGNED_IN);
    const gh = ghCli({
      env: { ...ENV, GH_HOST: "ghe.example.com" },
      platform: process.platform,
      homedir: scratch,
      command,
    });
    await gh.membership("lookover-dev");
    const seen = JSON.parse(readFileSync(ran, "utf8"));
    expect(seen.args).toEqual([
      "api",
      "--hostname",
      "github.com",
      "--method",
      "GET",
      "--include",
      "user/memberships/orgs/lookover-dev",
    ]);
    expect(seen.stdin).toBe("");
  });

  test("its environment: the allow-list and gh's sign-in, then never a prompt nor an update notice", async () => {
    const { command, ran } = scriptedGh(SIGNED_IN);
    const env = {
      ...ENV,
      GH_TOKEN: "gho_the-persons-own",
      GH_CONFIG_DIR: "C:/Users/Your Name/gh",
      GH_HOST: "ghe.example.com",
      GH_PROMPT_DISABLED: "0",
      ANTHROPIC_API_KEY: "sk-ant-not-for-gh",
      LOOKOVER_HOME: "C:/Users/Your Name/lookover",
    };
    await ghCli({ env, platform: process.platform, homedir: scratch, command }).person();
    const seen: Record<string, string> = JSON.parse(readFileSync(ran, "utf8")).env;
    expect(seen.GH_TOKEN).toBe("gho_the-persons-own");
    expect(seen.GH_CONFIG_DIR).toBe("C:/Users/Your Name/gh");
    expect(seen.GH_PROMPT_DISABLED).toBe("1");
    expect(seen.GH_NO_UPDATE_NOTIFIER).toBe("1");
    for (const name of ["GH_HOST", "ANTHROPIC_API_KEY", "LOOKOVER_HOME", "LOOKOVER_UNDER_TEST"])
      expect(Object.keys(seen).map((k) => k.toUpperCase())).not.toContain(name);
  });

  test("a gh that doesn't answer in time is stopped, and the read can't answer, for the time", async () => {
    const started = Date.now();
    const answer = await ghOn(always({ out: http("200 OK", SCOPES, user), waitMs: 20_000 }), {
      timeoutMs: 1_500,
    }).person();
    expect(answer).toMatchObject({ kind: "unanswered", why: "timeout" });
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  test("a gh gone between finding it and running it reads as missing", async () => {
    const gh = ghCli({
      env: ENV,
      platform: process.platform,
      homedir: scratch,
      command: async () => [join(scratch, "no such gh.exe")],
    });
    expect(await gh.person()).toEqual({ kind: "missing" });
  });

  test("a revoked token is signed out; GitHub refusing otherwise can't answer, with its words", async () => {
    const revoked = always({ out: http("401 Unauthorized", {}, { message: "Bad credentials" }), code: 1 });
    expect(await ghOn(revoked).person()).toEqual({ kind: "signed-out" });
    const down = always({
      out: http("503 Service Unavailable", {}, { message: "Service Unavailable" }),
      code: 1,
    });
    expect(await ghOn(down).membership("lookover-dev")).toEqual({
      kind: "unanswered",
      why: "failed",
      detail: "Service Unavailable (HTTP 503)",
    });
  });

  test("the organisations an SSO hides from a list: the list can't answer, for SSO", async () => {
    // GitHub answers 200 and leaves out the organisations whose SAML the token isn't authorised for, saying so.
    const partial: Record<string, Answer> = {
      ...SIGNED_IN,
      [LIST]: {
        out: http(
          "200 OK",
          { ...SCOPES, ...ACCEPTS, "X-Github-Sso": "partial-results; organizations=21955855,20582480" },
          [membershipOf(lookoverDev, "admin")],
        ),
      },
    };
    expect(await ghOn(partial).memberships()).toMatchObject({ kind: "unanswered", why: "sso" });
  });

  test("a list longer than a page: every page read, by the Link GitHub gives", async () => {
    const next = (page: number) =>
      `<https://api.github.com/user/memberships/orgs?state=active&per_page=100&page=${page}>; rel="next", <https://api.github.com/user/memberships/orgs?state=active&per_page=100&page=3>; rel="last"`;
    const paged: Record<string, Answer> = {
      ...SIGNED_IN,
      [LIST]: {
        out: http("200 OK", { ...SCOPES, Link: next(2) }, [membershipOf(lookoverDev, "admin")]),
      },
      [`${LIST}&page=2`]: {
        out: http("200 OK", { ...SCOPES, Link: next(3) }, [membershipOf(harbor, "member")]),
      },
      [`${LIST}&page=3`]: { out: http("200 OK", SCOPES, [membershipOf(orbit, "admin")]) },
    };
    expect(await ghOn(paged).memberships()).toEqual({
      kind: "listed",
      person: sam,
      organisations: [
        { organisation: lookoverDev, role: "owner" },
        { organisation: harbor, role: "member" },
        { organisation: orbit, role: "owner" },
      ],
    });
  });

  test("a list whose next page never ends can't answer", async () => {
    const endless = always({
      out: http(
        "200 OK",
        {
          ...SCOPES,
          Link: '<https://api.github.com/user/memberships/orgs?state=active&per_page=100&page=2>; rel="next"',
        },
        [membershipOf(lookoverDev, "admin")],
      ),
    });
    expect(await ghOn(endless).memberships()).toMatchObject({ kind: "unanswered", why: "failed" });
  });

  test("an answer of another shape can't answer, and says so", async () => {
    const odd = always({ out: http("200 OK", SCOPES, { login: "sasensi" }) });
    expect(await ghOn(odd).person()).toMatchObject({ kind: "unanswered", why: "failed" });
  });
});

describe("where gh is", () => {
  const windows = process.platform === "win32";
  const exe = windows ? "gh.exe" : "gh";
  /**
   * A `gh` compiled from a script, so it runs as `gh.exe` does on Windows: it answers `user` as the account whose login
   * is the name of the folder it sits in, so a read says which `gh` ran.
   */
  let compiled = "";
  beforeAll(() => {
    const script = join(folder(), "gh.ts");
    writeFileSync(
      script,
      `import { basename, dirname } from "node:path";
const login = basename(dirname(process.execPath));
process.stdout.write("HTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n" + JSON.stringify({ id: 1, login }));
`,
    );
    compiled = join(folder(), exe);
    const built = Bun.spawnSync([process.execPath, "build", "--compile", script, "--outfile", compiled]);
    if (built.exitCode !== 0) throw new Error(built.stderr.toString());
  }, 60_000);

  /** A folder named `name` holding the scripted `gh`, linked, not copied: it is large. */
  const withGh = (name: string) => {
    const dir = join(folder(), name);
    mkdirSync(dir);
    linkSync(compiled, join(dir, exe));
    return dir;
  };

  /** A home folder with nothing in it: gh runs there, and on Windows scoop's shims are under it. */
  const home = folder();

  /** This machine's environment, without its PATH nor the variables naming the installers' folders. */
  const bare = Object.fromEntries(
    Object.entries(ENV).filter(
      ([name]) =>
        !["PATH", "PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA", "PROGRAMDATA"].includes(
          name.toUpperCase(),
        ),
    ),
  );

  /** The real adapter searching only the test's folders: `path` as its PATH, `saved` and `installers`. */
  const searching = (
    path: string[],
    o: { saved?: string[]; installers?: string[]; env?: Record<string, string> } = {},
  ) =>
    ghCli({
      env: { ...bare, ...o.env, PATH: path.join(windows ? ";" : ":") },
      platform: process.platform,
      homedir: home,
      saved: async () => o.saved ?? [],
      installers: o.installers ?? [],
    });

  /** Which `gh` a read ran: the folder's name it answered as, or the read's kind when none ran. */
  const ran = async (gh: ReturnType<typeof ghCli>) => {
    const answer = await gh.person();
    return answer.kind === "signed-in" ? answer.account.login : answer.kind;
  };

  test("this process's PATH first, in order; a relative entry never; then the PATH a new terminal starts with, then the installers' folders", async () => {
    const first = withGh("first");
    const second = withGh("second");
    const saved = withGh("saved");
    const installed = withGh("installed");
    expect(await ran(searching(["", ".", folder(), first, second], { saved: [saved] }))).toBe("first");
    expect(await ran(searching([folder()], { saved: ["relative", saved], installers: [installed] }))).toBe(
      "saved",
    );
    expect(await ran(searching([folder()], { saved: [folder()], installers: [installed] }))).toBe(
      "installed",
    );
  });

  test("none on any PATH nor in the installers' folders: missing", async () => {
    expect(await ran(searching([folder()], { saved: [folder()], installers: [folder()] }))).toBe("missing");
  });

  test("under bun test, never a search of a folder that isn't the test's own", () => {
    const own = { env: bare, platform: process.platform, homedir: scratch };
    expect(() => ghCli({ ...own, installers: [] })).toThrow(/bun test/);
    if (!windows) expect(() => ghCli({ ...own, saved: async () => [] })).toThrow(/bun test/);
  });

  test.if(windows)("on Windows only gh.exe, then the installers' folders under Program Files", async () => {
    const dir = folder();
    writeFileSync(join(dir, "gh.cmd"), "@echo off\r\n");
    writeFileSync(join(dir, "gh"), "#!/bin/sh\n");
    const installed = folder();
    const gh = (env: Record<string, string>) =>
      ghCli({
        env: { ...bare, ...env, Path: dir },
        platform: "win32",
        homedir: home,
        saved: async () => [],
      });
    expect(await ran(gh({}))).toBe("missing");
    mkdirSync(join(installed, "GitHub CLI"));
    linkSync(compiled, join(installed, "GitHub CLI", "gh.exe"));
    expect(await ran(gh({ ProgramFiles: installed }))).toBe("GitHub CLI");
  });
});
