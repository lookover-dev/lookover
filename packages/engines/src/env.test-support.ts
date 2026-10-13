// What the Claude and Codex tests share about the engines' environment (ADR 0048): an owner's shell, and how to
// read the names a fake received.

/**
 * An owner's shell: what the engines need (the system's, the network's, each engine's sign-in) beside what they
 * must never get (GitHub tokens, API keys, gateways, Lookover's own, a Node preload).
 */
export const SHELL: Record<string, string> = {
  PATH: "/usr/bin",
  HOME: "/home/me",
  TMPDIR: "/tmp",
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
  LANG: "en_GB.UTF-8",
  LC_ALL: "en_GB.UTF-8",
  TZ: "Europe/Paris",
  HTTPS_PROXY: "http://proxy:3128",
  SSL_CERT_FILE: "/etc/ssl/cert.pem",
  CLAUDE_CONFIG_DIR: "/home/me/.claude",
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test",
  CLAUDE_CODE_GIT_BASH_PATH: "/usr/bin/bash",
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: "0",
  CODEX_HOME: "/home/me/.codex",
  CODEX_CA_CERTIFICATE: "/home/me/ca.pem",
  CODEX_API_KEY: "sk-test",
  CODEX_THREAD_ID: "t",
  GH_TOKEN: "ghp_test",
  GITHUB_TOKEN: "ghs_test",
  ANTHROPIC_API_KEY: "sk-ant-test",
  ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
  CLAUDE_CODE_USE_BEDROCK: "1",
  OPENAI_API_KEY: "sk-test",
  OPENAI_BASE_URL: "http://127.0.0.1:1",
  LOOKOVER_HOME: "/home/me/.lookover",
  AWS_SECRET_ACCESS_KEY: "aws",
  NODE_OPTIONS: "--require /tmp/evil.js",
};

/**
 * An owner's shell on Windows, each name in the case Windows gives it (or a user typed it): the profile folders
 * the sign-ins live under, the system's own, a lower-case proxy, each engine's sign-in, and what must never pass.
 */
export const WINDOWS_SHELL: Record<string, string> = {
  Path: "C:\\Windows\\System32;C:\\Users\\Your Name\\.local\\bin",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  USERPROFILE: "C:\\Users\\Your Name",
  HOMEDRIVE: "C:",
  HOMEPATH: "\\Users\\Your Name",
  APPDATA: "C:\\Users\\Your Name\\AppData\\Roaming",
  LOCALAPPDATA: "C:\\Users\\Your Name\\AppData\\Local",
  TEMP: "C:\\Users\\Your Name\\AppData\\Local\\Temp",
  TMP: "C:\\Users\\Your Name\\AppData\\Local\\Temp",
  USERNAME: "me",
  SystemRoot: "C:\\Windows",
  SystemDrive: "C:",
  windir: "C:\\Windows",
  ComSpec: "C:\\Windows\\system32\\cmd.exe",
  ProgramData: "C:\\ProgramData",
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  https_proxy: "http://proxy:3128",
  Claude_Config_Dir: "C:\\Users\\Your Name\\.claude",
  CLAUDE_CODE_GIT_BASH_PATH: "C:\\Program Files\\Git\\bin\\bash.exe",
  Codex_Home: "C:\\Users\\Your Name\\.codex",
  COMPUTERNAME: "DESKTOP",
  PSModulePath: "C:\\Program Files\\WindowsPowerShell\\Modules",
  Gh_Token: "ghp_test",
  GitHub_Token: "ghs_test",
  Anthropic_Api_Key: "sk-ant-test",
  OpenAI_Api_Key: "sk-test",
  Lookover_Home: "C:\\Users\\Your Name\\.lookover",
  NODE_OPTIONS: "--require C:\\evil.js",
};

/** What must never reach either engine, whatever the shell holds (the ticket's list, #136). */
export const NEVER = ["GH_TOKEN", "GITHUB_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "LOOKOVER_HOME"];

/**
 * The variables Windows' spawner (libuv's) copies from the test's own environment into every child when the
 * environment it is given lacks them, in any case: not the engine's doing, so left out of an exact comparison.
 */
const SPAWNER_ADDS = new Set([
  "HOMEDRIVE",
  "HOMEPATH",
  "LOGONSERVER",
  "PATH",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
]);

/** The names a fake received, without those this machine's spawner added (none but on Windows). */
export function passed(received: string[], given: Record<string, string>): string[] {
  if (process.platform !== "win32") return received;
  const named = new Set(Object.keys(given));
  return received.filter((name) => named.has(name) || !SPAWNER_ADDS.has(name));
}
