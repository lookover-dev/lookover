// A value the app holds while it is open, outside the state the service sends: what the person chose on a page, or
// what a page showed once and keeps showing. React reads it with `useSyncExternalStore` (`useHeld` in `store.tsx`).

/**
 * A value replaced only when it changes, so its readers render only then. Each holder extends it with the moves that
 * change it, and calls `set`.
 */
export class HeldValue<T> {
  private value: T;
  private listeners = new Set<() => void>();

  constructor(value: T) {
    this.value = value;
  }

  get = (): T => this.value;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Holds `value` and tells every reader. */
  protected set(value: T): void {
    this.value = value;
    for (const l of this.listeners) l();
  }
}
