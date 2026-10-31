// Calls that take turns: each starts once every call before it has settled, kept or refused, so two never overlap.
// One per thing whose reads and writes must not interleave (a store's files).

/** A queue of calls: `inTurn(call)` runs `call` once the calls before it have settled, and answers as it does. */
export function turns(): <T>(call: () => Promise<T>) => Promise<T> {
  /** The calls so far, settled or not: each new one starts once they have. */
  let turn: Promise<unknown> = Promise.resolve();
  return <T>(call: () => Promise<T>): Promise<T> => {
    const run = turn.then(call, call);
    turn = run.catch(() => {});
    return run;
  };
}
