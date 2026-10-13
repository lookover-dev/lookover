// The web app's mode, set at build time (ADR 0046, ADR 0054): `demo`, the service on scripted fakes (`bun dev`, and
// a build that names no mode); `live`, the service on the real GitHub App, `claude` and `codex` (`bun dev --live`);
// `program`, the app the program serves (`bun run build:program`), for its owner rather than its developer. What
// each mounts of the developer's tools is decided in `tools.tsx`, loaded only by a build that is not the program's,
// so the program's bundle carries neither the drawer nor the demo client.

export type WebMode = "demo" | "live" | "program";

const MODES = { demo: true, live: true, program: true } satisfies Record<WebMode, true>;

const isMode = (value: string): value is WebMode => Object.hasOwn(MODES, value);

/** The mode a build names (`VITE_LOOKOVER_MODE`): demo when it names none; one the app doesn't know fails. */
export function modeOf(named: string | undefined): WebMode {
  if (named === undefined || named === "") return "demo";
  if (!isMode(named)) throw new Error(`Unknown mode ${named}: demo, live or program`);
  return named;
}

/** Whether `?scenario=S4` loads that scenario before the app reads anything: demo mode's alone. */
export const scenarioFromAddress = (mode: WebMode): boolean => mode === "demo";
