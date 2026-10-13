// What an error says, for a log line or a console answer: its message, or the thrown value as text when it is no
// `Error`. One helper, so every line words a failure the same way.

/** An error's message, or what was thrown, as text. */
export const said = (error: unknown): string => (error instanceof Error ? error.message : String(error));
