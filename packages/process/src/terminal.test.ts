// The sign-in terminal through its entry (ADR 0047): what `openTerminal` would start on each platform, as data,
// and what it answers when the program isn't there. Nothing opens here: a console must not pop at every check,
// and CI is headless. The real window was opened by hand on Windows (the ticket's note).
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTerminal, terminalCommand } from "@lookover/process/terminal";

const CLAUDE = "C:\\Users\\Your Name\\AppData\\Local\\Programs\\claude.exe";
/** The environment the caller gives the program: it goes with the start, never the service's own. */
const ENV = { PATH: "/usr/bin", HOME: "/home/sam" };
/** A value the shell and AppleScript would both misread unquoted. */
const MAC_ENV = { PATH: "/usr/bin", CODEX_HOME: `it's "home"` };
/** The service's own environment: a token, and the desktop session only the terminal itself may get. */
const SESSION = {
  GH_TOKEN: "ghs_secret",
  DISPLAY: ":0",
  XAUTHORITY: "/home/sam/.Xauthority",
  WAYLAND_DISPLAY: "wayland-0",
  XDG_RUNTIME_DIR: "/run/user/1000",
};

test("on Windows: a new console of the program itself, by absolute path, no shell", () => {
  expect(
    terminalCommand(
      { executable: CLAUDE, args: ["auth", "login"], cwd: "C:\\Users\\Your Name", env: ENV },
      "win32",
    ),
  ).toEqual({
    kind: "console",
    executable: CLAUDE,
    commandLine: '"C:\\Users\\Your Name\\AppData\\Local\\Programs\\claude.exe" auth login',
    cwd: "C:\\Users\\Your Name",
    env: ENV,
    // CREATE_NEW_CONSOLE: the program gets a console window of its own. CREATE_UNICODE_ENVIRONMENT: the
    // environment it is given is in UTF-16.
    creationFlags: 0x00000410,
  });
});

test("on Windows: an argument is quoted as the C runtime reads it back", () => {
  const command = terminalCommand(
    {
      executable: "C:\\p\\a.exe",
      args: ['say "hi"', "C:\\dir with space\\", "", "plain"],
      cwd: "C:\\p",
      env: ENV,
    },
    "win32",
  );
  expect(command.kind === "console" && command.commandLine).toBe(
    'C:\\p\\a.exe "say \\"hi\\"" "C:\\dir with space\\\\" "" plain',
  );
});

test("on macOS: Terminal runs the program under its env and nothing else, each word quoted for its shell", () => {
  expect(
    terminalCommand(
      {
        executable: "/Users/sam/.local/bin/claude",
        args: ["auth", "login"],
        cwd: "/Users/sam/it's here",
        env: MAC_ENV,
      },
      "darwin",
      SESSION,
    ),
  ).toEqual({
    kind: "program",
    executable: "/usr/bin/osascript",
    args: [
      "-e",
      // The shell line: `cd '/Users/sam/it'\''s here' && /usr/bin/env -i TERM="$TERM" 'CODEX_HOME=it'\''s
      // "home"' 'PATH=/usr/bin' '/Users/sam/.local/bin/claude' 'auth' 'login'`, its backslashes and double
      // quotes escaped for AppleScript.
      `tell application "Terminal" to do script "cd '/Users/sam/it'\\\\''s here' && /usr/bin/env -i TERM=\\"$TERM\\" 'CODEX_HOME=it'\\\\''s \\"home\\"' 'PATH=/usr/bin' '/Users/sam/.local/bin/claude' 'auth' 'login'"`,
      "-e",
      'tell application "Terminal" to activate',
    ],
    cwd: "/Users/sam/it's here",
    env: MAC_ENV,
  });
});

test("on Linux: the terminal also gets the desktop session; the program its env and the terminal's TERM", () => {
  expect(
    terminalCommand(
      { executable: "/home/sam/.local/bin/codex", args: ["login"], cwd: "/home/sam/it's here", env: ENV },
      "linux",
      SESSION,
    ),
  ).toEqual({
    kind: "program",
    executable: "/usr/bin/x-terminal-emulator",
    args: [
      "-e",
      "/bin/sh",
      "-c",
      'exec /usr/bin/env -i TERM="$TERM" "$@"',
      "sh",
      "DISPLAY=:0",
      "HOME=/home/sam",
      "PATH=/usr/bin",
      "WAYLAND_DISPLAY=wayland-0",
      "XAUTHORITY=/home/sam/.Xauthority",
      "XDG_RUNTIME_DIR=/run/user/1000",
      "/home/sam/.local/bin/codex",
      "login",
    ],
    cwd: "/home/sam/it's here",
    env: {
      ...ENV,
      DISPLAY: ":0",
      XAUTHORITY: "/home/sam/.Xauthority",
      WAYLAND_DISPLAY: "wayland-0",
      XDG_RUNTIME_DIR: "/run/user/1000",
    },
  });
});

test("on Linux: a session variable the service lacks is not given", () => {
  const command = terminalCommand(
    { executable: "/usr/bin/codex", args: [], cwd: "/home/sam", env: ENV },
    "linux",
    { GH_TOKEN: "ghs_secret", DISPLAY: ":1" },
  );
  expect(command.kind === "program" && command.env).toEqual({ ...ENV, DISPLAY: ":1" });
});

test("the engine's own value wins over the session's", () => {
  const command = terminalCommand(
    {
      executable: "/usr/bin/codex",
      args: [],
      cwd: "/home/sam",
      env: { ...ENV, XDG_RUNTIME_DIR: "/run/own" },
    },
    "linux",
    SESSION,
  );
  expect(command.kind === "program" && command.env).toMatchObject({ XDG_RUNTIME_DIR: "/run/own" });
});

test("any other POSIX platform is given Linux's terminal", () => {
  const command = terminalCommand(
    { executable: "/usr/local/bin/codex", args: ["login"], cwd: "/home/sam", env: ENV },
    "freebsd",
  );
  expect(command.kind === "program" && command.executable).toBe("/usr/bin/x-terminal-emulator");
});

// A sign-in terminal starts the vendor's login, which never needs a token it already has; off Windows a
// process's arguments are seen by any user's `ps`, and Terminal's window keeps its line. An authenticating
// proxy is needed, though: without it the login can't reach its service.
const OAUTH = "sk-ant-oat01-synthetic-secret";
const PROXY_PASSWORD = "proxy-synthetic-secret";
const PROXY = `http://sam:${PROXY_PASSWORD}@proxy.local:3128`;
/** The engine's env with a token and proxies carrying a user and password, and a proxy that carries none. */
const SECRET_ENV = {
  PATH: "/usr/bin",
  CLAUDE_CODE_OAUTH_TOKEN: OAUTH,
  HTTPS_PROXY: PROXY,
  http_proxy: PROXY,
  NO_PROXY: "localhost",
  HTTP_PROXY: "http://proxy.local:3128",
};
/** Where `openTerminal` would write what must not go in arguments: a file in a folder only the user reads. */
const PRIVATE_FILE = "/tmp/lookover-signin-x/env";
const LOGIN = {
  executable: "/usr/local/bin/claude",
  args: ["auth", "login"],
  cwd: "/home/sam",
  env: SECRET_ENV,
};

for (const platform of ["win32", "darwin", "linux"] as const) {
  test(`on ${platform}: no token reaches the terminal, and no proxy password its arguments`, () => {
    const command = terminalCommand(LOGIN, platform, SESSION, PRIVATE_FILE);
    const seen = JSON.stringify(command);
    expect(seen).not.toContain(OAUTH);
    expect(seen).not.toContain("ghs_secret");
    const args = command.kind === "console" ? command.commandLine : JSON.stringify(command.args);
    expect(args).not.toContain(PROXY_PASSWORD);
    expect(command.env).toMatchObject({
      PATH: "/usr/bin",
      NO_PROXY: "localhost",
      HTTP_PROXY: "http://proxy.local:3128",
    });
  });
}

test("on Windows: the authenticating proxy goes in the environment block, private to the program", () => {
  const command = terminalCommand(LOGIN, "win32", SESSION, PRIVATE_FILE);
  expect(command.env).toMatchObject({ HTTPS_PROXY: PROXY, http_proxy: PROXY });
  expect(JSON.stringify(command)).not.toContain(PRIVATE_FILE);
});

for (const platform of ["darwin", "linux"] as const) {
  test(`on ${platform}: the authenticating proxy goes through a private file, its path alone in the arguments`, () => {
    const command = terminalCommand(LOGIN, platform, SESSION, PRIVATE_FILE);
    if (command.kind !== "program") throw new Error("expected a program");
    expect(command.env).not.toHaveProperty("HTTPS_PROXY");
    expect(command.env).not.toHaveProperty("http_proxy");
    expect(command.privateEnv).toEqual({
      path: PRIVATE_FILE,
      text: `export HTTPS_PROXY='${PROXY}'\nexport http_proxy='${PROXY}'\n`,
    });
    expect(JSON.stringify(command.args)).toContain(PRIVATE_FILE);
  });
}

test("off Windows, with nothing private, there is no file", () => {
  const command = terminalCommand(
    { executable: "/usr/bin/codex", args: [], cwd: "/home/sam", env: ENV },
    "linux",
    {},
    PRIVATE_FILE,
  );
  expect(command.kind === "program" && command.privateEnv).toBeUndefined();
  expect(JSON.stringify(command)).not.toContain(PRIVATE_FILE);
});

// The fixed shell line run for real by `sh`, `/usr/bin/env` standing for the login: the proxy reaches the
// program, the file and its folder are gone before it runs. On Windows, Git's `sh` when there is one.
const sh = Bun.which("sh");
test.if(sh !== null)(
  "off Windows: the login's shell reads the private file, removes it, then runs the login",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "lookover-signin-test-"));
    try {
      const file = join(dir, "env").replaceAll("\\", "/");
      const command = terminalCommand(
        { executable: "/usr/bin/env", args: [], cwd: dir, env: SECRET_ENV },
        "linux",
        {},
        file,
      );
      if (command.kind !== "program" || command.privateEnv === undefined) {
        throw new Error("expected a private file");
      }
      writeFileSync(command.privateEnv.path, command.privateEnv.text, { mode: 0o600 });
      // `-e /bin/sh` is the terminal's part; what follows is the shell's own arguments.
      const run = Bun.spawnSync([sh ?? "sh", ...command.args.slice(2)], { env: {} });
      const printed = run.stdout.toString();
      expect(printed).toContain(`HTTPS_PROXY=${PROXY}`);
      expect(printed).toContain(`http_proxy=${PROXY}`);
      expect(printed).toContain("NO_PROXY=localhost");
      expect(printed).not.toContain(OAUTH);
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// Linux's start tried on Windows, where its terminal can't be there: the private file was written and, the start
// failed, is gone with its folder. Never on Linux itself, where a terminal could open.
test.if(process.platform === "win32")("a private file whose terminal never started is removed", async () => {
  const signIns = () => readdirSync(tmpdir()).filter((name) => name.startsWith("lookover-signin-"));
  const before = signIns();
  const opened = await openTerminal(LOGIN, {}, "linux");
  expect(opened.opened).toBe(false);
  expect(signIns()).toEqual(before);
});

// The one start tried in a check, on this platform only: a program that isn't there starts nothing, and the
// answer says so instead of throwing. On Windows that is the FFI call itself (its structures, its strings).
test.if(process.platform === "win32")(
  "on this Windows machine: a missing program is reported, nothing opened",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "lookover-terminal-"));
    try {
      const opened = await openTerminal({
        executable: join(dir, "no-such-program.exe"),
        args: ["login"],
        cwd: dir,
        env: ENV,
      });
      // ERROR_FILE_NOT_FOUND: the folder is there, the program isn't.
      expect(opened).toEqual({ opened: false, reason: "CreateProcessW failed (error 2)", error: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
