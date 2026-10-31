// The person's own `gh` (ADR 0059): a port, `Gh`, that says who the GitHub CLI is signed in as, that account's active
// organisation memberships with its role in each (ADR 0067), and its membership of one organisation. Before an App exists the service
// has no GitHub credential of its own, and an App's credentials can't say which person runs Lookover: the person's
// `gh` login can, since GitHub vouches for it. Every read answers, never rejects: `missing` (no `gh`), `signed-out`,
// or `unanswered` with why (GitHub out of reach, an organisation's SAML single sign-on, a token without `read:org`, no
// answer in time, anything else) and `gh`'s own words. Reads only: `gh api` with `GET`, never a write.
// The fake is testkit's `memoryGh` (demo mode and the tests; its shapes are these, `describeGh` holds both to one
// contract). The real one (`ghCli`) runs `gh` by absolute path, found as `lookover` on the PATH is (ADR 0058): this
// process's PATH, then on Windows the PATH a new terminal starts with (a start at login keeps a thin or old one), then
// the folders `gh`'s installers use; on Windows only `gh.exe`. It asks `api.github.com` whatever `GH_HOST` says, with
// its own `--include`d status and headers, under a time limit, with nothing on its standard input, never a prompt
// (`GH_PROMPT_DISABLED`) nor an update notice (`GH_NO_UPDATE_NOTIFIER`), and the engines' allow-listed environment
// (ADR 0048) plus `gh`'s own sign-in variables (`GH_TOKEN`, `GITHUB_TOKEN`, `GH_CONFIG_DIR`). It refuses to be built
// under `bun test` (ADR 0045) unless a test gives it the command to run (a scripted `gh`) or only folders of its own
// to search, or it is `bun run live`'s suite (`scripts/live-gh.ts`), which reads the owner's real `gh`.
import { execFile } from "node:child_process";
import { delimiter, isAbsolute, join } from "node:path";
import type {
  Gh,
  GhMembership,
  GhOrganisation,
  GhPerson,
  GhUnanswered,
  GhWhy,
  HostLogin,
} from "@lookover/contracts";
import { programEnv } from "@lookover/engines";
import { z } from "zod";
import { caseBlind, isFile, runnable, savedPath } from "./command-path.ts";
import { type System, setVariables, underTest } from "./config.ts";
import { realReg } from "./reg.ts";

/** How long one `gh api` may take, by default. */
const GH_TIMEOUT_MS = 20_000;

/** `gh`'s own variables a read may need: its sign-in (a token, or the folder holding it). Never `GH_HOST`. */
const GH_EXTRAS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR"];

/** Lookover's own, whatever the shell says: never a prompt, an update notice, a spinner or colours. */
const GH_OWN = {
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
  GH_SPINNER_DISABLED: "1",
  NO_COLOR: "1",
  NoDefaultCurrentDirectoryInExePath: "1",
};

/** An organisation's login as GitHub allows it: letters, digits and single hyphens, 39 at most. */
const ORGANISATION_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** Thrown by the real adapter built under `bun test` without a command of its own to run. */
const UNDER_TEST =
  "The real gh never runs under bun test: a test reads no one's GitHub login (ADR 0045). Use memoryGh, or ghCli with a scripted command.";

/** The variable's value, whatever its case on Windows. */
function variable(env: Record<string, string | undefined>, name: string, platform: NodeJS.Platform): string {
  return (platform === "win32" ? caseBlind(env, name) : env[name]) ?? "";
}

/** The folders `gh`'s installers put it in, for a PATH that doesn't name them. */
function knownFolders(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  homedir: string,
): string[] {
  if (platform === "win32") {
    const v = (name: string) => variable(env, name, platform);
    const under = (root: string, ...rest: string[]) => (root === "" ? "" : join(root, ...rest));
    return [
      under(v("PROGRAMFILES"), "GitHub CLI"),
      under(v("PROGRAMFILES(X86)"), "GitHub CLI"),
      under(v("LOCALAPPDATA"), "Programs", "GitHub CLI"),
      under(v("LOCALAPPDATA"), "Microsoft", "WinGet", "Links"),
      under(homedir, "scoop", "shims"),
      under(v("PROGRAMDATA"), "chocolatey", "bin"),
    ];
  }
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/home/linuxbrew/.linuxbrew/bin",
    join(homedir, ".local", "bin"),
    "/usr/bin",
    "/snap/bin",
  ];
}

/**
 * Where `gh` is: the first absolute folder of this process's PATH, then of `saved` (the PATH a new terminal starts
 * with, Windows), then of `installers` (the folders its installers use), that holds `gh.exe` (Windows) or a runnable
 * `gh`; null when none does. A relative PATH entry is never searched: it would name the working folder.
 */
function locateGh(o: {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  saved: string[];
  installers: string[];
}): string | null {
  const windows = o.platform === "win32";
  const folders = [
    ...variable(o.env, "PATH", o.platform).split(windows ? ";" : delimiter),
    ...o.saved,
    ...o.installers,
  ];
  for (const folder of folders.map((f) => f.trim())) {
    if (folder === "" || !isAbsolute(folder)) continue;
    const file = join(folder, windows ? "gh.exe" : "gh");
    if (windows ? isFile(file) : runnable(file)) return file;
  }
  return null;
}

/** What one run of `gh` gave: its exit code and what it printed, or that it couldn't run or didn't end in time. */
type Ran =
  | { kind: "exited"; code: number; out: string; err: string }
  | { kind: "not-found" }
  | { kind: "timeout" }
  | { kind: "failed"; detail: string };

/** `command` with `args`, its environment `env`, in `cwd`, killed past `timeoutMs`; nothing on its standard input. */
function run(
  command: string[],
  args: string[],
  o: { env: Record<string, string>; cwd: string; timeoutMs: number },
): Promise<Ran> {
  const [file, ...first] = command;
  if (file === undefined) return Promise.resolve({ kind: "not-found" });
  return new Promise((done) => {
    const child = execFile(
      file,
      [...first, ...args],
      { env: o.env, cwd: o.cwd, timeout: o.timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, out, err) => {
        if (error === null) return done({ kind: "exited", code: 0, out, err });
        if (error.code === "ENOENT") return done({ kind: "not-found" });
        if (error.killed) return done({ kind: "timeout" });
        if (typeof error.code === "number") return done({ kind: "exited", code: error.code, out, err });
        done({ kind: "failed", detail: error.message });
      },
    );
    child.stdin?.end();
  });
}

/** A response `gh api --include` printed: its status, its headers (names in lower case) and its body. */
interface Response {
  status: number;
  headers: Map<string, string>;
  body: unknown;
}

/** The response in `out`, when `gh` printed one: its status line, headers, a blank line, then the body. */
function responseIn(out: string): Response | null {
  const status = /^HTTP\/\S+ (\d{3})/.exec(out);
  if (status?.[1] === undefined) return null;
  const end = /\r?\n\r?\n/.exec(out);
  const head = end === null ? out : out.slice(0, end.index);
  const text = end === null ? "" : out.slice(end.index + end[0].length);
  const headers = new Map<string, string>();
  for (const line of head.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  let body: unknown = null;
  try {
    body = text.trim() === "" ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: Number(status[1]), headers, body };
}

/** `gh`'s words, on one line and short: what the log will say. */
const wordsOf = (text: string): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 300 ? `${line.slice(0, 299)}…` : line;
};

const unanswered = (why: GhWhy, detail: string): GhUnanswered => ({
  kind: "unanswered",
  why,
  detail: wordsOf(detail) || why,
});

/** The words of an error that reached no response: GitHub out of reach, as Go's network errors say it. */
const OFFLINE =
  /error connecting to|dial tcp|no such host|proxyconnect|connection refused|actively refused|network is unreachable|i\/o timeout|TLS handshake timeout|connection reset|EOF$/im;

/** What a response's message says, when it has one. */
const messageOf = (body: unknown): string =>
  typeof body === "object" && body !== null && "message" in body && typeof body.message === "string"
    ? body.message
    : "";

/** The scopes a header lists. */
const scopesIn = (header: string | undefined): string[] =>
  (header ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** A refused response in a few words: GitHub's message and the status. */
const saidBy = (response: Response): string => `${messageOf(response.body)} (HTTP ${response.status})`;

/**
 * Why a refused response says nothing of the person, or null when it may: SAML single sign-on that the token isn't
 * authorised for, or a token without any scope the call accepts (a classic token's `X-OAuth-Scopes` against
 * `X-Accepted-OAuth-Scopes`; a token that lists none, fine-grained, isn't judged).
 */
function untrusted(response: Response): GhUnanswered | null {
  if (response.headers.has("x-github-sso") || /SAML/i.test(messageOf(response.body)))
    return unanswered("sso", saidBy(response));
  const accepted = scopesIn(response.headers.get("x-accepted-oauth-scopes"));
  const held = response.headers.get("x-oauth-scopes");
  if (accepted.length > 0 && held !== undefined && !accepted.some((s) => scopesIn(held).includes(s)))
    return unanswered("scope", `${saidBy(response)}: the token needs one of ${accepted.join(", ")}`);
  return null;
}

/** A refused response as no answer: why it can't be trusted, else GitHub's refusal. */
const refusal = (response: Response): GhUnanswered =>
  untrusted(response) ?? unanswered("failed", saidBy(response));

/** A read's outcome: a response that succeeded, a response to judge, or no answer. */
type Heard = { kind: "ok"; response: Response } | { kind: "refused"; response: Response } | GhUnanswered;

/** What a run of `gh api` says, before the read makes sense of it. */
function heard(ran: Ran, timeoutMs: number): Heard {
  if (ran.kind === "not-found") return { kind: "missing" };
  if (ran.kind === "timeout") return unanswered("timeout", `gh didn't answer within ${timeoutMs / 1000} s`);
  if (ran.kind === "failed") return unanswered("failed", ran.detail);
  const response = responseIn(ran.out);
  if (response !== null) {
    if (response.status >= 200 && response.status < 300) return { kind: "ok", response };
    if (response.status === 401) return { kind: "signed-out" };
    return { kind: "refused", response };
  }
  // No response: `gh` stopped before GitHub answered. Exit 4 is its "authentication required".
  if (ran.code === 4 || /gh auth login/.test(ran.err)) return { kind: "signed-out" };
  if (OFFLINE.test(ran.err)) return unanswered("offline", ran.err);
  return unanswered("failed", ran.err || `gh exited ${ran.code}`);
}

const account = z.object({ id: z.number().int(), login: z.string().min(1) });
/** One membership in the person's list. */
const listed = z.object({ state: z.string(), role: z.string(), organization: account });
/** The person's membership of one organisation. */
const membership = z.object({ state: z.enum(["active", "pending"]), role: z.string(), user: account });

/** An account as the port gives it: the id and the login alone. */
const accountOf = (a: z.infer<typeof account>): HostLogin => ({ id: a.id, login: a.login });

/** A body GitHub sent that isn't what the read expected. */
const unexpected = (what: string, error: z.ZodError): GhUnanswered =>
  unanswered(
    "failed",
    `GitHub's answer for ${what} isn't what Lookover expects: ${error.issues[0]?.message ?? ""}`,
  );

/** How many pages of 100 a list may take: past that, it can't answer. */
const MAX_PAGES = 10;

/** The API's address, which a next page's link starts with. */
const API = "https://api.github.com/";

/**
 * One page of the person's memberships: each active organisation with the person's role there (GitHub's `admin` an
 * owner), and the path of the next page from the `Link` header (null on the last). No answer when GitHub says it left
 * organisations out for their single sign-on (a 200 with `X-GitHub-SSO: partial-results`), sent another shape, or
 * links a next page off the API's address.
 */
function membershipsPage(
  response: Response,
): { kind: "page"; listed: GhOrganisation[]; next: string | null } | GhUnanswered {
  const sso = response.headers.get("x-github-sso");
  if (sso?.startsWith("partial-results"))
    return unanswered("sso", `GitHub left organisations out of your list for their single sign-on: ${sso}`);
  const parsed = z.array(listed).safeParse(response.body);
  if (!parsed.success) return unexpected("your organisations", parsed.error);
  const found = parsed.data
    .filter((m) => m.state === "active")
    .map(
      (m): GhOrganisation => ({
        organisation: accountOf(m.organization),
        role: m.role === "admin" ? "owner" : "member",
      }),
    );
  const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1];
  if (next !== undefined && !next.startsWith(API))
    return unanswered("failed", `GitHub's next page isn't on api.github.com: ${next}`);
  return { kind: "page", listed: found, next: next === undefined ? null : next.slice(API.length) };
}

/** Not a member of the organisation, or no such organisation. */
const ABSENT: GhMembership = { kind: "absent" };

/** Who `gh` is signed in as (`GET /user`), or why it can't say. */
async function you(api: (path: string) => Promise<Heard>): Promise<GhPerson> {
  const got = await api("user");
  if (got.kind === "refused") return refusal(got.response);
  if (got.kind !== "ok") return got;
  const parsed = account.safeParse(got.response.body);
  return parsed.success
    ? { kind: "signed-in", account: accountOf(parsed.data) }
    : unexpected("you", parsed.error);
}

/** Every page of the person's active memberships, by the `Link` GitHub gives, or why it can't list them. */
async function everyMembership(
  api: (path: string) => Promise<Heard>,
): Promise<{ kind: "listed"; organisations: GhOrganisation[] } | GhUnanswered> {
  const organisations: GhOrganisation[] = [];
  let path: string | null = "user/memberships/orgs?state=active&per_page=100";
  for (let page = 0; path !== null; page++) {
    if (page === MAX_PAGES)
      return unanswered("failed", `GitHub listed your organisations on more than ${MAX_PAGES} pages`);
    const got = await api(path);
    if (got.kind === "refused") return refusal(got.response);
    if (got.kind !== "ok") return got;
    const read = membershipsPage(got.response);
    if (read.kind !== "page") return read;
    organisations.push(...read.listed);
    path = read.next;
  }
  return { kind: "listed", organisations };
}

/** The reads, made sense of, on any way to call `gh api <path>`. */
function reads(api: (path: string) => Promise<Heard>): Gh {
  return {
    person: () => you(api),
    memberships: async () => {
      const who = await you(api);
      if (who.kind !== "signed-in") return who;
      const listed = await everyMembership(api);
      return listed.kind === "listed" ? { ...listed, person: who.account } : listed;
    },
    membership: async (organisation) => {
      if (!ORGANISATION_LOGIN.test(organisation)) return ABSENT;
      const got = await api(`user/memberships/orgs/${organisation}`);
      // Not found: not a member, or no such organisation; unless the token can't see it (SSO, a scope).
      if (got.kind === "refused")
        return untrusted(got.response) ?? (got.response.status === 404 ? ABSENT : refusal(got.response));
      if (got.kind !== "ok") return got;
      const parsed = membership.safeParse(got.response.body);
      if (!parsed.success) return unexpected(organisation, parsed.error);
      const { state, role, user } = parsed.data;
      return { kind: state, person: accountOf(user), admin: role === "admin" };
    },
  };
}

/**
 * The real `gh`, read: `command` is how `gh` is run (`[gh]`, by absolute path), null when there is none; by default
 * found on this machine at each read, so a `gh` installed while Lookover runs is found: in `env`'s PATH, then in
 * `saved` (by default, on Windows, the PATH a new terminal starts with, from the registry), then in `installers` (by
 * default the folders `gh`'s installers use). `env` is the service's environment, of which `gh` gets the allow-list.
 * Throws under `bun test` unless `command` is given, or every folder searched is the test's own (`saved`, and
 * `installers` but on Windows, whose installers' folders come from `env` and `homedir`), or it is `bun run live`'s
 * suite (`liveSuite`).
 */
export function ghCli(o: {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  homedir: string;
  command?: () => Promise<string[] | null>;
  saved?: () => Promise<string[]>;
  installers?: string[];
  timeoutMs?: number;
  liveSuite?: true;
}): Gh {
  const searchGiven = o.saved !== undefined && (o.installers !== undefined || o.platform === "win32");
  if (o.command === undefined && !searchGiven && o.liveSuite !== true && underTest())
    throw new Error(UNDER_TEST);
  const timeoutMs = o.timeoutMs ?? GH_TIMEOUT_MS;
  const env = programEnv(setVariables(o.env), { extras: GH_EXTRAS, own: GH_OWN }, { platform: o.platform });
  // The PATH a new terminal gets, on Windows: a `reg.exe` that can't read leaves the other folders to search.
  const saved =
    o.saved ??
    (async () => (o.platform === "win32" ? await savedPath(realReg(o.env), o.env).catch(() => []) : []));
  const installers = o.installers ?? knownFolders(o.env, o.platform, o.homedir);
  const command =
    o.command ??
    (async () => {
      const gh = locateGh({ env: o.env, platform: o.platform, saved: await saved(), installers });
      return gh === null ? null : [gh];
    });
  return reads(async (path) => {
    const gh = await command();
    if (gh === null) return { kind: "missing" };
    const args = ["api", "--hostname", "github.com", "--method", "GET", "--include", path];
    return heard(await run(gh, args, { env, cwd: o.homedir, timeoutMs }), timeoutMs);
  });
}

/** The person's `gh` on this machine. Throws under `bun test`. */
export function osGh(system: System): Gh {
  return ghCli({ env: system.env, platform: system.platform, homedir: system.homedir });
}
