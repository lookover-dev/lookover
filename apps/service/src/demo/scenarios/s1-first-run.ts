// S1 "First run" (ADR 0046, 0047, 0053): the owner opens Lookover for the first time. Claude is ready, Codex signed
// out; Lookover keeps no App yet, so GitHub lists nothing. The owner signs Codex in (the scripted engine is signed in
// a few seconds on), makes the App and installs it on their three repositories ("Create it on GitHub": the manifest
// flow, on GitHub's fake pages in a new tab, the App kept in the room's App store), keeps ledger-api on and asks for a
// first review of #148, opened by their agent before Lookover watched it, with "Preview here only": the round runs as
// any other (Codex finds, Claude double-checks) and nothing reaches GitHub. #148 is S2's. The other path: the App
// made on another computer, lookover-spike-sasensi (id 1, installed on all three), given under "Use an existing App"
// with a key from its fake page.
import { DEMO_API } from "@lookover/contracts";
import type { Scenario } from "../scenario.ts";
import { LEDGER_API, MIN } from "./ledger-api.ts";
import { RATE_LIMITING } from "./s2-happy-loop.ts";

export const S1: Scenario = {
  id: "S1",
  title: "First run",
  what: "Lookover's first start: sign Codex in, make your App, pick the repositories, preview a first review.",
  steps: [
    "Sign in to Codex: it is ready a few seconds later.",
    "Go on to GitHub and create your App: GitHub's page opens in a new tab and makes it. Install it there on all repositories; the three appear a few seconds later. Install it on none, and the step says nothing was granted.",
    `Or use the App made on another computer: its page, ${DEMO_API.github}/settings/apps/lookover-spike-sasensi, gives its id (1) and a new key to download; give both under "Advanced: use an existing App".`,
    'Or the App ledger-co\'s admin handed you: id 7, its key a file holding "fake-key-1-of-app-7" between "-----BEGIN RSA PRIVATE KEY-----" and "-----END RSA PRIVATE KEY-----" lines. It is refused while gh is signed out; after "You sign in to gh", because you aren\'t a member of ledger-co.',
    "Keep ledger-api on and go on.",
    "Pick #148 for the first review, with Preview here only, and watch it run. Nothing is posted on GitHub.",
  ],
  later: "",
  path: "/setup",
  world: {
    ...LEDGER_API,
    repositories: [
      { owner: "sasensi", name: "ledger-web" },
      { owner: "sasensi", name: "invoice-pdf" },
    ],
    engines: {
      ...LEDGER_API.engines,
      codex: { installed: true, version: "0.162.1", signedIn: false },
    },
    setup: {
      done: false,
      step: "ai",
      reached: "ai",
      github: "start",
      githubRefused: null,
      firstReviewChange: null,
    },
  },
  changes: [RATE_LIMITING],
  script: [{ at: MIN, move: { kind: "open", change: 148 } }],
  seed: 2 * MIN,
};
