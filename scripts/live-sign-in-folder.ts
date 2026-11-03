// The live sign-in's folder (ADR 0073): the one data folder whose sign-in to the shared App every live run on this
// machine reads and renews in place, never a copy (a refresh token works once). `LOOKOVER_HOME` when set (against `cwd` when relative), else the
// main checkout's `.dev/data`, found from the clone's common git folder, so every worktree of the clone reaches the
// same one. `bun dev --live` reads it; `bun run live` signs it in. Both run under the machine's live lock.
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "bun";

export interface Where {
  /** The folder asking: any folder of a checkout, the main one or a worktree. */
  cwd: string;
  /** The environment: `LOOKOVER_HOME`, and what git runs with. */
  env: Record<string, string | undefined>;
}

/** The live sign-in's folder seen from `cwd`; throws, saying what to set, outside a clone with no `LOOKOVER_HOME`. */
export function liveSignInFolder({ cwd, env }: Where): string {
  const home = env.LOOKOVER_HOME;
  if (home) return resolve(cwd, home);
  const asked = spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd,
    env: withoutGit(env),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (asked.exitCode !== 0)
    throw new Error(
      `${cwd} is not in a clone of Lookover: set LOOKOVER_HOME to the folder whose sign-in live runs use.`,
    );
  // The common git folder is the main checkout's `.git`, whichever worktree asks.
  return join(dirname(resolve(asked.stdout.toString().trim())), ".dev", "data");
}

/**
 * `env` without any `GIT_*` variable (as `clean-env.ts` does for the tests): a `GIT_DIR` a hook or a caller exported
 * would point git at another repository than `cwd`'s.
 */
function withoutGit(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("GIT_")));
}
