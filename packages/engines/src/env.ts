// The environment each engine's program gets: an allow-list, not a deny-list (ADR 0048). See `index.ts`.
import type { EngineId } from "@lookover/contracts";
import type { Host } from "./locate.ts";

/**
 * What every engine may get from the service's environment: the system's own variables (path, home, profile and
 * temp folders, the user, locale, time zone, Windows' system folders) and the network's (proxies, certificate
 * files). Each name stands for itself; on Windows its case doesn't matter.
 */
const BASE = [
  // Path and programs.
  "PATH",
  "PATHEXT",
  "SHELL",
  // Home, profile and temp folders.
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "TMPDIR",
  "TEMP",
  "TMP",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  // The session bus on Linux: the keyring (Secret Service) is reached through it, and Codex's keyring credential
  // store keeps its sign-in there; without it a Codex signed in that way reads as signed out.
  "DBUS_SESSION_BUS_ADDRESS",
  // The user.
  "USER",
  "LOGNAME",
  "USERNAME",
  "USERDOMAIN",
  // Locale and time zone (`LC_*` below).
  "LANG",
  "LANGUAGE",
  "TZ",
  // Windows' system folders and facts.
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "OS",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "CommonProgramW6432",
  "ALLUSERSPROFILE",
  "PUBLIC",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  // The network: proxies (both cases are read elsewhere than Windows) and certificate files.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
];

/** The locale's categories: `LC_ALL`, `LC_CTYPE` and the others. */
const LOCALE = /^LC_[A-Z]+$/;

/** What each engine adds to the base: where its sign-in lives, and what it needs to run on this machine. */
const EXTRAS = {
  // The config folder (the sign-in), the owner's own sign-in token (ADR 0002), and Git Bash on Windows.
  claude: ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_GIT_BASH_PATH"],
  // Codex's home (the sign-in) and its certificates (ADR 0044).
  codex: ["CODEX_HOME", "CODEX_CA_CERTIFICATE"],
} as const satisfies Record<EngineId, readonly string[]>;

/**
 * Lookover's own, set whatever the service's environment says: Claude loads no `CLAUDE.md` and no auto memory
 * (ADR 0048), and on Windows no program is looked for in the working folder, a pull request's (exploration 09,
 * SR-04).
 */
const OWN = {
  claude: {
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    NoDefaultCurrentDirectoryInExePath: "1",
  },
  codex: { NoDefaultCurrentDirectoryInExePath: "1" },
} as const satisfies Record<EngineId, Record<string, string>>;

/**
 * The environment `engine`'s program gets from `env`: the variables on its list, each with the shell's value and
 * name as given (matched without case on Windows), then Lookover's own over them.
 */
export function allowedEnv(
  engine: EngineId,
  env: Record<string, string>,
  host: Host,
): Record<string, string> {
  return programEnv(env, { extras: EXTRAS[engine], own: OWN[engine] }, host);
}

/**
 * The environment another program Lookover runs gets from `env` (the service's `gh`, ADR 0059): the engines' base,
 * then the program's `extras`, each with the shell's value and name as given (matched without case on Windows), then
 * `own` over them, whatever the shell said.
 */
export function programEnv(
  env: Record<string, string>,
  program: { extras: readonly string[]; own: Readonly<Record<string, string>> },
  host: Pick<Host, "platform">,
): Record<string, string> {
  const fold = (name: string) => (host.platform === "win32" ? name.toUpperCase() : name);
  const listed = new Set([...BASE, ...program.extras].map(fold));
  const own = program.own;
  const ownNames = new Set(Object.keys(own).map(fold));
  const kept = Object.entries(env).filter(([name]) => {
    const folded = fold(name);
    return !ownNames.has(folded) && (listed.has(folded) || LOCALE.test(folded));
  });
  return { ...Object.fromEntries(kept), ...own };
}

/**
 * The home folder in a program's environment (`USERPROFILE` on Windows, its name matched without case; `HOME`
 * elsewhere); null when it has none. What a path outside the worktree shows as `~` (ADR 0055).
 */
export function homeOf(env: Record<string, string>, host: Host): string | null {
  const name = host.platform === "win32" ? "USERPROFILE" : "HOME";
  const found = Object.entries(env).find(([key]) =>
    host.platform === "win32" ? key.toUpperCase() === name : key === name,
  );
  return found?.[1] || null;
}
