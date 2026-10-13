// A round's row in the review's details (ADR 0055): who found and who double-checked it, and what its sessions
// used in tokens. No cost and no percentage: the plan's figures are the CLI's tokens alone.
import { engineName, findersText, type Round, shortSha } from "@lookover/contracts";

/** What the Rounds table shows of a round beside its counts and its time. */
export interface RoundRow {
  /** Its commit's first seven characters, as GitHub shortens it: the table keeps its columns in view. */
  commit: string;
  /** "Codex → Claude": the finders (Deep's second when its pass answered), then the confirmer when it answered. */
  by: string;
  /** "21k in · 1.6k out", every session's summed; "—" when no session's CLI said any. */
  tokens: string;
}

/** `v` of a unit: one decimal below ten ("1.6k", "1k"), whole above ("21k"). */
const scaled = (v: number, unit: string): string =>
  v < 9.95 ? `${Number(v.toFixed(1))}${unit}` : `${Math.round(v)}${unit}`;

/** A token count as the table says it: "950", "1.6k", "21k", "1.3M". */
function count(n: number): string {
  if (n < 1_000) return `${n}`;
  if (n < 999_500) return scaled(n / 1_000, "k");
  return scaled(n / 1_000_000, "M");
}

/** A round's finders, Deep's second only when its pass answered. */
export function roundFinders(round: Round): string {
  const second = round.secondFind;
  return findersText(round.reviewer, second === null || second.failure !== null ? null : second.engine);
}

function tokens(round: Round): string {
  const used = round.sessions.flatMap((s) => (s.usage === null ? [] : [s.usage]));
  if (used.length === 0) return "—";
  const input = used.reduce((sum, u) => sum + u.inputTokens, 0);
  const output = used.reduce((sum, u) => sum + u.outputTokens, 0);
  return `${count(input)} in · ${count(output)} out`;
}

export function roundRow(round: Round): RoundRow {
  // A confirm session that gave no answer double-checked nothing: the details' "Double-checked by" says why.
  const checker = round.confirmFailure === null ? round.confirmer : null;
  return {
    commit: shortSha(round.sha),
    by: checker === null ? roundFinders(round) : `${roundFinders(round)} → ${engineName(checker)}`,
    tokens: tokens(round),
  };
}
