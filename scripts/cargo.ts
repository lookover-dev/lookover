// The tray helper's crate, `apps/tray` (ADR 0105), as `bun run build` and `bun run cargo:check` reach it: where
// Cargo is (the PATH's, else rustup's in CARGO_HOME or ~/.cargo, where a new install puts it before a new terminal
// has it on the PATH), what to say when it isn't, how to run it in the crate, and the check the build and the release
// smoke run on a built helper (`trayFault`): its version, its first line read as the service reads it, its exit; and
// the crate's own check, `cargoCheck`, with and without fetching (`bun run cargo:check`, `bun run check`).
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readTrayFirstLine } from "../apps/service/src/tray-protocol.ts";
import { cleanEnv } from "./clean-env.ts";

/** The crate's folder: its `.cargo/config.toml` builds into the root's `dist/cargo`. */
export const CRATE = join(resolve(import.meta.dir, ".."), "apps", "tray");

/** Where Cargo leaves the release build of the helper (`.cargo/config.toml`'s target-dir). */
export const RELEASE_DIR = join(resolve(import.meta.dir, ".."), "dist", "cargo", "release");

/** What the scripts say, and stop on, when Cargo can't be found. */
export const NO_CARGO =
  "Cargo isn't installed, and the tray helper (apps/tray) is built with Rust. Install Rust with rustup " +
  "(https://rustup.rs), open a new terminal, and run this again: the crate's rust-toolchain.toml picks its version.";

/** One Cargo run of the crate's check: its arguments, and what it adds to the environment. */
export type CargoStep = { name: string; args: string[]; env: Record<string, string> };

/** Rustup installs no toolchain on its own: a check never reaches the network (hard rule 1). */
const OFFLINE_ENV = { RUSTUP_AUTO_INSTALL: "0" };

/**
 * The crate's check, `bun run cargo:check`'s steps (ADR 0105 §15). `fetch`: the locked crates fetched (the build's
 * network, once), then format, lint and test offline. `frozen`, as `bun run check` and `check:full` run it: no fetch,
 * `--frozen` (no network, no lock change), and rustup installs no toolchain.
 */
export function cargoCheck(mode: "fetch" | "frozen"): CargoStep[] {
  const env = mode === "frozen" ? OFFLINE_ENV : {};
  const lock = mode === "frozen" ? ["--frozen"] : ["--locked", "--offline"];
  return [
    ...(mode === "fetch" ? [{ name: "fetch the locked crates", args: ["fetch", "--locked"], env }] : []),
    { name: "format", args: ["fmt", "--check"], env },
    { name: "lint", args: ["clippy", "--all-targets", ...lock, "--", "-D", "warnings"], env },
    { name: "test", args: ["test", ...lock], env },
  ];
}

/** Asked, offline, before the `frozen` check: Cargo reads every locked crate's manifest, so it fails on one missing. */
export const FETCHED_PROBE = { args: ["metadata", "--frozen", "--format-version", "1"], env: OFFLINE_ENV };

/** What the `frozen` check says when the probe failed, Cargo's own words (`said`) after it. */
export function notFetched(said: string): string {
  const why =
    "The tray helper's crates (apps/tray) or its Rust toolchain aren't on this machine yet, and the check " +
    "never fetches: run `bun run cargo:check`, which fetches them once, then check again.";
  const cargo = said.trim();
  return cargo === "" ? why : `${why}\n${cargo}`;
}

/**
 * Cargo's path: the one `which` finds on the PATH, else rustup's in `cargoHome` (CARGO_HOME) or `home`'s `.cargo`,
 * if `exists` says it is there; undefined when there is none.
 */
export function findCargo(o: {
  which: (name: string) => string | null;
  exists: (path: string) => boolean;
  cargoHome: string | undefined;
  home: string;
  platform: NodeJS.Platform;
}): string | undefined {
  const onPath = o.which("cargo");
  if (onPath !== null) return onPath;
  const file = o.platform === "win32" ? "cargo.exe" : "cargo";
  const homes = [o.cargoHome, `${o.home}/.cargo`].filter((home) => home !== undefined && home !== "");
  return homes.map((home) => `${home}/bin/${file}`).find(o.exists);
}

/** This machine's Cargo, or undefined. */
export const machineCargo = (): string | undefined =>
  findCargo({
    which: (name) => Bun.which(name),
    exists: existsSync,
    cargoHome: Bun.env.CARGO_HOME,
    home: homedir(),
    platform: process.platform,
  });

/**
 * Runs `cargo` with `args` in the crate, its output shown as it comes, its folder first on the PATH (rustup's
 * proxies beside it) and `env` added; its exit code.
 */
export async function runCargo(
  cargo: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<number> {
  const proc = Bun.spawn([cargo, ...args], {
    cwd: CRATE,
    env: cargoEnv(cargo, env),
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
}

/** Runs `cargo` with `args` in the crate as `runCargo` does, its output kept: its exit code and its standard error. */
export function askCargo(
  cargo: string,
  args: string[],
  env: Record<string, string> = {},
): { code: number; said: string } {
  const done = Bun.spawnSync([cargo, ...args], {
    cwd: CRATE,
    env: cargoEnv(cargo, env),
    stdout: "ignore",
    stderr: "pipe",
  });
  return { code: done.exitCode, said: done.stderr.toString() };
}

/** The environment Cargo runs in: a clean one, its folder first on the PATH (rustup's proxies beside it), `env` added. */
function cargoEnv(cargo: string, env: Record<string, string>): Record<string, string | undefined> {
  const base = cleanEnv();
  const separator = process.platform === "win32" ? ";" : ":";
  const PATH = [dirname(cargo), base.PATH ?? ""].join(separator);
  return { ...base, PATH, ...env };
}

/**
 * Why the helper's first line fails the checks, or undefined when it passes: `ready` with `version` and the service's
 * protocol, or `unavailable` (a machine with no tray, such as a CI runner, still builds), read as the service reads it.
 */
export function trayAnswerFault(line: string, version: string): string | undefined {
  const first = readTrayFirstLine(line, version);
  return "refused" in first ? first.refused : undefined;
}

/** The first line `stream` gives, without its line break; what it gave when it ends first. */
async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n")) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  return (text.split("\n")[0] ?? "").trim();
}

/**
 * Why the tray helper `argv`, run in `cwd`, fails the build's or the release smoke's check, or null when it passes:
 * its `--version` is `version` within `limitMs` (it is stopped past that), then, started as the service starts it
 * (its standard streams pipes), its first line passes `trayAnswerFault` within `limitMs`, and it exits 0 within
 * `limitMs` once its standard input closes. A first line it fails on stops it before its standard error is read and
 * added: a helper that keeps running would never end that stream. It is stopped whatever happened.
 */
export async function trayFault(
  argv: string[],
  version: string,
  o: { limitMs: number; cwd?: string } = { limitMs: 10_000 },
): Promise<string | null> {
  const cwd = o.cwd ?? process.cwd();
  const options = { cwd, stdout: "pipe", stderr: "pipe", timeout: o.limitMs } as const;
  const asked = Bun.spawnSync([...argv, "--version"], options);
  if (asked.exitedDueToTimeout) return `--version gave no answer in ${o.limitMs / 1000} s`;
  const said = asked.stdout.toString().trim();
  if (asked.exitCode !== 0) return `--version exited ${asked.exitCode}: ${asked.stderr.toString()}`;
  if (said !== version) return `--version said "${said}", not ${version}`;
  const proc = Bun.spawn(argv, { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const printed = new Response(proc.stderr).text();
  const exited = proc.exited.then(() => true);
  const late = (ms: number) => Bun.sleep(ms).then(() => undefined);
  try {
    const line = await Promise.race([firstLine(proc.stdout), late(o.limitMs)]);
    if (line === undefined) return `it said nothing in ${o.limitMs / 1000} s`;
    const fault = trayAnswerFault(line, version);
    if (fault !== undefined) {
      proc.kill();
      await proc.exited;
      const err = (await printed).trim();
      return err === "" ? fault : `${fault}\n${err}`;
    }
    await proc.stdin.end();
    if ((await Promise.race([exited, late(o.limitMs)])) === undefined)
      return "its standard input closed, and it ran on";
    if (proc.exitCode !== 0) return `its standard input closed, it exited ${proc.exitCode}: ${await printed}`;
    return null;
  } finally {
    proc.kill();
    await proc.exited;
  }
}
