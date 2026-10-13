// The snapshot: everything the UI shows, as the service sends it.
import type { Change } from "./change.ts";
import type { Connection } from "./connection.ts";
import type { Engine, EngineId } from "./engine.ts";
import type { ChangeId } from "./ids.ts";
import type { DepartedRepository, Repository } from "./repository.ts";
import type { Review } from "./review.ts";
import type { Rule } from "./rule.ts";
import type { Service } from "./service.ts";
import type { ResolvedSettings } from "./settings.ts";
import type { Setup } from "./setup.ts";

export interface State {
  /** The number of the last event this snapshot includes: it is current up to that event (ADR 0038). */
  seq: number;
  now: number;
  setup: Setup;
  engines: Record<EngineId, Engine>;
  connection: Connection;
  service: Service;
  /** The owner's defaults, over Lookover's. Each repository has its own, over these. */
  settings: ResolvedSettings;
  repos: Repository[];
  /** The repositories the installation stopped listing (ADR 0059), the earliest gone first: said until back or dismissed. */
  departed: DepartedRepository[];
  rules: Rule[];
  changes: Record<ChangeId, Change>;
  reviews: Record<ChangeId, Review>;
}
