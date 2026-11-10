// What a failed panel says (ADR 0085, design-system.md "Failed panel"): the place that couldn't be shown, in one line,
// and the one way back, a reload. Each place an error boundary stands names itself here.

/** A place that renders inside an error boundary of its own. */
export type FailedPlace =
  | "app"
  | "page"
  | "setup"
  | "status"
  | "status-menu"
  | "palette"
  | "dialog"
  | "alerts";

const PLACE = {
  app: "Lookover",
  page: "This page",
  setup: "Setup",
  status: "The status",
  "status-menu": "The status menu",
  palette: "The palette",
  dialog: "This dialog",
  alerts: "The alerts",
} satisfies Record<FailedPlace, string>;

/** The line a failed place says: "The status menu couldn't be shown." */
export const failedLine = (place: FailedPlace): string => `${PLACE[place]} couldn't be shown.`;

/** The status pill's own words when it failed: one line in the pill, whose click reloads. */
export const FAILED_PILL = "Status failed · Reload";

/** The one action a failed place offers. */
export const RELOAD = "Reload";
