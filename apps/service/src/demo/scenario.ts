// A scenario (ADR 0046): data plus a script, played by the driver (`driver.ts`) against the real service on the
// scripted fakes. The data: the world (the one repository, its bot and owner, each engine's health, the base
// commit), the changes (number, title, branch, author, commits oldest first, each with the diff the review reads
// at it and what the engines answer at each pass). Who wrote a change is in its commits' messages, as the host
// shows it (`Co-authored-by`, ADR 0044), never a field of its own. The script: timed moves on the fake world and
// commands sent as the owner would, `at` milliseconds from the room's start; the seed is the part at or before
// `seed`, played at load with the clock advanced through it, the rest scheduled on the clock. A scenario carries
// no sentence a screen shows but what the developer drawer lists (`DemoScenario`).
import type {
  Command,
  CommitSha,
  DemoScenario,
  EngineHealth,
  EngineId,
  FindingId,
  HostFailure,
  RepositoryRef,
  RulesFile,
  SettingKey,
  SettingValues,
  Setup,
} from "@lookover/contracts";
import type { ScriptedConfirmAnswer, ScriptedFindAnswer } from "@lookover/testkit/demo";

/** Someone on the host: the numeric id is the identity (ADR 0006). */
export interface Account {
  id: number;
  login: string;
}

export interface World {
  repo: RepositoryRef;
  /**
   * The owner's other repositories, after `repo`, in GitHub's order: the App's installation grants them all, with no
   * pull request of the story's. Absent, none.
   */
  repositories?: RepositoryRef[];
  bot: Account;
  /** The person Lookover works for (ADR 0059): whose changes are theirs. The App's account too, unless `organisation`. */
  owner: Account;
  /**
   * The organisation the App lives on (ADR 0059), whose repositories `repo` and `repositories` are, the owner an
   * active member of it, its admin when `admin`; absent, the App is on the owner's own account.
   */
  organisation?: { account: Account; admin: boolean };
  /** The owner's own `gh` (ADR 0059): signed in as the owner, signed out, or not installed. Absent, signed out. */
  gh?: "signed-in" | "signed-out" | "missing";
  /** Each engine's health at the start; the self-tests pass unless a move says otherwise. */
  engines: Record<EngineId, EngineHealth>;
  /** The repository's default branch and its commit: every change's base. */
  main: { ref: string; sha: CommitSha };
  /** The rules files at the root of `main`, which every review reads (ADR 0048); none unless said. */
  rules?: Pick<RulesFile, "path" | "text">[];
  /**
   * Where the owner is in the first-run setup at the start; absent, set up. The App is on GitHub either way (ADR
   * 0053): once the setup says it was made, kept in the room's App store, and installed once it says so; before,
   * made on another computer and installed on every repository, but not kept here, so nothing is listed until the
   * owner makes a new one ("Create it on GitHub": the manifest flow on GitHub's fake pages) or gives this one ("Use
   * an existing App", its id and a key from its fake page).
   */
  setup?: Setup;
  /**
   * The app reaches the service from another device (a phone), each session view-only until "Unlock". Demo-only:
   * no service is reached from elsewhere until a server mode exists. Absent, false.
   */
  remote?: boolean;
  /**
   * A tab without the session is told `<command> open` with the room's command (demo's is a downloaded binary's
   * path, ADR 0058), as the program's is, so proof shoots the program's session screen. Absent, development's: a 401
   * that names no command (the screen names `bun dev`'s link).
   */
  namesOpen?: true;
  /**
   * The settings files in the room at the start (ADR 0049), planted through the settings writer as the owner's
   * saves would write them: the owner's defaults (`settings.yaml`), then the repository's own values
   * (`<owner>/<name>/settings.yaml`). Absent, no file: Lookover's defaults apply.
   */
  settings?: { defaults?: SettingPair[]; repository?: SettingPair[] };
}

/** A setting and a value it takes, typed together: what a world plants, in the order written. */
type SettingPair = { [K in SettingKey]: [K, SettingValues[K]] }[SettingKey];

/** One commit of a change: the diff the review reads at it, and what each engine answers at each pass. */
interface ScenarioCommit {
  sha: CommitSha;
  /** The full message, trailers included: an agent's `Co-authored-by` says who wrote it. */
  message: string;
  /**
   * The messages of the commits pushed with this one, beneath it, oldest first: a push of several commits that
   * ends at this one. None: the push brings this commit alone.
   */
  pushedWith?: string[];
  /** The change's whole diff from its base at this commit, unified as git prints it. */
  diff: string;
  /** What the find pass answers at this commit; none, and a review of it crashes ("nothing scripted"). */
  find?: ScriptedFindAnswer;
  /** What the confirm pass answers on the find pass's candidates; none when nothing is found. */
  confirm?: ScriptedConfirmAnswer;
}

export interface ScenarioChange {
  number: number;
  title: string;
  branch: string;
  author: Account;
  /** A draft until marked ready; false unless said. */
  draft?: boolean;
  /**
   * From a fork (ADR 0048); false unless said. Its head stays on a branch of the planted repository, which is what
   * the fake host fetches.
   */
  fork?: boolean;
  /** Oldest first: the first is the head when the change opens; each next one lands with a push. */
  commits: [ScenarioCommit, ...ScenarioCommit[]];
}

/** The commands a script sends as the owner would: the ones the room answers. */
type OwnerCommand = Extract<Command, { type: "review.request" | "service.pause" }>;

/** A refusal the fake host can be brought to, for a while. */
type Refusal = Extract<HostFailure, "unavailable" | "rate_limited">;

/**
 * A move on the fake world. `open`: the host lists the change, at its first commit. `push`: its next commit
 * lands. `ask`: a `/lookover review` comment by the owner's agent (as the owner, naming the head commit, as
 * `lookover wait` writes it). `refuse`: the host refuses every call for `forMs` on the clock (as rate limited, with
 * that time as GitHub's reset), then answers again. `update`: the engine is a newer version, whose self-test passes
 * or fails on the wall. `too-old`: the engine's program is found at `version`, too old for the model it reviews on,
 * set as its health says it (the scripted engines run no version check). `installed`: the engine's program is
 * installed again at `version`, signed in, as the owner does in a terminal: nothing tells the service, which sees it
 * at its next health check ("Check again"). `reply`: `by` answers on the thread of `finding`, the bot's inline
 * comment on it, with `text` (ADR 0052): as the owner's agent does with the owner's login, the owner, the change's
 * author or anyone. Nothing is listed: a round reads the threads when it runs.
 */
export type Move =
  | { kind: "open"; change: number }
  | { kind: "push"; change: number }
  | { kind: "ask"; change: number }
  | { kind: "reply"; change: number; finding: FindingId; by: Account; text: string }
  | { kind: "close"; change: number }
  | { kind: "sign-out"; engine: EngineId }
  | { kind: "missing"; engine: EngineId }
  | { kind: "installed"; engine: EngineId; version: string }
  | { kind: "too-old"; engine: EngineId; version: string }
  | { kind: "refuse"; failure: Refusal; forMs: number }
  | { kind: "update"; engine: EngineId; version: string; selfTest: "passes" | "fails" }
  | { kind: "command"; command: OwnerCommand };

export interface TimedMove {
  /** Milliseconds from the room's start. */
  at: number;
  move: Move;
}

export interface Scenario extends DemoScenario {
  world: World;
  /** Every change the story can show: the script opens some; the drawer's faults open the rest. */
  changes: ScenarioChange[];
  script: TimedMove[];
  /**
   * How long the seed lasts, from the room's start: the moves at or before it are played at load, the clock
   * advanced through them, and the room's `now` is its start plus this once loaded.
   */
  seed: number;
}
