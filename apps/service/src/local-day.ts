// The machine's local calendar day, as the log file writes it: its file names, its stamps and the dates in its lines.
import { twoDigits } from "@lookover/contracts";

/** The local day of `at`: "2026-10-11". */
export function localDay(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`;
}
