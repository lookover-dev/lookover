// Start at login, as the service keeps it (ADR 0054, ADR 0068): the owner's choice, kept by the store (on until they
// turn it off), and the registration on the machine (`LoginItem`) made to match it once the setup is done, never
// before: at each start, when the setup is finished, and on each `service.startAtLogin`. The registration belongs to
// the install whose command it holds: matching never takes another install's over (it is logged, and left); turning
// off removes only this install's; only `service.startAtLogin` with `takeOver` replaces another's. A registration the
// machine refuses refuses that command with its reason and leaves the choice as it was; at a start or a finish, it is
// logged and the service goes on. Who holds it, as the machine says, is sent as `service.changed { atLogin }` whenever
// it differs from what the UI shows. One change at a time: each waits for the one before.
// It must never know: which machine, or whether its `LoginItem` is the real one or the fake.
import { type Clock, type EventBody, type LoginHolder, sameLoginHolder } from "@lookover/contracts";
import type { Store } from "@lookover/store";
import type { LoginItem } from "./login-item.ts";
import { said } from "./said.ts";

interface StartAtLoginDeps {
  item: LoginItem;
  store: Pick<Store, "setup">;
  clock: Clock;
  emit(body: EventBody): void;
  /** Who the UI shows holding start at login now. */
  shown(): LoginHolder;
  log(line: string): void;
}

/** The owner's choice and the machine's registration, kept together. */
export interface StartAtLogin {
  /** The registration matched to the choice, if the setup is done, and what the machine then says sent. */
  match(): Promise<void>;
  /**
   * `service.startAtLogin`: the registration changed first (once the setup is done; another install's replaced only
   * with `takeOver`), then the choice kept and sent. Refused with the machine's reason, the choice left as it was.
   */
  choose(on: boolean, takeOver?: boolean): Promise<"ok" | { refused: string }>;
  /** Settles once the change under way, if any, has. */
  idle(): Promise<void>;
}

/**
 * Registers or removes this install's registration so that it is `want`; `register` itself writes nothing when this
 * install's is already exactly what it writes (and rewrites one an older template wrote), and another install's is
 * left unless `takeOver`. Answers who holds it after. Rejects as the machine does.
 */
async function moveTo(item: LoginItem, want: boolean, takeOver: boolean): Promise<LoginHolder> {
  if (want) return await item.register({ takeOver });
  const now = await item.held();
  if (now !== "this") return now;
  await item.unregister();
  return "none";
}

/** Who the machine says holds start at login; none, logged, when it can't say. */
async function heldNow(item: LoginItem, log: (line: string) => void): Promise<LoginHolder> {
  try {
    return await item.held();
  } catch (error) {
    log(`Can't tell whether Lookover starts at login: ${said(error)}`);
    return "none";
  }
}

/**
 * At a start and at the setup's end, before the UI's state is made: the registration matched to the kept choice once
 * the setup is done, never taking another install's over (a refusal, or another install holding it, logged), and who
 * holds it then.
 */
export async function matchedAtStart(
  item: LoginItem,
  store: Pick<Store, "setup">,
  log: (line: string) => void,
): Promise<LoginHolder> {
  if (store.setup.read().done) {
    const want = store.setup.startAtLogin();
    try {
      const after = await moveTo(item, want, false);
      if (want && typeof after === "object") log(`Another Lookover starts at login: ${after.other}`);
    } catch (error) {
      log(`Lookover couldn't ${want ? "register" : "remove"} its start at login: ${said(error)}`);
    }
  }
  return await heldNow(item, log);
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
    const now = await heldNow(d.item, d.log);
    if (!sameLoginHolder(now, d.shown()))
      d.emit({ type: "service.changed", at: d.clock.now(), patch: { atLogin: now } });
  };
  return {
    match: () =>
      inTurn(async () => {
        await matchedAtStart(d.item, d.store, d.log);
        await send();
      }),
    choose: (on, takeOver = false) =>
      inTurn(async () => {
        if (d.store.setup.read().done) {
          try {
            await moveTo(d.item, on, takeOver);
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
 * Who holds start at login as the machine said it at start, when the replayed log says otherwise: one
 * `service.changed`, or nothing when they agree.
 */
export function atLoginLeft(shown: LoginHolder, now: LoginHolder, at: number): EventBody[] {
  return sameLoginHolder(shown, now) ? [] : [{ type: "service.changed", at, patch: { atLogin: now } }];
}
