// Lookover in the tray (ADR 0105 §8): a port, `Tray`, that starts an icon on the desktop and gives a running tray to
// show what it is told (`TrayView`, the pill's words from `@lookover/web/tray`) and to stop, or the reason it can't
// run. It hands each click to `onClick` and its own end, with why, to `onEnd`: never after `stop`, and once at most.
// Starting it again after an end is the keeper's rule (`tray-keeper.ts`), not the port's. The fake keeps what it was
// told in memory and can click, end or answer unavailable, for demo mode and the tests; live mode and a guarded program
// have the stand-in, which shows nothing and says so: a check never puts an icon on the owner's screen (ADR 0045). The
// program without a live config has the real one, `lookover-tray` (`helper-tray.ts`).
import type { TrayView } from "@lookover/web/tray";

/** What the tray's menu can be clicked on (ADR 0105 §4, §10), as the helper names it. */
export type TrayItem = "open" | "pause.hour" | "pause.tomorrow" | "pause.forever" | "resume" | "quit";

/** A tray that runs: an icon on the desktop. */
export interface RunningTray {
  /**
   * Shows `view`: the icon's state, its tooltip, the menu's line and Pause or Resume. Never throws (it is called
   * inside the room's `emit`): a tray that can't be told any more ends, through `onEnd`.
   */
  show(view: TrayView): void;
  /** Takes the icon away; its `onEnd` is never called after. */
  stop(): void;
}

export interface Tray {
  /**
   * Why this tray never runs: set by the development stand-in (`nowhereTray`) only, so a check's start logs and sends
   * nothing for a tray that was never meant to show. It is then never started; `Service.tray` says it unavailable with
   * this reason from the start's first state. A real tray never sets it, even when it knows it can't run: its `start`
   * answers `{ unavailable }`, and the keeper logs why.
   */
  readonly never?: string;
  /**
   * Starts the icon: a running tray, or why it can't run (no helper, a refused version, no desktop, no tray host),
   * which the keeper logs. `onClick` hears each item clicked; `onEnd` the tray's own end, with why, once, never after
   * `stop`.
   */
  start(
    onClick: (item: TrayItem) => void,
    onEnd: (reason: string) => void,
  ): Promise<RunningTray | { unavailable: string }>;
}

/**
 * The fake: the tray in memory. `views` is every view shown, in order, across its runs; `running` whether a tray runs
 * now. `click` clicks an item of the running tray, `end` ends it by itself with `reason`; `unavailable(reason)` makes
 * each start answer that it can't run, until `null`.
 */
export interface MemoryTray extends Tray {
  views(): TrayView[];
  running(): boolean;
  click(item: TrayItem): void;
  end(reason: string): void;
  unavailable(reason: string | null): void;
}

/** The running fake's ends: what a click and an end reach. */
interface Run {
  onClick: (item: TrayItem) => void;
  onEnd: (reason: string) => void;
}

export function memoryTray(): MemoryTray {
  const views: TrayView[] = [];
  let run: Run | null = null;
  let refused: string | null = null;
  return {
    start: (onClick, onEnd) => {
      if (refused !== null) return Promise.resolve({ unavailable: refused });
      const own: Run = { onClick, onEnd };
      run = own;
      return Promise.resolve({
        show: (view) => {
          if (run === own) views.push(view);
        },
        stop: () => {
          if (run === own) run = null;
        },
      });
    },
    views: () => [...views],
    running: () => run !== null,
    click: (item) => run?.onClick(item),
    end: (reason) => {
      const ended = run;
      run = null;
      ended?.onEnd(reason);
    },
    unavailable: (reason) => {
      refused = reason;
    },
  };
}

/** Why the stand-in shows nothing in live mode and a guarded program, as `Service.tray` says it. */
const NOWHERE_REASON = "Lookover shows no tray icon while it runs for development";

/**
 * The stand-in, for live mode and a guarded program (ADR 0070): it never runs (`never`, with `reason`), so the
 * snapshot says no icon is shown from the start, and the log says nothing.
 */
export function nowhereTray(reason = NOWHERE_REASON): Tray {
  return { never: reason, start: () => Promise.resolve({ unavailable: reason }) };
}
