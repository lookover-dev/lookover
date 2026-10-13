#!/usr/bin/env bun
// The dev launcher. `bun dev` starts the service in demo mode (ADR 0046: the real service on scripted fakes, a
// fake GitHub and a Claude and a Codex answering from a script, no network; its data in `.dev/data-demo`) and the
// app on it, `/api` proxied from the app's port to the service's, so the browser sees one origin (ADR 0010).
// `--scenario=<id>` picks the scenario it starts on (S10, a quiet day, by default). `bun dev --live` starts the
// service in live mode instead: the real GitHub App, `claude` and `codex` on every repository the live
// config lists: the sandbox and Lookover's own, ADR 0041, ADR 0053 (the live config in `.dev/data/live.json`, the
// data in `.dev/data-live`, one store at its root), under the machine-wide live lock, so
// a real review can be watched from "Review now". Every worktree gets its own ports, derived from its path, so
// several can run side by side (decision 0013). Without `--live` it never calls `claude` or `codex` and never
// touches the network.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { instanceOf, portFor } from "./port.ts";

const root = resolve(import.meta.dir, "..");
const devDir = join(root, ".dev");
mkdirSync(devDir, { recursive: true });

const instance = instanceOf(root);
const live = process.argv.includes("--live");
/** What the service is wired with, and the mode the app shows in its developer drawer. */
const mode = live ? "live" : "demo";

const flag = process.argv.find((a) => a.startsWith("--port="))?.slice(7);
const port = Number(flag ?? process.env.LOOKOVER_UI_PORT) || (await portFor(root, 1));
const url = `http://127.0.0.1:${port}/`;

const children: ChildProcess[] = [];

// Best effort: the tree may already be gone. `spawnSync` reports a failed taskkill instead of throwing.
const stop = () => {
  for (const child of children) {
    if (process.platform === "win32")
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGTERM");
  }
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

/** Starts the service (demo or live mode) on its own port and waits for the URL that opens the app on it. */
async function startService(): Promise<{ origin: string; openUrl: string }> {
  const servicePort = await portFor(root, 3);
  const announce = join(devDir, "service.json");
  rmSync(announce, { force: true });
  const scenario = process.argv.filter((a) => a.startsWith("--scenario="));
  const wiring = live
    ? ["--live", `--live-config=${join(devDir, "data", "live.json")}`, `--home=${join(devDir, "data-live")}`]
    : ["--demo", `--home=${join(devDir, "data-demo")}`, ...scenario];
  const child = spawn(
    process.execPath,
    [
      join(root, "apps", "service", "src", "main.ts"),
      "serve",
      ...wiring,
      `--port=${servicePort}`,
      `--origin=http://127.0.0.1:${port}`,
      `--announce=${announce}`,
    ],
    { cwd: root, stdio: "inherit" },
  );
  children.push(child);
  child.on("exit", (code) => process.exit(code ?? 0));
  // Live mode reads the App and its installation from GitHub before it announces: up to 30 s on a busy machine.
  for (let i = 0; i < 300 && !existsSync(announce); i++) await Bun.sleep(100);
  if (!existsSync(announce)) throw new Error("The service did not start");
  const announced: { origin: string; openUrl: string | null } = JSON.parse(readFileSync(announce, "utf8"));
  // Demo and live mode make a one-time link at start; only the program makes none, and it is never started here.
  const { origin, openUrl } = announced;
  if (openUrl === null) throw new Error("The service made no link to open the app with");
  return { origin, openUrl };
}

const service = await startService();

// `bun run proof` starts its own server with `--no-urls`: `.dev/urls.json` keeps pointing at `bun dev`.
if (!process.argv.includes("--no-urls")) {
  const urls = { instance, ui: url, open: service.openUrl, service: service.origin, mode };
  writeFileSync(join(devDir, "urls.json"), JSON.stringify(urls, null, 2));
}

// Resolve Vite's real entry: no .cmd shim, so the process tree can be stopped cleanly on Windows.
const web = join(root, "apps", "web");
const vitePkg = createRequire(join(web, "package.json")).resolve("vite/package.json");
const vite = spawn(process.execPath, [join(dirname(vitePkg), "bin", "vite.js")], {
  cwd: web,
  env: {
    ...process.env,
    LOOKOVER_UI_PORT: String(port),
    LOOKOVER_HOME: join(devDir, "data"),
    LOOKOVER_INSTANCE: instance,
    LOOKOVER_API: service.origin,
    VITE_LOOKOVER_MODE: mode,
  },
  stdio: "inherit",
});
children.push(vite);
vite.on("exit", (code) => process.exit(code ?? 0));

// The link opens the app once (it sets the session cookie); "How to try it" is a page of that app.
const howTo = live ? "" : `  How to try it, once the app is open: ${url}try\n`;
console.log(`\n  Lookover (${mode} mode) · ${instance}\n  Open the app: ${service.openUrl}\n${howTo}`);
