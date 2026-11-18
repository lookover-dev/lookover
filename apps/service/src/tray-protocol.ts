// The tray helper's facts the service shares with the release scripts (ADR 0105 §4-5): its file name and the reading
// of its first line, at the protocol this service speaks. The service reads them (`helper-tray.ts`) and exports the
// file name (`index.ts`); the scripts that run where nothing was installed (the public release.yml's `verify` job runs
// `release-smoke.ts` with no `bun install`) import this file by its relative path. So it imports nothing, not even a
// `node:` module.

/** What the helper's first line must name: the protocol this service speaks (ADR 0105 §4). */
const PROTOCOL = 1;

/** The helper's file name on `os` (`process.platform`'s word: `win32`, `darwin`, `linux`). */
export const trayHelperName = (os: string): string =>
  os === "win32" ? "lookover-tray.exe" : "lookover-tray";

/**
 * What the helper's first line says (ADR 0105 §4-5): `ready` at `version` and `PROTOCOL`; `unavailable` with the
 * reason it gives, when it can't show an icon; else why it is refused, `stale` when it is ready but of another build
 * (another version or protocol), which `bun run build` makes again.
 */
export type TrayFirstLine = { ready: true } | { unavailable: string } | { refused: string; stale: boolean };

/** What the helper's first `line` says, for a program of `version`. */
export function readTrayFirstLine(line: string, version: string): TrayFirstLine {
  let said: unknown;
  try {
    said = JSON.parse(line);
  } catch {
    said = null;
  }
  const other = { refused: `lookover-tray said something else than ready: ${line}`, stale: false };
  if (typeof said !== "object" || said === null || !("type" in said)) return other;
  if (said.type === "unavailable" && "reason" in said && typeof said.reason === "string")
    return { unavailable: said.reason };
  if (said.type !== "ready") return other;
  const named = "version" in said ? String(said.version) : "none";
  if (named !== version) return { refused: `lookover-tray is version ${named}, not ${version}`, stale: true };
  if (!("protocol" in said) || said.protocol !== PROTOCOL) {
    const protocol = "protocol" in said ? JSON.stringify(said.protocol) : "none";
    return { refused: `lookover-tray speaks protocol ${protocol}, not ${PROTOCOL}`, stale: true };
  }
  return { ready: true };
}
