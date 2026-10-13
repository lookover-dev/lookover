// S5 "Skipped on purpose" (ADR 0046): Lookover reviews the owner's pull requests only (ADR 0016), and never a fork's
// by itself (ADR 0048). Twenty seconds after the load dependabot opens #150, a version bump; a minute later Mira, a
// colleague, opens #152 from her fork. #150 is skipped as not yours, #152 as a fork, each as it opens with its check
// saying why, and nothing runs: no engine is asked.
import { commitSha } from "@lookover/contracts";
import type { Scenario, ScenarioChange } from "../scenario.ts";
import { DEPENDABOT, LEDGER_API, MIN, MIRA, SHORT_FIND_MS, unified } from "./ledger-api.ts";

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
      // Asked for by hand ("Review again"), Claude alone reviews the fork (ADR 0048).
      find: {
        notes: "A failed delivery is scheduled again.",
        findings: [],
        emptyReason: "The retry runs only on a failed delivery, with the same body.",
        tookMs: SHORT_FIND_MS,
      },
    },
  ],
};

export const S5: Scenario = {
  id: "S5",
  title: "Skipped on purpose",
  what: "Dependabot opens a pull request, and a colleague opens one from her fork. Lookover reviews neither by itself, and says why.",
  steps: [
    "Wait for dependabot's #150 to appear on Home, or press Step to the next event.",
    "A minute later Mira's #152 appears, from her fork. Both are marked Skipped.",
    "Open one and read why it wasn't reviewed.",
  ],
  later: "",
  path: "/",
  world: LEDGER_API,
  changes: [BUMP, RETRIES],
  script: [
    { at: MIN + 20_000, move: { kind: "open", change: 150 } },
    { at: 2 * MIN + 20_000, move: { kind: "open", change: 152 } },
  ],
  seed: MIN,
};
