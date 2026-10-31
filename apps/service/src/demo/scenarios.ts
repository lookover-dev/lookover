// Every scenario the demo plays (ADR 0046), in the order the developer drawer lists them, S1 to S17. One module
// per scenario; S10 "A quiet day" is the one the demo opens on. A scenario's id is what `--scenario=<id>`,
// `?scenario=<id>` and `demo.load` name.

import type { Scenario } from "./scenario.ts";
import { S1 } from "./scenarios/s1-first-run.ts";
import { S2 } from "./scenarios/s2-happy-loop.ts";
import { S3 } from "./scenarios/s3-signed-out.ts";
import { S4 } from "./scenarios/s4-keeps-asking.ts";
import { S5 } from "./scenarios/s5-skipped.ts";
import { S6 } from "./scenarios/s6-new-commits.ts";
import { S7 } from "./scenarios/s7-too-noisy.ts";
import { S8 } from "./scenarios/s8-pause-and-resume.ts";
import { S9 } from "./scenarios/s9-one-repository.ts";
import { S10 } from "./scenarios/s10-quiet-day.ts";
import { S11 } from "./scenarios/s11-phone-glance.ts";
import { S12 } from "./scenarios/s12-keyboard.ts";
import { S13 } from "./scenarios/s13-service-problems.ts";
import { S14 } from "./scenarios/s14-planted-sandbox.ts";
import { S15 } from "./scenarios/s15-organisation.ts";
import { S16 } from "./scenarios/s16-two-accounts.ts";
import { S17 } from "./scenarios/s17-every-account.ts";

export const SCENARIOS: Scenario[] = [
  S1,
  S2,
  S3,
  S4,
  S5,
  S6,
  S7,
  S8,
  S9,
  S10,
  S11,
  S12,
  S13,
  S14,
  S15,
  S16,
  S17,
];

/** The scenario with this id. Throws, naming every id, for one that isn't. */
export function scenarioOf(id: string): Scenario {
  const found = SCENARIOS.find((s) => s.id === id);
  if (!found) throw new Error(`No scenario ${id}. The scenarios: ${SCENARIOS.map((s) => s.id).join(", ")}.`);
  return found;
}
