// A fenced code block's lines as CommonMark reads them: the one reader the output filter and the cut to fit share.

/** A fence's opening line: up to three spaces, three backticks or tildes or more, and its info string. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** A fence's closing line: up to three spaces, a run of one character, spaces. */
const FENCE_END = /^ {0,3}(`+|~+)[ \t]*$/;

/** A fence open: its character and length, closed only by a run of that character at least as long. */
export type Fence = { char: string; length: number };

/** The fence `line` opens, or null: a backtick fence's info string holds no backtick. */
export function opened(line: string): Fence | null {
  const open = FENCE.exec(line);
  const run = open?.[1];
  if (run === undefined || (run.startsWith("`") && open?.[2]?.includes("`"))) return null;
  return { char: run.slice(0, 1), length: run.length };
}

/** Whether `line` closes the block `fence` opened: the same character, as many or more, and nothing after. */
export function closes(line: string, fence: Fence): boolean {
  const run = FENCE_END.exec(line)?.[1];
  return run?.startsWith(fence.char) === true && run.length >= fence.length;
}

/** The line that closes what `fence` opened. */
export const closing = (fence: Fence): string => fence.char.repeat(fence.length);
