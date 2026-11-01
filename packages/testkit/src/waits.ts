// What a test waits on in real time: a child program's file, an exit, a state read again. One deadline loop, so no
// test hand-rolls its own; the limit is on the time, never on a count of looks, since one look may take long under
// load (ADR 0071).

/**
 * Looks at `done` every `everyMs` until it says so or `limitMs` of real time passed: whether it did. A look that
 * throws ends the wait with its error.
 */
export async function waitUntil(
  done: () => boolean | Promise<boolean>,
  limitMs: number,
  everyMs = 20,
): Promise<boolean> {
  const deadline = Date.now() + limitMs;
  while (!(await done())) {
    if (Date.now() >= deadline) return false;
    await Bun.sleep(everyMs);
  }
  return true;
}
