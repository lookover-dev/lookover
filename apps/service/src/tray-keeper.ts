// Lookover in the tray, as the service keeps it (ADR 0105 §8-12): the owner's choice, kept by the store (on until
// they turn it off), and the icon (`Tray`) made to match it from the service's start: started while the choice is on,
// stopped at once when it turns off. The icon is told the pill's words (`trayView` of the UI's state) whenever they
// change, never on an event that leaves them as they were, and told them again whole when it starts again. An icon
// that ends by itself is started again once; a second end leaves it unavailable, with its reason, until the choice
// is turned on again or the service restarts; each end is logged. What the machine shows is sent as
// `service.changed { tray }` whenever it differs from what the UI shows. Each click of the icon running now is handed
// to `clicked`: what it does is the room's (`trayClicks`).
// It must never know: which machine, or whether its `Tray` is the real one, the fake or the stand-in.
import { isDeepStrictEqual } from "node:util";
import type { Clock, EventBody, ServiceTray, State } from "@lookover/contracts";
import type { Store } from "@lookover/store";
import { type TrayView, trayView } from "@lookover/web/tray";
import { said } from "./said.ts";
import type { RunningTray, Tray, TrayItem } from "./tray.ts";

interface TrayKeeperDeps {
  tray: Tray;
  store: Pick<Store, "setup">;
  clock: Clock;
  emit(body: EventBody): void;
  /** The UI's state now. */
  state(): State;
  log(line: string): void;
  /** Where each click of the icon running now goes. */
  clicked(item: TrayItem): void;
}

export interface TrayKeeper {
  /** At the service's start: the icon started when the choice is on. */
  begin(): void;
  /** After each event: the icon told the pill's words, when they moved. */
  moved(): void;
  /** `service.tray`: the choice kept and sent; off stops the icon at once, on starts it (again, if it gave up). */
  choose(on: boolean): void;
  /** The service stops: the icon is taken away, and nothing it says after is heard. */
  stop(): void;
}

/**
 * What `Service.tray` is at a start (ADR 0105 §13): off when the choice is; else unavailable when `tray` can never run
 * (`Tray.never`), starting otherwise.
 */
export function trayAtStart(on: boolean, tray: Tray): ServiceTray {
  if (!on) return { on, shown: "off", reason: null };
  if (tray.never !== undefined) return { on, shown: "unavailable", reason: tray.never };
  return { on, shown: "starting", reason: null };
}

export function createTrayKeeper(d: TrayKeeperDeps): TrayKeeper {
  // Each start of the icon has its number: an answer, an end or a click of an earlier one is not heard.
  let current = 0;
  let running: RunningTray | null = null;
  /** The view the running icon was told last; null until it was told one. */
  let told: TrayView | null = null;
  /** Whether the icon was started again after an end, since the choice was turned on or the service started. */
  let restarted = false;
  let stopped = false;

  /** What the machine shows sent, when the UI shows otherwise. */
  const say = (patch: Partial<ServiceTray>): void => {
    if (stopped) return;
    const shown = d.state().service.tray;
    const tray = { ...shown, ...patch };
    if (!isDeepStrictEqual(shown, tray))
      d.emit({ type: "service.changed", at: d.clock.now(), patch: { tray } });
  };

  const moved = (): void => {
    if (running === null) return;
    const view = trayView(d.state());
    if (isDeepStrictEqual(view, told)) return;
    told = view;
    running.show(view);
  };

  /** Whatever runs taken away, and every answer of it not heard. */
  const drop = (): void => {
    current++;
    running?.stop();
    running = null;
    told = null;
  };

  const unavailable = (reason: string): void => {
    d.log(`The tray icon can't be shown: ${reason}`);
    say({ shown: "unavailable", reason });
  };

  const ended = (reason: string): void => {
    drop();
    if (!restarted) {
      restarted = true;
      d.log(`The tray icon ended (${reason}): it is started again`);
      open();
      return;
    }
    d.log(
      `The tray icon ended again (${reason}): it isn't started again until Lookover restarts or the choice is turned on`,
    );
    say({ shown: "unavailable", reason });
  };

  const open = (): void => {
    drop();
    // Starting, or unavailable as at a start: a tray that can never run is never started, said, not logged.
    const { shown, reason } = trayAtStart(true, d.tray);
    say({ shown, reason });
    if (shown !== "starting") return;
    const mine = current;
    const heard = () => mine === current && !stopped;
    d.tray
      .start(
        (item) => {
          if (heard()) d.clicked(item);
        },
        (reason) => {
          if (heard()) ended(reason);
        },
      )
      .then(
        (answer) => {
          if (!heard()) {
            if ("stop" in answer) answer.stop();
            return;
          }
          if ("unavailable" in answer) {
            unavailable(answer.unavailable);
            return;
          }
          running = answer;
          say({ shown: "shown", reason: null });
          moved();
        },
        (error: unknown) => {
          if (heard()) unavailable(said(error));
        },
      );
  };

  return {
    begin: () => {
      if (d.store.setup.tray()) open();
    },
    moved,
    choose: (on) => {
      d.store.setup.keepTray(on);
      if (!on) {
        drop();
        say({ on: false, shown: "off", reason: null });
        return;
      }
      const { shown } = d.state().service.tray;
      say({ on: true });
      if (shown === "shown" || shown === "starting") return;
      restarted = false;
      open();
    },
    stop: () => {
      drop();
      stopped = true;
    },
  };
}
