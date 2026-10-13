// `lookover`, the program (ADR 0054, "One `lookover` command"): `lookover` with this process's arguments on this
// machine. `serve` runs the service (`runService`, ADR 0039) on the real clock, the terminal and this process, and the
// process runs on until a signal stops it; `start` runs this same program's `serve` in the background, out of the
// terminal (`@lookover/process/background`), and opens the browser on its link; the agent's verbs run `agent-cli` on
// the checkout it is started in, with the agent's own token. From a clone: `bun run lookover <verb>`, this file run
// by Bun; the compiled binary (`bun run build`) runs `main` from its generated entry, with the web app it carries.
import { join } from "node:path";
import { realWorld, run } from "@lookover/agent-cli";
import { openInBrowser, startInBackground } from "@lookover/process/background";
import { lookover } from "./command.ts";
import { osCommandPath } from "./command-path.ts";
import { realSystem, setVariables } from "./config.ts";
import { osLoginItem } from "./login-item.ts";
import { runService } from "./run-service.ts";
import { type Self, serveCommand, webBuildOf } from "./self.ts";

/** Whether the process `pid` still runs: signal 0 only asks. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it runs, as another user.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/** Runs `lookover` with this process's arguments as `self`, and exits with its code unless it serves. */
export async function main(self: Self): Promise<void> {
  const print = { out: (line: string) => console.log(line), err: (line: string) => console.error(line) };
  const system = realSystem();
  const env = setVariables(system.env);
  const code = await lookover(process.argv.slice(2), {
    print,
    system,
    self,
    agent: (argv) => run(argv, realWorld(process.cwd(), { ...env })),
    serve: (config, printer) =>
      runService(config, {
        clock: { now: () => Date.now() },
        print: printer,
        process,
        ...(self.kind === "clone" ? {} : { webFiles: self.webFiles }),
      }),
    background: {
      // This program's `serve`, by absolute paths, from the user's home: never the folder the terminal is in, which
      // the service would keep from being removed.
      // Without Bun's `BUN_FEATURE_FLAG_NO_ORPHANS`, which ends a Bun process once its parent is gone (an agent's
      // shell sets it): the service must outlive the start.
      startServe: async (args) => {
        const { BUN_FEATURE_FLAG_NO_ORPHANS: _ended, ...outliving } = env;
        const started = await startInBackground({
          ...serveCommand(self, args),
          cwd: system.homedir,
          env: outliving,
        });
        return started.started ? { ...started, running: () => running(started.pid) } : started;
      },
      openBrowser: (url) => openInBrowser(url),
      // SIGKILL: SIGTERM is the graceful stop it already didn't make (Windows ends the process either way).
      kill: (pid) => process.kill(pid, "SIGKILL"),
      webBuild: () => webBuildOf(self),
      // `status` only asks it; the service registers start at login itself (ADR 0054).
      loginItem: (command) => osLoginItem(command, system),
      // Only read, for Lookover's command; the service adds and removes it (ADR 0058).
      commandPath: (executable) => osCommandPath(executable, system),
      time: { now: () => Date.now(), sleep: (ms) => Bun.sleep(ms) },
    },
  });
  if (code !== null) process.exit(code);
}

if (import.meta.main)
  await main({ kind: "clone", bun: process.execPath, main: join(import.meta.dir, "main.ts") });
