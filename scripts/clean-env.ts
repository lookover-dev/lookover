// The environment for a test that runs git in a throwaway repository. Inside a git hook (the pre-push hook runs
// the script tests), git exports GIT_DIR, GIT_INDEX_FILE and friends; inherited, they would point the test's git
// commands at this repository instead. `bun run test:scripts` starts the tests with GIT_DIR pointing nowhere,
// as a hook would: a test that forgets this helper fails on every run, not only at push.

/**
 * This process's environment without any `GIT_*` variable. The search path is always under `PATH`: on Windows it
 * comes as `Path` when started from PowerShell or cmd, and a test that reads `env.PATH` or sets a `PATH` beside it
 * (two keys, one of them taken at random by the child) would lose it.
 */
export const cleanEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(Bun.env)) {
    if (key.startsWith("GIT_") || value === undefined) continue;
    // Environment names are case-blind on Windows only: elsewhere `path` is a variable of its own.
    env[process.platform === "win32" && key.toUpperCase() === "PATH" ? "PATH" : key] = value;
  }
  return env;
};
