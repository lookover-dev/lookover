// What `lookover` runs as (ADR 0054): Bun on a clone's `main.ts` (`bun run lookover`), or the compiled binary
// `bun run build` makes, which carries the program's web app and its own entry (its source files are inside it,
// under a path no other process can read), downloaded or installed by npm, whose launcher runs it with
// `LOOKOVER_LAUNCHER` set (`programSelf`, ADR 0061). `start` runs this same program's `serve` in the background, and needs
// the program's web build first only from a clone. The command lines it makes (`selfCommand`, and Lookover's command,
// `lookoverCommand`) are `config.ts`'s, which reads them into the configuration.
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { WebBuild } from "./background.ts";
import { selfCommand } from "./config.ts";
import { cloneWebBuild } from "./run-service.ts";
import type { WebFiles } from "./web-files.ts";

export type Self =
  /** Bun, by its absolute path, running the clone's `main.ts`. */
  | { kind: "clone"; bun: string; main: string }
  /** The compiled binary, by its absolute path, and the web app it carries. */
  | { kind: "binary"; path: string; webFiles: WebFiles }
  /**
   * The compiled binary as `npm install -g lookover` installed it (ADR 0061), started by npm's launcher, whose
   * absolute path (`<prefix>/node_modules/lookover/bin/lookover.js`) it was given in `LOOKOVER_LAUNCHER`.
   */
  | { kind: "npm"; path: string; launcher: string; webFiles: WebFiles };

/**
 * The compiled binary at `path`, carrying `webFiles`, as it was started: by npm's launcher when `LOOKOVER_LAUNCHER`
 * names it, by an absolute path to a file that exists; else installed by npm all the same when it sits in a platform package (`node_modules/@lookover/<platform>`)
 * with npm's launcher beside it, as start at login runs it, without Node; else on its own.
 */
export function programSelf(path: string, env: Record<string, string | undefined>, webFiles: WebFiles): Self {
  const named = env.LOOKOVER_LAUNCHER;
  const launcher = named && isAbsolute(named) && existsSync(named) ? named : launcherBeside(path);
  return launcher ? { kind: "npm", path, launcher, webFiles } : { kind: "binary", path, webFiles };
}

/**
 * npm's launcher for the executable at `path` in a platform package: the `lookover` package's `bin/lookover.js`,
 * which holds the platform package in its own `node_modules` (`npm install -g`) or sits beside it (hoisted); null
 * when there is none.
 */
function launcherBeside(path: string): string | null {
  const modules = /^(.*[\\/]node_modules)[\\/]@lookover[\\/][^\\/]+[\\/]/.exec(path)?.[1];
  if (modules === undefined) return null;
  const owner = dirname(modules);
  const candidates = [
    ...(basename(owner) === "lookover" ? [join(owner, "bin", "lookover.js")] : []),
    join(modules, "lookover", "bin", "lookover.js"),
  ];
  return candidates.find((file) => existsSync(file)) ?? null;
}

/** The command that runs `serve` with `args` as `self` does. */
export function serveCommand(self: Self, args: string[]): { executable: string; args: string[] } {
  const [executable = "", ...before] = selfCommand(self);
  return { executable, args: [...before, "serve", ...args] };
}

/** The web app `self` would serve as the program: the clone's build (`cloneBuild`), or the one the binary carries. */
export function webBuildOf(self: Self, cloneBuild: () => WebBuild = cloneWebBuild): WebBuild {
  return self.kind === "clone" ? cloneBuild() : "program";
}
