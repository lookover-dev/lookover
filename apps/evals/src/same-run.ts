// One run behind a report (ADR 0050): every session of an engine on the same CLI version and the same model, so the
// numbers compare setups, never two versions of a CLI. Pure: `--keep` asks it before it keeps a run's answers, and
// `writeReport` before it reports.
import type { EngineId } from "@lookover/contracts";
import { isRead, type SessionCli, type SessionName, type SessionRecord } from "./types.ts";

/** What a session's CLI says besides its engine: each must be one value per engine. */
const ON = { version: true, model: true } satisfies Record<Exclude<keyof SessionCli, "name">, true>;
type On = keyof typeof ON;
const isOn = (key: string): key is On => Object.hasOwn(ON, key);

/**
 * Whether sessions are one run: `same`; `unknown`, the first engine with sessions whose version or model wasn't
 * read, and which; or `mixed`, the first engine whose sessions differ, on what, and every value seen.
 */
export type SameRun =
  | { kind: "same" }
  | { kind: "unknown"; engine: EngineId; on: On; sessions: SessionName[] }
  | { kind: "mixed"; engine: EngineId; on: On; values: string[] };

/**
 * Whether the answers kept from `sessions` ran on one CLI version and one model per engine. Only a session whose
 * answer was read counts: a confirm with nothing to judge ran on none, and a failed one's answer isn't kept. An
 * unknown version or model is refused: it can't be shown to be the others'.
 */
export function sameRun(sessions: readonly SessionRecord[]): SameRun {
  const ran = sessions.filter(isRead).map((s) => ({ session: s.session, cli: s.cli }));
  for (const engine of new Set(ran.map((r) => r.cli.name))) {
    const own = ran.filter((r) => r.cli.name === engine);
    for (const on of Object.keys(ON).filter(isOn)) {
      const unknown = own.filter((r) => r.cli[on] === null).map((r) => r.session);
      if (unknown.length > 0) return { kind: "unknown", engine, on, sessions: unknown };
      const values = [...new Set(own.flatMap((r) => r.cli[on] ?? []))];
      if (values.length > 1) return { kind: "mixed", engine, on, values };
    }
  }
  return { kind: "same" };
}

/** Why sessions that aren't one run make no report, in a sentence; null when they are one run. */
export function sameRunRefusal(same: SameRun): string | null {
  switch (same.kind) {
    case "same":
      return null;
    case "mixed":
      return `The sessions ran on more than one ${same.on} of ${same.engine}: ${same.values.join(", ")}. A report is made from one run.`;
    case "unknown":
      return `The ${same.on} of ${same.engine} isn't known for ${same.sessions.join(", ")}: a report is made from one run, every session on a known version and model.`;
  }
}
