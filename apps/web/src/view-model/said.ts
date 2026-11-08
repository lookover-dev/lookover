// Where a sentence's value goes (design-system.md "Inline code"). Inline code inside a sentence never breaks: a short
// value (a citation, a file, a command of a few words) sits in the sentence whole; one too long to sit there (a folder,
// a long command) is not put in the sentence at all: the sentence is said without it (`WithCommand.alone`), ending
// before it, and the value goes on its own line under it, a block of mono that wraps only after a separator.
import type { WithCommand } from "./format.ts";

/** The longest value that sits in a sentence, in characters: a citation such as `src/webhooks/payments.ts:12`. */
const IN_SENTENCE = 32;

/**
 * The longest value that sits in a display-size sentence, the session screen's: its mono, a step under 21 px, holds
 * 24 characters inside a phone's 375 px, where 32 would break inside a piece.
 */
export const IN_DISPLAY = 24;

/** In the sentence, or on a line of its own under it. */
export type CodePlace = "inline" | "line";

/** Where `text` goes in a sentence that holds values up to `max` characters. */
export const codePlace = (text: string, max = IN_SENTENCE): CodePlace =>
  [...text].length <= max ? "inline" : "line";

/** A run of a sentence: words, or a value as code (`line`: on its own line under the words before it). */
export type SaidPart =
  | { text: string }
  | { code: string; kind: "command" | "path" | "device-code"; line: boolean };

/** The punctuation that closed the sentence around a value set on its own line, with the space after it. */
const CLOSING = /^[,.:;]\s*/;

const text = (words: string): SaidPart[] => (words === "" ? [] : [{ text: words }]);

/** What follows a value set on its own line: a second value carries on under it, its sentence opened anew. */
function under(after: string | WithCommand, max: number): SaidPart[] {
  if (typeof after === "string") return [];
  const open = (words: string) => words.replace(CLOSING, "");
  const alone = after.alone === undefined ? {} : { alone: open(after.alone) };
  return saidParts({ ...after, before: open(after.before), ...alone }, max);
}

/**
 * A sentence in runs: a value whose sentence says it `alone` and which is too long to sit in one goes on its own line,
 * after that sentence; what follows it (a second value) carries on under it, a string `after` dropped (`alone` folds it
 * in). A device code always sits in its sentence. `max`: the longest value the sentence holds (`codePlace`).
 */
export function saidParts(words: string | WithCommand, max = IN_SENTENCE): SaidPart[] {
  if (typeof words === "string") return text(words);
  const kind = words.kind ?? "command";
  const { after, alone } = words;
  if (alone !== undefined && kind !== "device-code" && codePlace(words.command, max) === "line")
    return [...text(alone), { code: words.command, kind, line: true }, ...under(after, max)];
  const next = typeof after === "string" ? after : after.before;
  const gap = CLOSING.test(next) ? "" : " ";
  return [
    ...text(words.before === "" ? "" : `${words.before} `),
    { code: words.command, kind, line: false },
    ...(typeof after === "string" ? text(`${gap}${after}`) : [...text(gap), ...saidParts(after, max)]),
  ];
}
