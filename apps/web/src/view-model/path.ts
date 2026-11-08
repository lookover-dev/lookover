// A path or a command as inline code breaks only where a person would (design-system.md "Inline code"): after a
// separator (a backslash or a slash), and in a command at a space between its words too, never at a space inside a
// path ("Your Name") or inside quotes, nor at a hyphen. The pieces joined are the text as given, so a copy is exact.

/** A path (a folder, a file, a citation): its spaces are its own. A command: a space between words is a break. */
export type PathKind = "path" | "command";

const isSeparator = (c: string | undefined): boolean => c === "\\" || c === "/";
/** A character of a name: neither a separator nor a space. */
const isName = (c: string | undefined): boolean => c !== undefined && c !== " " && !isSeparator(c);

/** The quote open after `c`: a quote mark opens one, the same mark closes it. */
const quoteAfter = (open: string | null, c: string): string | null => {
  if (c !== "'" && c !== '"') return open;
  if (open === null) return c;
  return open === c ? null : open;
};

/** The value a piece ends in: what follows its last `=` or quote, so the slash that starts `--home=/home` leads one. */
const lastValue = (piece: string): string =>
  piece.slice(Math.max(...["=", "'", '"'].map((m) => piece.lastIndexOf(m))) + 1);

/**
 * The pieces a line may break between: never inside one. A piece ends after a separator that follows a name and is
 * followed by one (so `/usr`, `\\server`, `https://` and `--home=/home` stay whole); in a command, each run of spaces
 * outside quotes is a piece of its own, and a backslash before a space, or before a quote outside quotes, escapes it.
 */
export function pathPieces(text: string, kind: PathKind): string[] {
  const chars = [...text];
  const pieces: string[] = [];
  let piece = "";
  let quote: string | null = null;
  /** Whether the piece being read is a run of break spaces. */
  let spaces = false;
  const push = () => {
    if (piece !== "") pieces.push(piece);
    piece = "";
  };
  chars.forEach((c, i) => {
    const breaking = kind === "command" && quote === null && c === " " && chars[i - 1] !== "\\";
    // A run of break spaces starts or ends here: a piece of its own.
    if (breaking !== spaces) {
      push();
      spaces = breaking;
    }
    // Outside quotes a backslash escapes a quote: a POSIX shell's `'\''` closes, says and reopens one.
    const escaped = quote === null && chars[i - 1] === "\\";
    if (kind === "command" && !breaking && !escaped) quote = quoteAfter(quote, c);
    piece += c;
    if (isSeparator(c) && isName(chars[i + 1]) && /[^\\/]/.test(lastValue(piece))) push();
  });
  push();
  return pieces;
}
