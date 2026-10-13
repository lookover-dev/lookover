#!/usr/bin/env node
// @ts-check
// `lookover`, as `npm install -g lookover` installs it (ADR 0061): a launcher in plain Node, with no dependency and no
// build. npm installed, beside it, the one platform package (`@lookover/<platform>-<arch>`) whose `os` and `cpu` match
// this machine; this runs that package's executable with the same arguments and the same terminal, tells it who started
// it (`LOOKOVER_LAUNCHER`, this file's absolute path: the executable is then an npm install, and names `lookover`),
// passes SIGTERM on, and ends as it ends. It never downloads anything: when no package fits, it says which
// exist and how to reinstall.
"use strict";

const { spawn } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const { constants } = require("node:os");
const { dirname, join } = require("node:path");

const platform = `${process.platform}-${process.arch}`;
const executable = process.platform === "win32" ? "lookover.exe" : "lookover";

/** The executable of this machine's platform package, or null when npm installed none. */
function installed() {
  try {
    const manifest = require.resolve(`@lookover/${platform}/package.json`);
    const file = join(dirname(manifest), executable);
    return existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

/** The platforms Lookover is built for, from this package's own `optionalDependencies`. */
function platforms() {
  const manifest = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
  const wanted = manifest.optionalDependencies || {};
  return Object.keys(wanted).map((name) => name.replace(/^@lookover\//, ""));
}

const file = installed();
if (file === null) {
  console.error(
    `Lookover found no executable for ${platform}. It is built for ${platforms().join(", ")}.\n` +
      "If yours is one of them, npm skipped it: reinstall with\n  npm install -g lookover --include=optional",
  );
  process.exit(1);
}

const child = spawn(file, process.argv.slice(2), {
  stdio: "inherit",
  env: { ...process.env, LOOKOVER_LAUNCHER: __filename },
});

// Ctrl+C already reaches the executable: the terminal sends it to the whole process group on Unix, and the console to
// every process attached on Windows. Passing it on would send it twice, so the launcher only waits for it to end.
process.on("SIGINT", () => {});
// A SIGTERM, though, names this process alone (`kill <pid>`): pass it on. Not on Windows, where Node never receives
// one and a kill would end the executable at once, unstopped.
if (process.platform !== "win32") process.on("SIGTERM", () => child.kill("SIGTERM"));

child.on("error", (error) => {
  console.error(`Lookover couldn't start ${file}: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal === null) process.exit(code ?? 1);
  // Ended by a signal: end by the same one, so whoever started `lookover` sees it. Node ignores some (SIGPIPE), and
  // then the launcher still ends, with the code a shell gives a process ended by that signal.
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
  process.exit(128 + (constants.signals[signal] ?? 0));
});
