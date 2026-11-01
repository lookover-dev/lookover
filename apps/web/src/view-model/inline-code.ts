// A finding's text with its inline code, as GitHub shows it (ADR 0070): CommonMark's code spans, backticks only, no
// other markdown. A run of backticks opens a span that closes only on the next run of the same length; a run that
// never closes stays as typed; outside a span, a backslash before a backtick shows the backtick, unless that backslash is
// itself escaped. The fix prompt keeps the raw text; this is only what the screen shows.

/** A piece of a finding's text: plain, or the content of a code span. */
export interface InlinePart {
  readonly code: boolean;
  readonly text: string;
}

/** Splits `text` into plain parts and code spans, by CommonMark's backtick rule. */
export function codeSpans(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  let plain = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\\" && text[i + 1] === "\\") {
      plain += "\\\\";
      i += 2;
      continue;
    }
    if (text[i] === "\\" && text[i + 1] === "`") {
      plain += "`";
      i += 2;
      continue;
    }
    const open = runLength(text, i);
    if (open === 0) {
      plain += text[i];
      i += 1;
      continue;
    }
    const close = closingRun(text, i + open, open);
    if (close === -1) {
      plain += text.slice(i, i + open);
      i += open;
      continue;
    }
    if (plain !== "") parts.push({ code: false, text: plain });
    plain = "";
    parts.push({ code: true, text: spanContent(text.slice(i + open, close)) });
    i = close + open;
  }
  if (plain !== "") parts.push({ code: false, text: plain });
  return parts;
}

function runLength(text: string, at: number): number {
  let end = at;
  while (text[end] === "`") end += 1;
  return end - at;
}

/** Where the next run of exactly `length` backticks starts from `from`, or -1. */
function closingRun(text: string, from: number, length: number): number {
  let i = from;
  while (i < text.length) {
    const run = runLength(text, i);
    if (run === length) return i;
    i += Math.max(run, 1);
  }
  return -1;
}

/** Line ends read as spaces; one space either side goes when both are there and the span isn't only spaces. */
function spanContent(raw: string): string {
  const flat = raw.replace(/\r\n|\r|\n/g, " ");
  return flat.startsWith(" ") && flat.endsWith(" ") && flat.trim() !== "" ? flat.slice(1, -1) : flat;
}
