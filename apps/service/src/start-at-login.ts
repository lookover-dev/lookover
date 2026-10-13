// Start at login, as the service keeps it (ADR 0054): the owner's choice, kept by the store (on until they turn it off),
// and the registration on the machine (`LoginItem`) made to match it once the setup is done, never before: at each
// start, when the setup is finished, and on each `service.startAtLogin`. A registration the machine refuses refuses
// that command with its reason and leaves the choice as it was; at a start or a finish, it is logged and the service
// goes on. What the machine says is sent as `service.changed { startsAtLogin }` whenever it differs from what the UI
// shows. One change at a time: each waits for the one before.
// It must never know: which machine, or whether its `LoginItem` is the real one or the fake.
import type { Clock, EventBody } from "@lookover/contracts";
import type { Store } from "@lookover/store";
import type { LoginItem } from "./login-item.ts";
import { said } from "./said.ts";

interface StartAtLoginDeps {
  item: LoginItem;
  store: Pick<Store, "setup">;
  clock: Clock;
  emit(body: EventBody): void;
  /** Whether the UI shows Lookover registered now. */
  shown(): boolean;
  log(line: string): void;
}

/** The owner's choice and the machine's registration, kept together. */
export interface StartAtLogin {
  /** The registration matched to the choice, if the setup is done, and what the machine then says sent. */
  match(): Promise<void>;
  /**
   * `service.startAtLogin`: the registration changed first (once the setup is done), then the choice kept and sent.
   * Refused with the machine's reason, the choice left as it was.
   */
  choose(on: boolean): Promise<"ok" | { refused: string }>;
  /** Settles once the change under way, if any, has. */
  idle(): Promise<void>;
}

/** Registers or removes the registration so that it is `want`; nothing when it already is. Rejects as the machine does. */
async function moveTo(item: LoginItem, want: boolean): Promise<void> {
  if ((await item.registered()) === want) return;
  await (want ? item.register() : item.unregister());
}

/** Whether the machine says Lookover is registered; false, logged, when it can't say. */
async function registeredNow(item: LoginItem, log: (line: string) => void): Promise<boolean> {
  try {
    return await item.registered();
  } catch (error) {
    log(`Can't tell whether Lookover starts at login: ${said(error)}`);
    return false;
  }
}

/**
 * At a start, before the UI's state is made: the registration matched to the kept choice once the setup is done (a
 * refusal logged), and whether Lookover is registered then.
 */
export async function matchedAtStart(
  item: LoginItem,
  store: Pick<Store, "setup">,
  log: (line: string) => void,
): Promise<boolean> {
  if (store.setup.read().done) {
    const want = store.setup.startAtLogin();
    try {
      await moveTo(item, want);
    } catch (error) {
      log(`Lookover couldn't ${want ? "register" : "remove"} its start at login: ${said(error)}`);
    }
  }
  return await registeredNow(item, log);
}

export function createStartAtLogin(d: StartAtLoginDeps): StartAtLogin {
  let last: Promise<unknown> = Promise.resolve();
  /** `op` once the change before it has settled. */
  const inTurn = <T>(op: () => Promise<T>): Promise<T> => {
    const done = last.then(op);
    last = done.catch(() => {});
    return done;
  };
  /** What the machine says now, sent when the UI shows otherwise. */
  const send = async (): Promise<void> => {
    const now = await registeredNow(d.item, d.log);
    if (now !== d.shown())
      d.emit({ type: "service.changed", at: d.clock.now(), patch: { startsAtLogin: now } });
  };
  return {
    match: () =>
      inTurn(async () => {
        await matchedAtStart(d.item, d.store, d.log);
        await send();
      }),
    choose: (on) =>
      inTurn(async () => {
        if (d.store.setup.read().done) {
          try {
            await moveTo(d.item, on);
          } catch (error) {
            // Whatever it left behind is shown as it is.
            await send();
            return { refused: said(error) };
          }
        }
        d.store.setup.keepStartAtLogin(on);
        d.emit({ type: "service.changed", at: d.clock.now(), patch: { startAtLogin: on } });
        await send();
        return "ok" as const;
      }),
    idle: () => last.then(() => {}),
  };
}

/**
 * The registration as the machine said it at start, when the replayed log says otherwise: one `service.changed`, or
 * nothing when they agree.
 */
export function startsAtLoginLeft(shown: boolean, now: boolean, at: number): EventBody[] {
  return shown === now ? [] : [{ type: "service.changed", at, patch: { startsAtLogin: now } }];
}
