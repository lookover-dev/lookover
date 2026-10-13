// The keychain port (ADR 0053): one secret by name in the OS's secure store (Windows Credential Manager, macOS
// Keychain, Secret Service). The App store keeps only its data key there. Three adapters: the real one over Bun's
// secret store, every call bounded by a timeout so a prompt nobody answers can't hold the service; a fake in memory
// for tests and demo mode; and the bound itself, which wraps any of them. A call that fails or doesn't answer in
// time rejects with `KeychainUnavailable`, never with the secret in its words.

import { secrets } from "bun";
import { said } from "./said.ts";
import type { Timers } from "./timers.ts";

/** One secret by name. `get` answers null for a name it doesn't hold; `delete` answers whether it held one. */
export interface Keychain {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<boolean>;
}

/** The keychain refused, failed or didn't answer in time: the caller keeps the secret some other way. */
export class KeychainUnavailable extends Error {
  constructor(why: string) {
    super(`The keychain didn't answer: ${why}`);
    this.name = "KeychainUnavailable";
  }
}

/** Long enough for the OS store, short enough that a prompt nobody sees doesn't hold the service. */
const KEYCHAIN_MS = 5_000;

/** The service name Lookover's entries are filed under; each entry's own name is the App store's. */
export const KEYCHAIN_SERVICE = "lookover";

/**
 * `inner`, each call refused as `KeychainUnavailable` when it fails, throws or takes longer than `ms` on `timers`.
 * The bound only stops waiting: a native call that hangs can't be cancelled from JavaScript, it goes on in the
 * background. So a `set` that lands after its bound passed is deleted when it lands, leaving no entry nobody names.
 */
export function boundedKeychain(inner: Keychain, timers: Timers, ms = KEYCHAIN_MS): Keychain {
  const bound = <T>(call: () => Promise<T>, landedLate: () => void = () => {}): Promise<T> =>
    new Promise<T>((done, fail) => {
      let late = false;
      const cancel = timers.after(ms, () => {
        late = true;
        fail(new KeychainUnavailable(`no answer in ${ms} ms`));
      });
      // Started in a `then`, so a call that throws instead of rejecting is refused like one that rejects.
      Promise.resolve()
        .then(call)
        .then(
          (value) => {
            cancel();
            if (late) landedLate();
            done(value);
          },
          (error: unknown) => {
            cancel();
            fail(error instanceof KeychainUnavailable ? error : new KeychainUnavailable(said(error)));
          },
        );
    });
  // Best effort: the late entry is removed if the keychain lets it; nobody waits on that answer.
  const removeLate = (name: string) => () =>
    void inner.delete(name).then(
      () => undefined,
      () => undefined,
    );
  return {
    get: (name) => bound(() => inner.get(name)),
    set: (name, value) => bound(() => inner.set(name, value), removeLate(name)),
    delete: (name) => bound(() => inner.delete(name)),
  };
}

/** The OS keychain through Bun's secret store, bounded. Checked live only (`bun run live`), never in `check`. */
export function osKeychain(timers: Timers, ms = KEYCHAIN_MS): Keychain {
  return boundedKeychain(
    {
      get: (name) => secrets.get({ service: KEYCHAIN_SERVICE, name }),
      set: (name, value) => secrets.set({ service: KEYCHAIN_SERVICE, name, value }),
      delete: (name) => secrets.delete({ service: KEYCHAIN_SERVICE, name }),
    },
    timers,
    ms,
  );
}

/** The fake keychain: secrets in memory; `names()` lists what it holds, `refuse` makes every call fail. */
export interface MemoryKeychain extends Keychain {
  names(): string[];
}

export function memoryKeychain(o: { refuse?: boolean } = {}): MemoryKeychain {
  const held = new Map<string, string>();
  const refused = () => Promise.reject(new KeychainUnavailable("refused"));
  return {
    get: (name) => (o.refuse ? refused() : Promise.resolve(held.get(name) ?? null)),
    set: (name, value) => {
      if (o.refuse) return refused();
      held.set(name, value);
      return Promise.resolve();
    },
    delete: (name) => (o.refuse ? refused() : Promise.resolve(held.delete(name))),
    names: () => [...held.keys()],
  };
}
