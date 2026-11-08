// A finding's text with its inline code shown as code, as GitHub shows it (ADR 0070, design-system.md "Inline code"):
// the spans `codeSpans` finds become code, a path in one broken only after its separators (`CodePath`), everything
// else stays text. No other markdown.
import { Fragment } from "react";
import { codeSpans } from "../view-model/inline-code.ts";
import { CodePath } from "./path.tsx";

export function InlineCode({ text }: { text: string }) {
  return (
    <>
      {codeSpans(text).map((part, i) =>
        part.code ? <CodePath key={i} text={part.text} /> : <Fragment key={i}>{part.text}</Fragment>,
      )}
    </>
  );
}
