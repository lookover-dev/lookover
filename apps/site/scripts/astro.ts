// Runs Astro on the site, the one way every site script does: from the site's folder, with Astro's telemetry off,
// so no script of the site sends anything anywhere (ADR 0064, 5).
import { fileURLToPath } from "node:url";

const SITE = fileURLToPath(new URL("..", import.meta.url));

/** Runs `astro <args>` in the site's folder, its output on this terminal; returns its exit code. */
export function astro(args: string[]): number {
  const run = Bun.spawnSync([process.execPath, "x", "astro", ...args], {
    cwd: SITE,
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" },
    stdio: ["inherit", "inherit", "inherit"],
  });
  return run.exitCode;
}
