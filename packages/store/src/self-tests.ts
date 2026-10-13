// The engines' self-tests (ADR 0044): "did this program, at this version, pass", "it ran, and passed or not".
// One result per engine, program and version: the last one kept.
import type { Database } from "bun:sqlite";
import type { EngineId } from "@lookover/contracts";
import { z } from "zod";

/** What a self-test's result is kept under: the engine, the program it ran (as the engines name it), its version. */
export interface TestedProgram {
  engine: EngineId;
  program: string;
  version: string;
}

export interface SelfTestResults {
  /** The last result kept for this program; null when it was never tested. */
  result(tested: TestedProgram): { passed: boolean } | null;
  /** The program's self-test ended, passed or not: kept, replacing any earlier result. */
  ran(tested: TestedProgram, passed: boolean): void;
}

const row = z.object({ passed: z.union([z.literal(0), z.literal(1)]) });

export function selfTests(db: Database): SelfTestResults {
  const select = db.query("SELECT passed FROM self_tests WHERE engine = ? AND program = ? AND version = ?");
  const upsert = db.query(
    "INSERT INTO self_tests (engine, program, version, passed) VALUES (?, ?, ?, ?) ON CONFLICT (engine, program, version) DO UPDATE SET passed = excluded.passed",
  );
  return {
    result: ({ engine, program, version }) => {
      const found = select.get(engine, program, version);
      return found === null ? null : { passed: row.parse(found).passed === 1 };
    },
    ran: ({ engine, program, version }, passed) => {
      upsert.run(engine, program, version, passed ? 1 : 0);
    },
  };
}
