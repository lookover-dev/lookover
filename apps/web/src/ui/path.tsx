// A path or a command as code (design-system.md "Inline code"): the one way the app shows one. "Path" here covers
// commands too: a command is cut as a path is, and at its spaces besides (`kind`, "command" by default). A value short
// enough to sit in a sentence (`codePlace`) is one piece, never broken; a longer one, or one on its own line (`line`, a
// block under its sentence), keeps each piece `pathPieces` cuts whole (`code.path span`), a line breaking only between
// two, after a separator (`<wbr>`) or at a command's space, so `C:\Users\Your Name\…` never breaks at "Your Name" nor at
// a hyphen. The text is as given, for a copy.
import { Fragment } from "react";
import { type PathKind, pathPieces } from "../view-model/path.ts";
import { codePlace } from "../view-model/said.ts";

export function CodePath({
  text,
  kind = "command",
  line = false,
  tight = false,
  max,
}: {
  text: string;
  kind?: PathKind;
  line?: boolean;
  /** Punctuation follows it in its sentence: no room on its right, as a commit's `Sha` (`code.path.tight`). */
  tight?: boolean;
  /** The longest value its sentence holds whole (`codePlace`); a sentence's usual one when not given. */
  max?: number | undefined;
}) {
  const pieces = !line && codePlace(text, max) === "inline" ? [text] : pathPieces(text, kind);
  const isSpace = (piece: string | undefined) => piece !== undefined && piece.trim() === "";
  const className = ["path", line ? "line" : null, tight ? "tight" : null].filter(Boolean).join(" ");
  return (
    <code className={className}>
      {pieces.map((piece, i) =>
        isSpace(piece) ? (
          <Fragment key={i}>{piece}</Fragment>
        ) : (
          <Fragment key={i}>
            {i > 0 && !isSpace(pieces[i - 1]) ? <wbr /> : null}
            <span className="piece">{piece}</span>
          </Fragment>
        ),
      )}
    </code>
  );
}
