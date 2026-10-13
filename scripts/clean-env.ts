// The environment for a test that runs git in a throwaway repository. Inside a git hook (the pre-push hook runs
// the script tests), git exports GIT_DIR, GIT_INDEX_FILE and friends; inherited, they would point the test's git
// commands at this repository instead. `bun run test:scripts` starts the tests with GIT_DIR pointing nowhere,
// as a hook would: a test that forgets this helper fails on every run, not only at push.

/** This process's environment without any `GIT_*` variable. */
export const cleanEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(Bun.env)) {
    if (!key.startsWith("GIT_") && value !== undefined) env[key] = value;
  }
  return env;
};
