// The developer drawer's channel to the service in demo mode (ADR 0046): beside `LookoverApi`, never in it. The
// product boundary carries no demo; the drawer (`apps/web/src/dev`) may import only this package, so its wire
// types live here. The dev verbs go to `API.commands` like a `Command`, and `DEMO_API.listing` answers what the
// drawer shows. In live mode every verb answers 501 and the listing 404: nothing scripted touches a real
// repository. Types and ids only, but the faults' labels: the service answers them as data, so the drawer and the
// service name a fault the same way.

/** What the drawer can make happen in the fake world, in the order it lists them. Each id is written here once. */
const FAULT_IDS = [
  "claude-signed-out",
  "codex-signed-out",
  "codex-limit",
  "codex-failed-self-test",
  "codex-too-old",
  "engines-missing",
  "connection-lost",
  "app-uninstalled",
  "app-suspended",
  "key-refused",
  "key-lost",
  "nothing-granted",
  "repository-added",
  "repository-removed",
  "repository-back",
  "github-limit",
  "agent-opens-change",
  "other-opens-change",
  "you-push",
  "close-change",
  "codex-updated",
  "settings-unwritable",
  "login-refused",
  "path-refused",
  "launcher-stale",
  "npm-install",
  "npm-off-path",
  "skill-refused",
  "gh-signed-in",
  "gh-uninstalled",
  "gh-signed-out",
  "not-a-member",
] as const;

export type FaultId = (typeof FAULT_IDS)[number];

export interface DemoFault {
  id: FaultId;
  label: string;
}

/** Each fault's label: a fault without one, or a label without its fault, fails the typecheck. */
const LABELS: Record<FaultId, string> = {
  "claude-signed-out": "Claude signs out",
  "codex-signed-out": "Codex signs out",
  "codex-limit": "Codex reaches its limit",
  "codex-failed-self-test": "Codex fails Lookover's safety check",
  "codex-too-old": "Codex is too old for its model",
  "engines-missing": "Both AIs go missing",
  "connection-lost": "GitHub can't be reached",
  "app-uninstalled": "Your App is uninstalled on GitHub",
  "app-suspended": "Your App is suspended on GitHub",
  "key-refused": "GitHub refuses your App's key",
  "key-lost": "Lookover restarts without your App's key",
  "nothing-granted": "Your App is installed on no repository",
  "repository-added": "A repository is added to your App",
  "repository-removed": "A repository is removed from your App",
  "repository-back": "A removed repository is added back to your App",
  "github-limit": "GitHub asks to wait",
  "agent-opens-change": "Your agent opens a pull request",
  "other-opens-change": "Someone else opens a pull request",
  "you-push": "You push to a reviewed pull request",
  "close-change": "A pull request is closed",
  "codex-updated": "Codex is updated",
  "settings-unwritable": "Settings can't be saved",
  "login-refused": "Lookover restarts and the computer refuses its start at login",
  "path-refused": "The computer refuses to change the PATH",
  "launcher-stale": "Lookover's launcher runs an earlier copy",
  "npm-install": "Lookover restarts as an npm install",
  "npm-off-path": "Lookover restarts as an npm install whose folder isn't on the PATH",
  "skill-refused": "The computer refuses to change the skill's folder",
  "gh-signed-in": "You sign in to gh",
  "gh-uninstalled": "gh is uninstalled",
  "gh-signed-out": "You sign out of gh",
  "not-a-member": "An admin removes you from the organisation",
};

/** Every fault with its label, as the listing answers them. */
export const FAULTS: DemoFault[] = FAULT_IDS.map((id) => ({ id, label: LABELS[id] }));

/**
 * The dev verbs, posted where a `Command` is. `demo.load` resets the world to a scenario under the same server and
 * session; `demo.inject` makes a fault happen; `demo.clock` runs or stands the clock still, at a speed; `demo.advance`
 * moves it by a time and `demo.step` to the next timer; `refresh` lists the pull requests now.
 */
export type DemoCommand =
  | { type: "demo.load"; id: string }
  | { type: "demo.inject"; fault: FaultId }
  | { type: "demo.clock"; running: boolean; speed: number }
  | { type: "demo.advance"; ms: number }
  | { type: "demo.step" }
  | { type: "refresh" };

/** A scenario as the drawer and "How to try it" list it. */
export interface DemoScenario {
  id: string;
  title: string;
  /** What it plays. */
  what: string;
  /** What to do, in order. */
  steps: string[];
  /** What the story leaves out until a later row builds it; empty when nothing. */
  later: string;
  /** Where the app opens it. */
  path: string;
}

/** The demo clock: the service's `now`, whether it flows, how fast, and how far the next timer is. */
export interface DemoClock {
  now: number;
  running: boolean;
  speed: number;
  /** Milliseconds on the clock to the next timer; null when none is armed. */
  nextIn: number | null;
}

/** What `DEMO_API.listing` answers. */
export interface DemoListing {
  scenarios: DemoScenario[];
  /** The scenario loaded now. */
  current: string;
  clock: DemoClock;
  faults: DemoFault[];
}

/**
 * Where the listing is over HTTP, on the app's own origin, beside `API`. `github`: demo mode's GitHub web address
 * (`Connection.web`, ADR 0053), the service's fake of GitHub's pages (the new App, the install, a pull request), so
 * nothing demo mode or `proof` shows opens github.com.
 */
export const DEMO_API = { listing: "/api/v1/demo", github: "/api/v1/demo/github" } as const;
