// Live mode's adapters (ADR 0039, ADR 0041, ADR 0053, ADR 0073): GitHub through the shared App (its device flow, and
// the sign-in kept sealed in the data folder, or the folder `signIns` names, on the OS keychain) and the repository
// ports as the person signed in, both built with the live config's allow-list so they refuse any other repository; the
// real `claude` and `codex` through the real `engines` module (each found where it is installed, ADR 0044), each
// version self-tested before it reviews (ADR 0044), the confirm pass on a second build of them at its own effort
// (Codex `medium`, ADR 0044), and `retrieval` fetching from GitHub with the person's token. A fresh data folder starts
// at the setup's first step; in live mode (`signIns` named, ADR 0073), a sign-in kept there sets the data folder up at
// once, and `LiveAdapters.start` says what the run is on. A data folder holding an App of its own from an earlier
// version (`github/app.json`) is read as one with none: its setup's GitHub step asks for a sign-in. No scripted push:
// a live push is the owner's, or `bun run live`'s through `gh`. The machine-wide lock is the program's to take
// (`acquireLiveLock`), since `bun run live` holds it around more than the service.
import { homedir } from "node:os";
import { join } from "node:path";
import type { Gh, HostLogin } from "@lookover/contracts";
import { createEngines, type SignIn } from "@lookover/engines";
import { createGitHub, createHostAccounts, createHostSignIn } from "@lookover/github";
import { createProcessRunner } from "@lookover/process";
import { openTerminal } from "@lookover/process/terminal";
import { createRetrieval } from "@lookover/retrieval";
import type { GitHubSide } from "./installation.ts";
import { type Keychain, osKeychain } from "./keychain.ts";
import type { LiveConfig } from "./live-config.ts";
import type { ServiceOptions } from "./service.ts";
import type { SignInOpener } from "./sign-in.ts";
import { type SignInStore, signInStore } from "./sign-in-store.ts";
import { NEW_OWNER, SET_UP } from "./snapshot.ts";
import { REAL_TIMERS } from "./timers.ts";

export interface LiveOptions {
  /** The data folder: the mirrors, the worktrees and the runs live under it. */
  home: string;
  /**
   * The process registry: the service records every process it starts there, and sweeps what a crashed start left
   * at the next one.
   */
  processes: string;
  /** The service's whole environment, for git, `claude` and `codex`. */
  env: Record<string, string>;
  /** The git program, by absolute path. */
  git: string;
  /**
   * The live config: the repositories it may use (the allow-list). None (the program unguarded, ADR 0054): every
   * repository the installations list.
   */
  config: LiveConfig | undefined;
  /** Given every secret GitHub's adapter comes to hold (its tokens), for the log to remove (ADR 0054). */
  secret?(value: string): void;
  /**
   * The folder whose sign-in to the shared App the service reads and renews (ADR 0066): `home` unless given. Live mode
   * gives it (`serve --live`, its `--sign-ins` or its data folder; `bun run live`, the live data folder, ADR 0073), so
   * every run's fresh folder shares the one sign-in, never a copy of it; given, a sign-in kept there sets the data
   * folder up at once. The program never gives it: its setup goes on from where it was.
   */
  signIns?: string;
  /** The keychain the sign-in store keeps its data key in: the OS's by default; a test's own. */
  keychain?: Keychain;
}

/** The person `gh` is signed in as; throws, saying why, when it names nobody. */
export const ghPerson = (gh: Gh) => async (): Promise<HostLogin> => {
  const read = await gh.person();
  if (read.kind === "signed-in") return { id: read.account.id, login: read.account.login };
  const why =
    read.kind === "missing"
      ? "gh is not installed"
      : read.kind === "signed-out"
        ? "gh is signed out (gh auth login)"
        : `gh gave no answer (${read.why}: ${read.detail})`;
  throw new Error(`The person is the one gh is signed in as, and ${why}.`);
};

export type LiveAdapters = Pick<
  ServiceOptions,
  "github" | "engines" | "confirmEngines" | "selfTests" | "signIn" | "retrieval" | "setup" | "setUpAtOnce"
> & {
  /** How live mode starts, when `LiveOptions.signIns` was given: who it runs as (ADR 0073). */
  start?: LiveStart;
};

/**
 * Who live mode runs as at start (ADR 0073): the person signed in to the shared App in `signIns`'s folder, one whose
 * sign-in no longer opens, or nobody.
 */
export type LiveStart =
  | { as: "signed-in"; person: HostLogin }
  | { as: "lost"; person: HostLogin }
  | { as: "signed-out" };
/**
 * "Sign in" in live mode (ADR 0047): the vendor's own login, as `engines` names it, in a visible terminal the user
 * signs in at, started from their home folder with the engine's allow-listed environment and nothing else of the
 * service's (ADR 0048); the one process started outside the runner. An engine that isn't installed has no login
 * to open. `session` is the service's environment, for the terminal's desktop session (`openTerminal` reads
 * nothing else of it). `open` is the terminal (`openTerminal`), replaced in tests.
 */
export const terminalSignIn = (
  engines: SignIn,
  session: Record<string, string>,
  open = openTerminal,
): SignInOpener => ({
  open: (engine) => {
    const program = engines.signInCommand(engine);
    if (program === null) return Promise.resolve({ opened: false, reason: `${engine} is not installed` });
    return open(
      { executable: program.executable, args: program.args, cwd: homedir(), env: program.env },
      session,
    );
  },
});

/**
 * What a live config guards (ADR 0053, ADR 0054): with one, only its repositories are watched; without one (the
 * program unguarded), every repository the installations list. Whatever `side` said of it is replaced.
 */
export function guarded(side: GitHubSide, config: LiveConfig | undefined): GitHubSide {
  const { allowed: _allowed, ...rest } = side;
  return config === undefined ? rest : { ...rest, allowed: config.repositories };
}

/**
 * GitHub for a real run (ADR 0066, ADR 0073): the shared App, its sign-in kept in `signIns`, its accounts and the
 * repository ports as the person, each built with the live config's allow-list when there is one, and guarded by it,
 * each given `secret` for the log.
 */
function liveGitHub(
  config: LiveConfig | undefined,
  secret: ((value: string) => void) | undefined,
  signIns: SignInStore,
): GitHubSide {
  const repositories = config?.repositories;
  const told = {
    ...(repositories === undefined ? {} : { repositories }),
    ...(secret === undefined ? {} : { secret }),
  };
  // Guarded here for `bun run live`, which starts on these adapters alone; the program's wiring guards them again.
  return guarded(
    {
      shared: {
        signIn: createHostSignIn(told),
        signIns,
        accounts: (keeper) => createHostAccounts({ keeper, ...told }),
        connect: (keeper) => {
          const github = createGitHub({ keeper, ...told });
          return { intake: github.intake, writer: github.writer };
        },
      },
    },
    config,
  );
}

export async function liveAdapters({
  home,
  processes,
  env,
  git,
  config,
  secret,
  signIns,
  keychain = osKeychain(REAL_TIMERS),
}: LiveOptions): Promise<LiveAdapters> {
  const runner = createProcessRunner({ registryFile: processes });
  await runner.sweepOrphans();
  const engines = createEngines({ runner, env });
  const store = signInStore({ home: signIns ?? home, keychain });
  // Live mode's start, when its sign-in's folder is named: who it runs as (ADR 0073).
  const start = signIns === undefined ? undefined : await startOf(store);
  // With live mode's sign-in kept, set up at once; else the setup's first step on a fresh data folder (ADR 0053).
  const given = start?.as === "signed-in";
  return {
    github: liveGitHub(config, secret, store),
    engines,
    // The confirm pass at its own effort (ADR 0044): Codex at medium.
    confirmEngines: createEngines({ runner, env, codexEffort: "medium" }),
    selfTests: engines,
    signIn: terminalSignIn(engines, env),
    retrieval: createRetrieval({ root: join(home, "repos"), runner, env, git }),
    setup: given ? SET_UP : NEW_OWNER,
    setUpAtOnce: given,
    ...(start === undefined ? {} : { start }),
  };
}

/** Who live mode runs as (`LiveStart`): the sign-in `signIns` keeps, kept, lost or none. */
async function startOf(signIns: SignInStore): Promise<LiveStart> {
  const read = await signIns.read();
  if (read.state === "none") return { as: "signed-out" };
  const { id, login } = read.state === "kept" ? read.signIn.person : read.person;
  return { as: read.state === "kept" ? "signed-in" : "lost", person: { id, login } };
}
