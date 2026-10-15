// `bun scripts/release-smoke.ts`: the release's npm packages, installed and run as a user would (ADR 0061). Real npm
// installs the main tarball and this machine's platform tarball from `dist/npm/` (`release-assets.ts`) into a scratch
// prefix, offline (npm reads nothing but the two tarballs, and none of the user's npm settings), then the installed
// `lookover` runs on a scratch data folder in a scratch profile, never the user's (`LOOKOVER_HOME` and `--home=` both
// name it, and the profile's folders are empty ones): `--version` (the root package.json's), `help`, `start --no-open`,
// `status` (exit 0), `stop` and `status` (exit 3). Exit 0 when each passed, 1 at the first that didn't, 2 on a command
// line it doesn't take.
//
//   bun scripts/release-smoke.ts [--from-registry <version> [--wait]]
//
// `--from-registry <version>`: the same, on `lookover@<version>` installed from npm's public registry instead, with
// no install script run and none of the user's npm settings read (the public release.yml's `verify` job, once the
// packages are published). `--wait` first waits, up to ten minutes, until the registry answers for `lookover` and each
// platform package at that version, and for each one's tarball (a package just published may take a moment to show).
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { releasePlatforms } from "./release-assets.ts";
import { PLAIN_VERSION } from "./release-version.ts";

/** npm's command for a global install under `prefix`: `<prefix>\lookover.cmd` on Windows, `<prefix>/bin/lookover` elsewhere. */
export function shimOf(prefix: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? join(prefix, "lookover.cmd") : join(prefix, "bin", "lookover");
}

/** What a run of the installed `lookover` printed, and how it ended: its exit code, else the signal that ended it. */
export type Ran = { code: number | null; signal: string | null; out: string; err: string };

/**
 * Runs npm's `shim` with `args` as a terminal would: through cmd.exe on Windows (a `.cmd` runs nowhere else, and Bun
 * can't quote one whose path has a space), at once elsewhere. What it printed, and its exit code, or the signal it
 * ended by (its code then null).
 */
export function runShim(
  shim: string,
  args: string[],
  o: { cwd: string; env: Record<string, string | undefined> },
): Ran {
  const env = Object.fromEntries(
    Object.entries(o.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  if (process.platform !== "win32") {
    const ran = Bun.spawnSync([shim, ...args], { cwd: o.cwd, env, stdout: "pipe", stderr: "pipe" });
    return {
      code: ran.exitCode,
      signal: ran.signalCode ?? null,
      out: ran.stdout.toString(),
      err: ran.stderr.toString(),
    };
  }
  const unsafe = [shim, ...args].find((word) => /["%^&|<>!\r\n]/.test(word));
  if (unsafe !== undefined)
    throw new Error(`cmd.exe would read ${JSON.stringify(unsafe)} as its own: pass plain words`);
  const line = [shim, ...args].map((word) => `"${word}"`).join(" ");
  const ran = spawnSync(line, { cwd: o.cwd, env, shell: true, encoding: "utf8", windowsHide: true });
  return { code: ran.status, signal: ran.signal, out: ran.stdout, err: ran.stderr };
}

/** npm's public registry, where a release's packages go. */
const REGISTRY = "https://registry.npmjs.org/";

const USAGE = "usage: bun scripts/release-smoke.ts [--from-registry <version> [--wait]]";

/** What the smoke installs: the tarballs in `dist/npm/`, or a version from the registry, waiting for it or not. */
type Plan = { from: "tarballs" } | { from: "registry"; version: string; wait: boolean };

/** What a command line asks for, or why it can't be run. */
export function plan(args: string[]): Plan | string {
  let parsed: ReturnType<typeof parseCommand>;
  try {
    parsed = parseCommand(args);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const { values, positionals } = parsed;
  const [word] = positionals;
  if (word !== undefined) return `no argument ${word}: ${USAGE}`;
  const version = values["from-registry"];
  if (version === undefined)
    return values.wait
      ? "--wait waits for the registry: pass --from-registry <version> too"
      : { from: "tarballs" };
  // A release's version; it also keeps cmd.exe, which runs npm on Windows, from reading it as its own.
  if (!PLAIN_VERSION.test(version)) return `--from-registry takes a version such as 1.2.3, not ${version}`;
  return { from: "registry", version, wait: values.wait };
}

const parseCommand = (args: string[]) =>
  parseArgs({
    args,
    allowPositionals: true,
    options: {
      "from-registry": { type: "string" },
      wait: { type: "boolean", default: false },
    },
  });

/** What npm installs: the tarballs given, offline, or `lookover` at a version from the registry. */
type Source = { tarballs: string[] } | { version: string };

/**
 * npm's arguments for a global install of `source` under `prefix`, its cache, user and global settings in `settings`
 * (empty files and a folder, so it reads none of the user's), no install script run. Tarballs install offline, the
 * registry a closed local port, so npm reads nothing else: an optional dependency it can't find (another platform's
 * package) is skipped, as npm skips one that doesn't fit.
 */
export function npmInstallArgs(o: { prefix: string; settings: string } & Source): string[] {
  const shared = [
    "install",
    "--global",
    `--prefix=${o.prefix}`,
    `--cache=${join(o.settings, "cache")}`,
    `--userconfig=${join(o.settings, "userconfig")}`,
    `--globalconfig=${join(o.settings, "globalconfig")}`,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--update-notifier=false",
    "--loglevel=error",
  ];
  return "tarballs" in o
    ? [...shared, "--offline", "--registry=http://127.0.0.1:9/", ...o.tarballs]
    : [...shared, `--registry=${REGISTRY}`, `lookover@${o.version}`];
}

/** Installs `source` with real npm as a global install under `prefix`, its settings in `scratch` (`npmInstallArgs`). */
export async function installGlobal(o: { prefix: string; scratch: string } & Source): Promise<void> {
  const settings = join(o.scratch, "npm-settings");
  mkdirSync(settings, { recursive: true });
  writeFileSync(join(settings, "userconfig"), "");
  writeFileSync(join(settings, "globalconfig"), "");
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) if (/^npm_config_/i.test(key)) delete env[key];
  const source: Source = "tarballs" in o ? { tarballs: o.tarballs } : { version: o.version };
  const installed = Bun.spawn(["npm", ...npmInstallArgs({ prefix: o.prefix, settings, ...source })], {
    cwd: o.scratch,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, said, failed] = await Promise.all([
    installed.exited,
    new Response(installed.stdout).text(),
    new Response(installed.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`npm install exited ${code}:\n${said}${failed}`);
}

/**
 * The registry's address of `lookover` at `version`, then each platform package's (the scope's slash escaped), then
 * each one's tarball: a version can answer while its tarball still says 404, and npm then skips the optional package.
 */
export function registryUrls(version: string, platforms: string[]): string[] {
  return [
    `${REGISTRY}lookover/${version}`,
    ...platforms.map((platform) => `${REGISTRY}@lookover%2f${platform}/${version}`),
    `${REGISTRY}lookover/-/lookover-${version}.tgz`,
    ...platforms.map((platform) => `${REGISTRY}@lookover/${platform}/-/${platform}-${version}.tgz`),
  ];
}

/**
 * Asks each of `urls` until it answers 200, every `everyMs`, for at most `timeoutMs`; a network error is a "not yet".
 * The addresses that never did, empty when all did.
 */
export async function waitForRegistry(
  urls: string[],
  o: {
    status: (url: string) => Promise<number>;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    timeoutMs: number;
    everyMs: number;
  },
): Promise<string[]> {
  const deadline = o.now() + o.timeoutMs;
  let missing = urls;
  for (;;) {
    const answers = await Promise.all(missing.map((url) => o.status(url).catch(() => 0)));
    missing = missing.filter((_, i) => answers[i] !== 200);
    if (missing.length === 0 || o.now() >= deadline) return missing;
    await o.sleep(Math.min(o.everyMs, deadline - o.now()));
  }
}

/** One step of the smoke: the installed `lookover`'s arguments, and what passing means for what it printed. */
type Step = { args: string[]; passes: (ran: Ran) => string | null };

/** The steps on the data folder `home`, for `version`: each says why it failed, or null. */
export function steps(home: string, version: string): Step[] {
  const exit0 = (ran: Ran) =>
    ran.code === 0 ? null : ran.code === null ? `ended by ${ran.signal}` : `exited ${ran.code}`;
  const exit3 = (ran: Ran) =>
    ran.code === 3
      ? null
      : ran.code === null
        ? `ended by ${ran.signal}`
        : `exited ${ran.code}, not 3 (stopped)`;
  return [
    {
      args: ["--version"],
      passes: (ran) =>
        exit0(ran) ?? (ran.out.trim() === version ? null : `said ${ran.out.trim()}, not ${version}`),
    },
    {
      args: ["help"],
      passes: (ran) => exit0(ran) ?? (ran.out.includes("lookover") ? null : "named no lookover"),
    },
    { args: ["start", "--no-open", `--home=${home}`], passes: exit0 },
    { args: ["status", `--home=${home}`], passes: exit0 },
    { args: ["stop", `--home=${home}`], passes: exit0 },
    { args: ["status", `--home=${home}`], passes: exit3 },
  ];
}

/** The last lines of each log in the data folder `home`, since the folder goes with the smoke's scratch folder. */
function logTail(home: string): string {
  const logs = join(home, "logs");
  if (!existsSync(logs)) return "";
  return readdirSync(logs)
    .map(
      (file) => `--- ${file}\n${readFileSync(join(logs, file), "utf8").split("\n").slice(-30).join("\n")}\n`,
    )
    .join("");
}

/**
 * Removes the folder `dir`, retrying while Windows still holds the stopped executable; whether it went. A folder left
 * behind, in the temporary folder, doesn't fail the smoke: the caller says where it is.
 */
function removed(dir: string): boolean {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    return true;
  } catch {
    return false;
  }
}

if (import.meta.main) {
  const asked = plan(process.argv.slice(2));
  if (typeof asked === "string") {
    console.error(asked);
    process.exit(2);
  }
  const root = resolve(import.meta.dir, "..");
  let version: string;
  let source: Source;
  let what: string;
  if (asked.from === "registry") {
    version = asked.version;
    source = { version };
    what = `lookover@${version} from ${REGISTRY}`;
    if (asked.wait) {
      const urls = registryUrls(version, releasePlatforms());
      console.log(`Waiting for ${REGISTRY} to answer for lookover ${version} and its platform packages.`);
      const missing = await waitForRegistry(urls, {
        // HEAD: a tarball's answer without its download.
        status: async (url) => (await fetch(url, { method: "HEAD" })).status,
        sleep: (ms) => Bun.sleep(ms),
        now: () => Date.now(),
        timeoutMs: 10 * 60_000,
        everyMs: 15_000,
      });
      if (missing.length > 0) {
        console.error(`Not on the registry after ten minutes: ${missing.join(", ")}.`);
        process.exit(1);
      }
    }
  } else {
    const out = join(root, "dist", "npm");
    version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
    const host = `${process.platform}-${process.arch}`;
    const tarballs = [`lookover-${version}.tgz`, `lookover-${host}-${version}.tgz`].map((file) =>
      join(out, file),
    );
    const missing = tarballs.filter((file) => !existsSync(file));
    if (missing.length > 0) {
      console.error(`No ${missing.join(", ")}: pack them first, bun scripts/release-assets.ts --host.`);
      process.exit(1);
    }
    source = { tarballs };
    what = tarballs.map((file) => relative(root, file)).join(" and ");
  }

  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "lookover-release-smoke-")));
  const prefix = join(scratch, "prefix");
  const home = join(scratch, "home");
  const profile = join(scratch, "profile");
  mkdirSync(profile);
  const env: Record<string, string | undefined> = {
    ...process.env,
    LOOKOVER_HOME: home,
    // An empty profile too, every folder of it Lookover may read: the default data folder, the settings and what it
    // keeps beside the data folder (the machine's live lock in `~/.lookover`) are the smoke's, so a live service
    // running on this machine neither stops it nor sees it, and a verb that forgot `--home=` still finds no user's.
    HOME: profile,
    USERPROFILE: profile,
    LOCALAPPDATA: join(profile, "AppData", "Local"),
    APPDATA: join(profile, "AppData", "Roaming"),
    XDG_CONFIG_HOME: join(profile, ".config"),
    XDG_DATA_HOME: join(profile, ".local", "share"),
    XDG_STATE_HOME: join(profile, ".local", "state"),
    LOOKOVER_LAUNCHER: undefined,
    LOOKOVER_LIVE_CONFIG: undefined,
    LOOKOVER_UNDER_TEST: undefined,
  };
  let failed = false;
  let started = false;
  try {
    await installGlobal({ prefix, scratch, ...source });
    console.log(`Installed ${what} with npm.`);
    for (const step of steps(home, version)) {
      const ran = runShim(shimOf(prefix, process.platform), step.args, { cwd: scratch, env });
      started ||= step.args[0] === "start" && ran.code === 0;
      const why = step.passes(ran);
      console.log(
        `${why === null ? "ok  " : "FAIL"} lookover ${step.args.join(" ")}${why === null ? "" : `: ${why}`}`,
      );
      if (why !== null) {
        console.log(`${ran.out}${ran.err}${logTail(home)}`);
        failed = true;
        break;
      }
      if (step.args[0] === "stop") started = false;
    }
  } finally {
    if (started) runShim(shimOf(prefix, process.platform), ["stop", `--home=${home}`], { cwd: scratch, env });
    if (!removed(scratch)) console.log(`Left the smoke's scratch folder ${scratch}: it couldn't be removed.`);
  }
  process.exit(failed ? 1 : 0);
}
