// `@lookover/web/tray`: the tray's words, for the service (ADR 0105 §9). The view-model owns every word the app says
// about the service's state, so the tray icon's state, its tooltip and its menu's line come from here, read off the
// same `State` the app reads: the tray says what the pill says. Pure: no React, no DOM, no I/O at run time, so the
// service imports it as it imports any package.
//
// `trayView(state)` says only the worst of, in order: setup not done (`needs-you`, "Finish setting up": the pill's
// problems wait for setup, and setup is when someone closes the tab and needs the way back), a problem (the pill's
// tone `need` or `warn`, its own label), a pause, the person's own pull requests that need them (as Home's sentence
// counts them), a review running (anyone's: it is what the service is doing), else all good. The app says the rest.
// The tooltip is "Lookover: " and the line, cut with an ellipsis to Windows' 127 characters; `paused` says whether
// the menu offers Resume rather than Pause, whatever the line says.
import type { State } from "@lookover/contracts";
import { changeLabel, homeGroups, needsWords, pauseUntil, pill } from "./view-model/select.ts";

/** The tray icon's states, worst first (ADR 0105 §9). */
export type TrayState = "problem" | "paused" | "needs-you" | "reviewing" | "idle";

export interface TrayView {
  state: TrayState;
  /** "Lookover: " and the line, at most `TOOLTIP_MAX` characters. */
  tooltip: string;
  /** The menu's line, not clickable. */
  line: string;
  /** Whether reviews are paused: the menu offers Resume reviews, else Pause reviews. */
  paused: boolean;
}

/** Windows' limit on a notification icon's tooltip (`szTip` holds 128 UTF-16 units with its terminator). */
const TOOLTIP_MAX = 127;

export function trayView(state: State): TrayView {
  const [kind, line] = worst(state);
  return {
    state: kind,
    tooltip: cut(`Lookover: ${line}`),
    line,
    paused: state.service.paused !== null,
  };
}

/**
 * The text whole if it fits `TOOLTIP_MAX` UTF-16 units, else its first characters within one less and "…", so a cut
 * reads as cut. Cut on code points: a lone surrogate would make the helper's JSON reader reject the line.
 */
function cut(text: string): string {
  if (text.length <= TOOLTIP_MAX) return text;
  let kept = "";
  for (const char of text) {
    if (kept.length + char.length > TOOLTIP_MAX - 1) break;
    kept += char;
  }
  return `${kept}…`;
}

function worst(state: State): [TrayState, string] {
  if (!state.setup.done) return ["needs-you", "Finish setting up"];
  const { tone, label } = pill(state);
  if (tone === "need" || tone === "warn") return ["problem", label];
  const pausedFor = pauseUntil(state);
  if (pausedFor) return ["paused", `Paused ${pausedFor}`];
  const needs = needsWords(homeGroups(state, "mine").needs);
  if (needs) return ["needs-you", needs];
  const running = homeGroups(state, "everyone").running;
  const [only] = running;
  if (running.length === 1 && only) return ["reviewing", `Reviewing ${changeLabel(only.change)}`];
  if (running.length > 1) return ["reviewing", `Reviewing ${running.length} pull requests`];
  return ["idle", "All good"];
}
