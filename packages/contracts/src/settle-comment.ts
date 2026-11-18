// A settle comment (ADR 0101): the conversation comment `lookover settle` posts to settle a finding on the owner's
// word. Its first line is the command, `/lookover settle F2 accepted` (or `wrong`); then a sentence for the people on
// the pull request saying what the coding agent asks, the owner's reason quoted on one line with no mention or markup
// forming; then the hidden marker, `<!-- lookover:settle {json} -->` (`SETTLE_MARKER`), naming the finding, the
// decision, the reason as written and that the owner confirmed it, its JSON with `<` and `>` escaped so no reason
// ends the marker, and U+2028 and U+2029 so none breaks its line. Only the marker counts: a command written by hand,
// a marker that isn't the one `settleComment` writes, one that disagrees with its command, or a comment holding any
// other Lookover marker (a post of Lookover's quoting it) settles nothing. Who may settle (the owner, not the App), and which comments count, is the service's
// rule; this file only reads and writes the text.
import { z } from "zod";
import { OWNER_DECISION, type OwnerDecision } from "./finding.ts";
import { MARKER_PREFIX, SETTLE_COMMAND, SETTLE_MARKER } from "./frozen.ts";
import { FINDING_PATTERN, type FindingId, findingId } from "./ids.ts";

const MARKER_END = " -->";

/** What a settle comment says: the finding, what the owner decided, and their reason. */
export interface SettleText {
  finding: FindingId;
  decision: OwnerDecision;
  /** The owner's words, as the agent was given them. */
  reason: string;
}

/** What each decision asks of a finding. */
const ASKS: Record<OwnerDecision, (finding: string) => string> = {
  accepted: (finding) => `accept ${finding} as is`,
  wrong: (finding) => `mark ${finding} as wrong`,
};

/**
 * What the owner's `decision` asks of `finding`, as the settle comment's sentence and `lookover settle` say it:
 * "accept F2 as is", "mark F2 as wrong".
 */
export const decisionAsked = (decision: OwnerDecision, finding: string): string => ASKS[decision](finding);

/** An invisible break: a zero-width space, not a space to markdown. */
const BREAK = "\u{200B}";
/** Characters that change how text reads without showing: zero-width, bidirectional controls, tags, soft hyphen. */
const HIDDEN =
  /[\u{00AD}\u{061C}\u{180E}\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{FEFF}\u{E0000}-\u{E007F}]/gu;
/** The `&` that begins an entity: a decimal or hexadecimal reference, or a name, up to its `;`. */
const ENTITY = /&(?=(?:#\d{1,7}|#[xX][\da-fA-F]{1,6}|[A-Za-z][A-Za-z\d]{1,31});)/g;

/**
 * `text` on one line, as the sentence quotes it: hidden characters removed, every run of white space one space, and a
 * break where a mention, an image, a tag, an entity or a fence could form. It mirrors the output filter's rule
 * (`packages/publish/src/filter.ts`, ADR 0056), which `contracts` cannot import: a change to one is a change to both.
 */
const quotable = (text: string): string =>
  text
    .replace(HIDDEN, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[@\u{FF20}]/gu, `$&${BREAK}`)
    .replace(/!(?=\[)/g, `!${BREAK}`)
    .replace(/<(?=[A-Za-z/!?])/g, `<${BREAK}`)
    .replace(ENTITY, `&${BREAK}`)
    .replace(/`{3,}|~{3,}/g, `${BREAK}$&`);

/** `value` as JSON on one line no HTML comment can end in: `<`, `>`, U+2028 and U+2029 escaped. */
const markerJson = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u{2028}/gu, "\\u2028")
    .replace(/\u{2029}/gu, "\\u2029");

const commandOf = ({ finding, decision }: Pick<SettleText, "finding" | "decision">): string =>
  `${SETTLE_COMMAND} ${finding} ${decision}`;

/**
 * The comment `lookover settle` posts: the command, the sentence that asks (ADR 0081: text nothing reads), then the
 * hidden marker that alone makes it a settle.
 */
export const settleComment = (settle: SettleText): string =>
  [
    commandOf(settle),
    `The coding agent asks Lookover, on the owner's word, to ${decisionAsked(settle.decision, settle.finding)}: “${quotable(settle.reason)}”`,
    `${SETTLE_MARKER}${markerJson({ v: 1, finding: settle.finding, decision: settle.decision, reason: settle.reason, confirmed: "owner" })}${MARKER_END}`,
  ].join("\n");

const MARKER = z.object({
  v: z.literal(1),
  finding: z.string().regex(FINDING_PATTERN).transform(findingId),
  decision: OWNER_DECISION,
  reason: z.string().refine((r) => r.trim() !== ""),
  confirmed: z.literal("owner"),
});

/** The settle a marker line's JSON says; null when it isn't the JSON `settleComment` writes. */
function markerOf(line: string): SettleText | null {
  try {
    const read = MARKER.safeParse(JSON.parse(line.slice(SETTLE_MARKER.length, -MARKER_END.length)));
    return read.success
      ? { finding: read.data.finding, decision: read.data.decision, reason: read.data.reason }
      : null;
  } catch {
    return null;
  }
}

/**
 * The settle a comment's text asks, when it is one: a single marker as `settleComment` writes it, on a line of its own,
 * under a first line that is the command naming the same finding and decision, and no other Lookover marker. Null for
 * any other comment, a review request and a command written by hand included.
 */
export function readSettle(body: string): SettleText | null {
  const lines = body.split("\n").map((l) => l.trim());
  if (body.split(SETTLE_MARKER).length !== 2) return null;
  if (body.split(SETTLE_MARKER).join("").includes(MARKER_PREFIX)) return null;
  const line = lines.find((l) => l.startsWith(SETTLE_MARKER) && l.endsWith(MARKER_END));
  const settle = line === undefined ? null : markerOf(line);
  if (settle === null || lines[0] !== commandOf(settle)) return null;
  return settle;
}
