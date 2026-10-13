// S7 "Too noisy?" (ADR 0046, ADR 0049): the owner opens #148's review, S2's pull request after its round 1 (three
// findings posted), and asks "Too noisy?" on one. Here ledger-api's main holds a REVIEW.md, and the page size not
// capped follows its rule, so that finding offers every choice: this finding is wrong (ADR 0052: dismissed here and
// on the fake GitHub, its thread answered, the summary and the check rewritten), turn the rule off, or post only
// blocking findings in ledger-api, each of the last two with what it would have removed from the repository's last
// reviews (this one round), written to ledger-api's settings file in the room's folder, as in live mode.
import type { Scenario, ScenarioChange } from "../scenario.ts";
import { LEDGER_API, MIN } from "./ledger-api.ts";
import { RATE_LIMITING } from "./s2-happy-loop.ts";

/** main's rules (ADR 0048): the uncapped page size follows the first. */
const REVIEW_MD = [
  "# Review rules",
  "",
  "- A list endpoint caps the page size it accepts.",
  "- Every response that fails says why in its body.",
  "",
].join("\n");

const [OPENED, ...PUSHED] = RATE_LIMITING.commits;
if (!OPENED.find) throw new Error("S2's #148 has no find pass at its first commit");

/** #148 as S2 opens it, its uncapped page size citing the first rule. */
const CITING: ScenarioChange = {
  ...RATE_LIMITING,
  commits: [
    {
      ...OPENED,
      find: {
        ...OPENED.find,
        findings: OPENED.find.findings.map((f) =>
          f.defectKey === "page_size_uncapped" ? { ...f, rule: "R1" } : f,
        ),
      },
    },
    ...PUSHED,
  ],
};

export const S7: Scenario = {
  id: "S7",
  title: "Too noisy?",
  what: "A review with three findings. Ask Too noisy? on one and see what Lookover offers.",
  steps: [
    "#148's review is open: round 1 posted three findings.",
    "On The page size is not capped, which follows a rule of ledger-api, pick Too noisy?",
    "Mark it as wrong: it is dismissed here and on GitHub.",
    "Or turn off the rule, or post only blocking findings in ledger-api: either is saved in its settings.",
  ],
  later: "",
  path: "/reviews/ledger-api/148",
  world: { ...LEDGER_API, rules: [{ path: "REVIEW.md", text: REVIEW_MD }] },
  changes: [CITING],
  script: [{ at: MIN, move: { kind: "open", change: 148 } }],
  seed: 6 * MIN,
};
