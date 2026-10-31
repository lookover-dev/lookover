// A port that lags as GitHub does after a write (ADR 0069), over a fake that shows every write on the next read: the
// proof, in `bun run check`, that a port suite waits for what it just wrote rather than reading it once.

/** A port wrapped to lag, and how the fixture tells it a write went through. */
export interface Lagging<T> {
  port: T;
  /** A write went through the fixture: each read made before it answers as it last did, for its next `lag` reads. */
  wrote(): void;
}

interface Answer {
  value: unknown;
  /** The read answered a promise: the stale answer is one too. */
  async: boolean;
}

/** `then` run on the call's value, now or once its promise settles. */
function after(result: unknown, then: (value: unknown, async: boolean) => void): unknown {
  if (!(result instanceof Promise)) {
    then(result, false);
    return result;
  }
  return result.then((value: unknown) => {
    then(value, true);
    return value;
  });
}

/**
 * Wraps `port` so that, after a write, the next `lag` reads of each call made before it (the same method, the same
 * arguments) return that call's earlier answer; a call never made before passes through. The methods named in `reads`
 * read; every other method of the port writes, and counts as a write once it returns. A read that throws is not
 * remembered.
 */
export function lagging<T extends object>(port: T, reads: readonly (keyof T)[], lag: number): Lagging<T> {
  const answers = new Map<string, Answer>();
  const stale = new Map<string, number>();
  const wrote = () => {
    for (const key of answers.keys()) stale.set(key, lag);
  };
  const read = (key: string, call: () => unknown): unknown => {
    const left = stale.get(key) ?? 0;
    const earlier = answers.get(key);
    if (left === 0 || earlier === undefined)
      return after(call(), (value, async) => answers.set(key, { value: structuredClone(value), async }));
    stale.set(key, left - 1);
    const value = structuredClone(earlier.value);
    return earlier.async ? Promise.resolve(value) : value;
  };
  const wrapped = new Proxy(port, {
    get(target, name, receiver) {
      const member: unknown = Reflect.get(target, name, receiver);
      if (typeof member !== "function") return member;
      const isRead = reads.some((r) => r === name);
      return (...args: unknown[]) => {
        const call = () => member.apply(target, args);
        if (isRead) return read(`${String(name)} ${JSON.stringify(args)}`, call);
        return after(call(), wrote);
      };
    },
  });
  return { port: wrapped, wrote };
}
