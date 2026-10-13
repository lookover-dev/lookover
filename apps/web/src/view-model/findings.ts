// How a review's findings read: "To do" and "Done", with escalated findings as "Needs you" (ADR 0030).
import {
  bySeverity,
  type Change,
  type ChangeId,
  type Finding,
  type FindingStatus,
  isCounted,
  isUnsettled,
  NOT_RAISED_AGAIN,
  type NoiseChoice,
  type NoiseCounts,
  type Review,
  type Rule,
  ruleText,
  type Severity,
  type Strictness,
  shortSha,
} from "@lookover/contracts";
import { plural } from "./format.ts";
import { inAgentLoop } from "./select.ts";

export const SEVERITY_LABEL: Record<Severity, string> = {
  blocking: "Blocking",
  should_fix: "Should fix",
  consider: "Consider",
};

/**
 * Where a finding sits, in the words `publish` posts it with on GitHub: "line 42", "lines 42 to 44"; on the base
 * side, "old line 42", a line of the file before the change. Its twin is `lines` in packages/publish/src/render.ts:
 * change both together.
 */
export function placeText(finding: Finding): string {
  const old = finding.side === "base" ? "old " : "";
  const { line, endLine } = finding;
  return endLine !== null && endLine !== line ? `${old}lines ${line} to ${endLine}` : `${old}line ${line}`;
}

/**
 * Why a finding was raised, after "Why it was raised:": the rule it follows and where that rule is, "Never log a
 * secret. (REVIEW.md, line 12)" (ADR 0048); only where, when its text isn't known; null when it follows none.
 */
export function whyRaised(finding: Finding): string | null {
  const where = finding.rule ? ruleText(finding.rule) : null;
  const text = finding.why.ruleText;
  if (text === null) return where;
  return where === null ? text : `${text} (${where})`;
}

/**
 * The newest reply a round read on a finding's thread, its claim (ADR 0052), with who wrote it: the agent's on a
 * change in the agent loop (it replies with the owner's login), else the login that wrote it; and `kept`, "Kept
 * once." when Lookover kept it against a reply once. The second keep escalates it, which "Needs you" says. Null
 * with no claim.
 */
export function replyLine(
  change: Pick<Change, "author" | "writtenBy">,
  finding: Finding,
): { head: string; text: string; kept: string | null } | null {
  const { claim } = finding;
  if (claim === null) return null;
  return {
    head: inAgentLoop(change) ? "Agent's reply:" : `Reply from ${claim.by}:`,
    text: claim.text,
    kept: finding.kept === 1 ? "Kept once." : null,
  };
}

/**
 * One choice of "Too noisy?": its label (`named`: the repository's name it ends with, kept on one line), its hint
 * (what it would have removed; none while it isn't counted), the command it sends, what it would do, and what saving
 * it says.
 */
export interface NoiseOption {
  label: string;
  named?: string;
  hint?: string;
  choice: NoiseChoice;
  effect: string;
  saved: string;
}

/**
 * What a choice would have removed from the reviews counted, "3 fewer findings in your last 12 reviews" (`posted`:
 * "fewer findings posted"); null while they aren't counted, or none were reviewed yet.
 */
function fewer(
  noise: NoiseCounts | undefined,
  n: (noise: NoiseCounts) => number,
  posted = "",
): string | null {
  if (noise === undefined || noise.reviews === 0) return null;
  const last = noise.reviews === 1 ? "your last review" : `your last ${noise.reviews} reviews`;
  return `${plural(n(noise), "fewer finding", "fewer findings")}${posted} in ${last}`;
}

/** The hint and the effect's last sentence of a choice whose count is `line`; neither while it isn't counted. */
function counted(line: string | null): Pick<NoiseOption, "hint"> & { more: string } {
  return line === null ? { more: "" } : { hint: line, more: ` That would have been ${line}.` };
}

/**
 * Whether the latest round's check is on the change's head: a round posted (not a preview) on the commit the pull
 * request is at. A commit pushed since has no check until a review is asked for.
 */
export function roundOnHead(review: Review, change: Pick<Change, "headSha">): boolean {
  return !review.preview && review.rounds.at(-1)?.sha === change.headSha;
}

/**
 * "This finding is wrong" (ADR 0052): dismissed here and on GitHub, said on its thread when it has one (a finding in
 * the summary only has none), its comment hidden, the summary updated, and the check while the latest round is on
 * the head (`onHead`): one on an older commit stays as it is.
 */
function wrongChoice(changeId: ChangeId, finding: Finding, onHead: boolean): NoiseOption {
  const updates = onHead ? "updates the summary and the check" : "updates the summary";
  const where = finding.commented ? `says so on its thread, hides its comment, and ${updates}` : updates;
  const check = onHead ? "" : " The check stays: it is on an older commit.";
  return {
    label: "This finding is wrong",
    hint: "keep it out of future rounds",
    choice: { kind: "wrong", changeId, findingId: finding.id },
    effect: `The finding is dismissed here and on GitHub: Lookover ${where}.${check} It ${NOT_RAISED_AGAIN}.`,
    saved: "Marked as wrong. The finding is dismissed.",
  };
}

/**
 * What "Too noisy?" offers on a finding of the change, in `repo` at its `strictness`, with its `rules` and its
 * `noise` counts (ADR 0049, ADR 0052): "This finding is wrong" first, on any finding posted and still unsettled;
 * "Turn off the rule" when the finding cites a rule that is on; "Only post blocking findings" on a finding below
 * blocking while strictness isn't already there. The last two say what they would have removed from the
 * repository's last reviews (30 at most), or nothing while the service hasn't counted them.
 */
export function noiseChoices(
  on: {
    changeId: ChangeId;
    repo: string;
    strictness: Strictness;
    noise?: NoiseCounts;
    rules: Rule[];
    onHead: boolean;
  },
  finding: Finding,
): NoiseOption[] {
  const { repo, noise } = on;
  const choices: NoiseOption[] = isCounted(finding) ? [wrongChoice(on.changeId, finding, on.onHead)] : [];
  // A rule already off, by its own switch or with a rule it sits in, has nothing left to turn off.
  const rule = on.rules.find((r) => r.id === finding.rule?.id && r.enabled && !r.parentOff);
  if (rule) {
    // Its count holds the rules nested in it, which go off with it (ADR 0049).
    const { hint, more } = counted(fewer(noise, (c) => c.raisedByRule[rule.id] ?? 0));
    const what = rule.nested > 0 ? `"${rule.text}" and the rules under it` : `"${rule.text}"`;
    choices.push({
      label: "Turn off the rule",
      ...(hint === undefined ? {} : { hint }),
      choice: { kind: "rule-off", changeId: on.changeId, findingId: finding.id },
      effect: `From the next review, Lookover stops following ${what} in ${repo}.${more}`,
      saved:
        rule.nested > 0
          ? `Saved. The rule "${rule.text}" and the rules under it are off.`
          : `Saved. The rule "${rule.text}" is off.`,
    });
  }
  if (finding.severity !== "blocking" && on.strictness !== "blocking") {
    const { hint, more } = counted(fewer(noise, (c) => c.postedBelowBlocking, " posted"));
    choices.push({
      label: `Only post blocking findings in ${repo}`,
      named: repo,
      ...(hint === undefined ? {} : { hint }),
      choice: { kind: "blocking-only", changeId: on.changeId },
      effect: `From the next review, only blocking findings are posted in ${repo}. The others stay in the check run and here.${more}`,
      saved: `Saved. Strictness is now "Only blocking findings" for ${repo}.`,
    });
  }
  return choices;
}

/** The author and the reviewer disagree: only the owner can settle it. */
export function needsYou(finding: Finding): boolean {
  return finding.status === "escalated";
}

/** Strictness kept it off the pull request, or the last run was a preview: then GitHub has nothing to show. */
export function onGitHub(review: Review, finding: Finding): boolean {
  return finding.posted && !review.preview;
}

export type FindingTab = "todo" | "done";

export function findingGroups(review: Review): Record<FindingTab, Finding[]> {
  const todo = bySeverity(review.findings.filter(isUnsettled), (f) => f.severity);
  return {
    todo: [...todo.filter(needsYou), ...todo.filter((f) => !needsYou(f))],
    done: review.findings.filter((f) => !isUnsettled(f)),
  };
}

/** Only the tabs that have findings in them. */
export function findingTabs(review: Review): { value: FindingTab; label: string; count: number }[] {
  const groups = findingGroups(review);
  const label: Record<FindingTab, string> = { todo: "To do", done: "Done" };
  return (["todo", "done"] as const)
    .filter((tab) => groups[tab].length > 0)
    .map((tab) => ({ value: tab, label: label[tab], count: groups[tab].length }));
}

// For statuses set without a reason of their own. Withdrawn findings always carry one; the owner dismisses with
// none (ADR 0052).
const SETTLED_TEXT: Partial<Record<FindingStatus, string>> = {
  acknowledged: "The reviewer accepted the reply.",
  dismissed: "You marked it as wrong.",
  obsolete: "No longer in the code.",
};

/** The meta line of a finding that is done. */
export function doneLine(
  finding: Finding,
): { kind: "verified"; sha: string; round: number | null } | { kind: "why"; text: string } {
  if (finding.status === "verified_fixed" && finding.verifiedSha) {
    return { kind: "verified", sha: shortSha(finding.verifiedSha), round: finding.closedIn };
  }
  return { kind: "why", text: finding.closedWhy ?? SETTLED_TEXT[finding.status] ?? "" };
}
