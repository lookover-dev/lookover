// S5 "Skipped on purpose" (ADR 0046): Lookover reviews the owner's pull requests by itself, and nobody else's unless
// the owner asks (ADR 0016, ADR 0078), and never a fork's by itself (ADR 0048). Twenty seconds after the load
// dependabot opens #150, a version bump; twenty seconds later the owner opens #153 from their fork; a minute after
// #150 Mira, a colleague, opens #152 from her fork. #150 and #152 get nothing: no job, no check, nothing posted. #153
// is skipped as a fork as it opens, its check saying why. Nothing runs: no engine is asked. Review now on any of the
// three runs a short scripted review with nothing found (#574).
import { commitSha } from "@lookover/contracts";
import { on, type Scenario, type ScenarioChange } from "../scenario.ts";
import { DEPENDABOT, LEDGER_API, MIN, MIRA, OWNER, SHORT_FIND_MS, unified } from "./ledger-api.ts";

const BUMP: ScenarioChange = {
  number: 150,
  title: "Bump express from 4.19.2 to 4.21.0",
  branch: "dependabot/npm_and_yarn/express-4.21.0",
  author: DEPENDABOT,
  commits: [
    {
      sha: commitSha("d4e5f6a8b0c2d4e6f8a0b2c4d6e8f0a2b4c6d8e0"),
      message: "Bump express from 4.19.2 to 4.21.0\n\nSigned-off-by: dependabot[bot] <support@github.com>",
      diff: unified(
        "diff --git a/package.json b/package.json",
        "--- a/package.json",
        "+++ b/package.json",
        "@@ -9,6 +9,6 @@",
        '   "dependencies": {',
        '     "pino": "^9.4.0",',
        '-    "express": "^4.19.2",',
        '+    "express": "^4.21.0",',
        '     "zod": "^3.23.8"',
        "   },",
        '   "devDependencies": {',
      ),
      // Asked for by hand ("Review now"), Claude reviews the bump (ADR 0078).
      find: {
        notes: "Express moves from 4.19.2 to 4.21.0, a minor version.",
        findings: [],
        emptyReason: "A minor bump of one dependency, with no change to the code that calls it.",
        tookMs: SHORT_FIND_MS,
      },
    },
  ],
};

const RETRIES: ScenarioChange = {
  number: 152,
  title: "Retry failed webhook deliveries",
  branch: "mira/webhook-retries",
  author: MIRA,
  fork: true,
  commits: [
    {
      sha: commitSha("e5f6a7b9c1d3e5f7a9b1c3d5e7f9a1b3c5d7e9f1"),
      message: "Retry failed webhook deliveries",
      diff: unified(
        "diff --git a/src/webhooks/deliver.ts b/src/webhooks/deliver.ts",
        "--- a/src/webhooks/deliver.ts",
        "+++ b/src/webhooks/deliver.ts",
        "@@ -12,4 +12,7 @@ export async function deliver(hook: Webhook, body: string) {",
        '   const res = await fetch(hook.url, { method: "POST", body });',
        '-  if (!res.ok) logger.warn("delivery failed", hook.id);',
        "+  if (!res.ok) {",
        '+    logger.warn("delivery failed", hook.id);',
        "+    await retries.schedule(hook.id, body);",
        "+  }",
        "   return res.ok;",
        " }",
      ),
      // Asked for by hand ("Review now"), Claude alone reviews the fork (ADR 0048).
      find: {
        notes: "A failed delivery is scheduled again.",
        findings: [],
        emptyReason: "The retry runs only on a failed delivery, with the same body.",
        tookMs: SHORT_FIND_MS,
      },
    },
  ],
};

const PINNED: ScenarioChange = {
  number: 153,
  title: "Pin the Node version in CI",
  branch: "sasensi/pin-node",
  author: OWNER,
  fork: true,
  commits: [
    {
      sha: commitSha("f6a7b8c0d2e4f6a8b0c2d4e6f8a0b2c4d6e8f0a3"),
      message: "Pin the Node version in CI",
      diff: unified(
        "diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml",
        "--- a/.github/workflows/ci.yml",
        "+++ b/.github/workflows/ci.yml",
        "@@ -10,4 +10,4 @@ jobs:",
        "       - uses: actions/setup-node@v4",
        "         with:",
        "-          node-version: lts/*",
        "+          node-version: 22.11.0",
        "       - run: npm ci",
      ),
      // Asked for by hand ("Review now"), Claude alone reviews the fork (ADR 0048).
      find: {
        notes: "CI runs on Node 22.11.0 instead of the latest LTS.",
        findings: [],
        emptyReason: "One pinned version in the workflow, and nothing else changes.",
        tookMs: SHORT_FIND_MS,
      },
    },
  ],
};

/** A pull request of the world's repository, by its number. */
const pr = on(LEDGER_API.repo);

export const S5: Scenario = {
  id: "S5",
  title: "Skipped on purpose",
  what: "Dependabot opens a pull request, a colleague opens one from her fork, and you open one from your fork. Lookover posts nothing on theirs, and skips yours, saying why.",
  steps: [
    "Wait for dependabot's #150 to appear, or press Step to the next event. Nothing is posted on it: Lookover reviews someone else's pull request only when you ask.",
    "Your #153 appears next, from your fork. It is marked Skipped: open it and read why.",
    "A minute after #150, Mira's #152 appears, from her fork. Nothing is posted on it either.",
  ],
  later: "",
  path: "/",
  world: LEDGER_API,
  changes: [BUMP, RETRIES, PINNED],
  script: [
    { at: MIN + 20_000, move: { kind: "open", change: pr(150) } },
    { at: MIN + 40_000, move: { kind: "open", change: pr(153) } },
    { at: 2 * MIN + 20_000, move: { kind: "open", change: pr(152) } },
  ],
  seed: MIN,
};
