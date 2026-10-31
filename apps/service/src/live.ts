// Live mode's adapters (ADR 0039, ADR 0041, ADR 0053): GitHub at the App level and the repository ports its key
// signs, both built with the live config's allow-list so they refuse any other repository; the real `claude` and
// `codex` through the real `engines` module (each found where it is installed, ADR 0044), each version self-tested
// before it reviews (ADR 0044), the confirm pass on a second build of them at its own effort (Codex `medium`, ADR
// 0044), and `retrieval` fetching from GitHub with the App's short-lived token. The App is `live.json`'s when it names
// one: its key's text read here from the path it gives, passed to the adapters and never logged, never stored, and
// the data folder set up at once. Without one, the data folder's (its App store, its key in the OS keychain), and a
// fresh data folder starts at the setup's first step. The shared App is offered beside it (ADR 0066): its device flow,
// and the sign-in kept sealed in the data folder (or the folder `signIns` names) on the same keychain, used only when
// no App is: `live.json`'s or the data folder's own wins. The owner and the bot are the App's, asked of GitHub when the
// room opens; `live.json`'s App owned by an organisation works for the person their own `gh` names (ADR 0059). No scripted push: a live push is the owner's, or `bun run live`'s through `gh`. The machine-wide lock
// is the program's to take (`acquireLiveLock`), since `bun run live` holds it around more than the service.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Gh, HostLogin } from "@lookover/contracts";
import { createEngines, type SignIn } from "@lookover/engines";
import {
  createGitHub,
  createHostAccounts,
  createHostInstallations,
  createHostSignIn,
} from "@lookover/github";
import { createProcessRunner } from "@lookover/process";
import { openTerminal } from "@lookover/process/terminal";
import { createRetrieval } from "@lookover/retrieval";
import { appStore } from "./app-store.ts";
import type { GitHubSide } from "./installation.ts";
import { type Keychain, osKeychain } from "./keychain.ts";
import type { LiveConfig } from "./live-config.ts";
import type { ServiceOptions } from "./service.ts";
import type { SignInOpener } from "./sign-in.ts";
import { signInStore } from "./sign-in-store.ts";
import { NEW_OWNER, SET_UP } from "./snapshot.ts";
import { REAL_TIMERS } from "./timers.ts";

export interface LiveOptions {
  /** The data folder: the mirrors, the worktrees, the runs and the App store live under it. */
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
   * The live config: the repositories it may use (the allow-list), and the App, when it names one. None (the program
   * unguarded, ADR 0054): every repository the installation lists, and the setup may create the App.
   */
  config: LiveConfig | undefined;
  /** Given every secret GitHub's adapter comes to hold (its key, JWTs, tokens), for the log to remove (ADR 0054). */
  secret?(value: string): void;
  /**
   * The folder whose sign-in to the shared App the service reads and renews (ADR 0066): `home` unless given. `bun run
   * live` gives the live data folder, so every run's fresh folder shares the one sign-in, never a copy of it.
   */
  signIns?: string;
  /**
   * The person's own `gh` (ADR 0059): who `live.json`'s App works for when an organisation owns it, asked at start.
   * Absent: such an App is refused at start.
   */
  gh?: Gh;
}

/**
 * The person `gh` is signed in as, for an organisation's App named by `live.json` (ADR 0059); throws, saying why,
 * when it names nobody: never the organisation in their place.
 */
export const ghPerson = (gh: Gh) => async (): Promise<HostLogin> => {
  const read = await gh.person();
  if (read.kind === "signed-in") return { id: read.account.id, login: read.account.login };
  const why =
    read.kind === "missing"
      ? "gh is not installed"
      : read.kind === "signed-out"
        ? "gh is signed out (gh auth login)"
        : `gh gave no answer (${read.why}: ${read.detail})`;
  throw new Error(`An organisation's App works for the person gh is signed in as, and ${why}.`);
};

export type LiveAdapters = Pick<
  ServiceOptions,
  "github" | "engines" | "confirmEngines" | "selfTests" | "signIn" | "retrieval" | "setup" | "setUpAtOnce"
>;

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
 * What a live config guards (ADR 0053, ADR 0054): with one, only its repositories are watched and no App is ever
 * created ("Create it on GitHub" and its page refuse, ADR 0045); without one (the program unguarded), every
 * repository the installation lists, and the setup may create the App. Whatever `side` said of either is replaced.
 */
export function guarded(side: GitHubSide, config: LiveConfig | undefined): GitHubSide {
  const { allowed: _allowed, liveConfig: _liveConfig, ...rest } = side;
  if (config === undefined) return { ...rest, liveConfig: false };
  return { ...rest, allowed: config.repositories, liveConfig: true };
}

/**
 * GitHub for a real run (ADR 0053, ADR 0066): the App level and the repository ports, each built with the live config's
 * allow-list when there is one, and guarded by it, each given `secret` for the log; the App the live config names,
 * else the data folder's App store over the OS keychain; and the shared App, its sign-in kept in `signIns`'s sign-in
 * store on the same keychain (the App, when there is one, wins over it).
 */
function liveGitHub(
  home: string,
  config: LiveConfig | undefined,
  secret: ((value: string) => void) | undefined,
  gh: Gh | undefined,
  signIns: string,
): GitHubSide {
  const repositories = config?.repositories;
  const told = {
    ...(repositories === undefined ? {} : { repositories }),
    ...(secret === undefined ? {} : { secret }),
  };
  const keychain: Keychain = osKeychain(REAL_TIMERS);
  // Guarded here for `bun run live`, which starts on these adapters alone; the program's wiring guards them again.
  const side: GitHubSide = guarded(
    {
      installations: createHostInstallations(told),
      connect: ({ id, key }) => {
        const github = createGitHub({ app: { id, privateKey: key }, ...told });
        return { intake: github.intake, writer: github.writer };
      },
      shared: {
        signIn: createHostSignIn(told),
        signIns: signInStore({ home: signIns, keychain }),
        accounts: (keeper) => createHostAccounts({ keeper, ...told }),
        connect: (keeper) => {
          const github = createGitHub({ keeper, ...told });
          return { intake: github.intake, writer: github.writer };
        },
      },
    },
    config,
  );
  const app = config?.app;
  if (app === undefined) return { ...side, apps: appStore({ home, keychain }) };
  const person = gh === undefined ? {} : { person: ghPerson(gh) };
  return { ...side, given: { id: app.id, key: readFileSync(app.keyPath, "utf8") }, ...person };
}

export async function liveAdapters({
  home,
  processes,
  env,
  git,
  config,
  secret,
  gh,
  signIns,
}: LiveOptions): Promise<LiveAdapters> {
  const runner = createProcessRunner({ registryFile: processes });
  await runner.sweepOrphans();
  const engines = createEngines({ runner, env });
  // With `live.json`'s App, set up at once; without, the setup's first step on a fresh data folder (ADR 0053).
  const given = config?.app !== undefined;
  return {
    github: liveGitHub(home, config, secret, gh, signIns ?? home),
    engines,
    // The confirm pass at its own effort (ADR 0044): Codex at medium.
    confirmEngines: createEngines({ runner, env, codexEffort: "medium" }),
    selfTests: engines,
    signIn: terminalSignIn(engines, env),
    retrieval: createRetrieval({ root: join(home, "repos"), runner, env, git }),
    setup: given ? SET_UP : NEW_OWNER,
    setUpAtOnce: given,
  };
}
