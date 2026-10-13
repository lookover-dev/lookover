// The world S1 to S7 play in (ADR 0046): the owner's `ledger-api`, an invoicing API, the one repository each of
// them watches, with its owner, its bot, the people who open pull requests on it and both engines ready. What
// differs per scenario (an engine signed out, the setup not done) is spread over this. The helpers write a diff
// as git prints it; every diff of these scenarios is hand-written fixture data, nothing here is a recording. S8 to
// S13 play on this world moved to another repository (`SANDBOX`, `sandbox.ts`); S8 to S14 share its people,
// `MIN`, the runs' durations and the diff helpers.
import { commitSha } from "@lookover/contracts";
import type { Account, World } from "../scenario.ts";

export const MIN = 60_000;

/** How long a round-1 find pass takes on the clock, and the confirm pass that follows it. */
export const FIND_MS = 130_000;
export const CONFIRM_MS = 58_000;
/** A shorter find pass: a later round's (the diff is known) or a round 1 on a few lines. */
export const SHORT_FIND_MS = 75_000;

export const OWNER: Account = { id: 1, login: "sasensi" };
export const DEPENDABOT: Account = { id: 49699333, login: "dependabot[bot]" };
export const MIRA: Account = { id: 7, login: "mira" };

export const LEDGER_API: World = {
  repo: { owner: "sasensi", name: "ledger-api" },
  bot: { id: 2, login: "lookover-spike-sasensi[bot]" },
  owner: OWNER,
  engines: {
    claude: { installed: true, version: "2.4.1", signedIn: true },
    codex: { installed: true, version: "0.162.1", signedIn: true },
  },
  main: { ref: "main", sha: commitSha("0c4e1b7a9d2f3e5c6b8a0d1f2e3c4b5a6d7e8f90") },
};

/** The trailer Claude Code signs its commits with: who wrote a change (`core.writerOf`). */
export const BY_CLAUDE = "Co-Authored-By: Claude <noreply@anthropic.com>";

/** The lines of a diff, joined as git prints them, with the final line end. */
export const unified = (...lines: string[]) => `${lines.join("\n")}\n`;

/** A new file's diff: every one of `lines` added. */
export const added = (path: string, lines: string[]) =>
  unified(
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  );
