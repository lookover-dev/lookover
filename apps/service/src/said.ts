// What an error says, for a log line or a console answer: its message, or the thrown value as text when it is no
// `Error`. One helper, so every line words a failure the same way.

/** An error's message, or what was thrown, as text. */
export const said = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * An error as a log line: its name and message, then where it was thrown. Its `stack` as it is when that starts with
 * them; else they are put back before its frames: Bun 1.4.2 sometimes formats `stack` without the message when the
 * engine collects garbage meanwhile (#453, under load), and "Error" alone says nothing of what went wrong. Never
 * throws: it runs in the handler of last resort, where a stack that is no string or a `toString` that throws would
 * lose the line.
 */
export function described(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const head = headOf(error);
  const stack = typeof error.stack === "string" ? error.stack : head;
  if (stack.startsWith(head)) return stack;
  const frames = stack.split("\n").filter((line) => /^\s+at /.test(line));
  return [head, ...frames].join("\n");
}

/** "Name: message" as the error says it, else its message when its `toString` throws. */
function headOf(error: Error): string {
  try {
    return String(error);
  } catch {
    return `Error: ${error.message}`;
  }
}
