// The report (ADR 0050): the scores as a research note anyone can read. Pure: the scores, the rule's decision and
// what the run was in, Markdown out. Every rate stands beside its counts ("3 of 12, 25 %") and the run count is
// stated, since one run on fifteen cases says nothing about a small difference. The note holds two marked parts:
// the generated one, rewritten every time, and the author's reading, which a re-render keeps (`keepReading`).
import { engineName } from "@lookover/contracts";
import { DEEP_MARGIN, type Decision, MIN_COMPARED_CASES } from "./decide.ts";
import type { Counts, ScoredFinding, Scores, SetupScore } from "./score.ts";
import type { EvalCase, Place, SessionCli, SetupName } from "./types.ts";

/** What a report says about the run behind its scores. */
export interface ReportMeta {
  /** The day the run ran, `YYYY-MM-DD`. */
  date: string;
  /** How many times each setup reviewed each case (ADR 0050: once). */
  runs: number;
  /** The CLIs the sessions ran on: one version and one model per engine in a run a report is made from. */
  clis: SessionCli[];
  /** The corpus, in its order: every case the run was asked to review, compared or not. */
  cases: EvalCase[];
}

const MARK = {
  readingStart: "<!-- reading:start: the author's reading, kept when the report is written again -->",
  readingEnd: "<!-- reading:end -->",
  generatedStart:
    "<!-- generated:start: written by writeReport from apps/evals/recorded/; edit the reading above, never this -->",
  generatedEnd: "<!-- generated:end -->",
};

/** What the author's reading says before anyone has read the numbers. */
const NOT_READ = "## Reading\n\nNot read yet.";

const SETUP = {
  quick: "Quick",
  "quick-codex": "Quick on Codex",
  "standard-one": "Standard, one engine",
  "standard-cross": "Standard, cross-model",
  deep: "Deep",
} satisfies Record<SetupName, string>;

const isSetup = (name: string): name is SetupName => Object.hasOwn(SETUP, name);
const SETUPS_IN_ORDER = Object.keys(SETUP).filter(isSetup);

/** The rule's verdict as the report says it, and the step of ADR 0050's rule that gave it, in the record's words. */
const VERDICT = {
  no_verdict: {
    said: (compared: number) => `No verdict: ${compared} cases compared, ${MIN_COMPARED_CASES} needed.`,
    rule: "Fewer than thirteen complete cases: no verdict, the missing sessions run again first.",
  },
  ask_owner: {
    said: () => "Standard stays the default, and the owner is asked.",
    rule: "Quick scores at least Standard cross-model's F0.5: the default stays Standard, and the owner is asked, because dropping the second look changes what Lookover is.",
  },
  deep: {
    said: () => "Deep becomes the default.",
    rule: "Deep beats Standard cross-model on F0.5 by more than 0.05, finds at least two more planted bugs, and keeps no more noise: Deep becomes the default.",
  },
  standard: {
    said: () => "Standard stays the default.",
    rule: "Otherwise Standard stays the default.",
  },
} satisfies Record<Decision["verdict"], { said: (compared: number) => string; rule: string }>;

const percent = (rate: number): string => `${Math.round(rate * 100)} %`;
const f05 = (value: number): string => value.toFixed(2);
const thousands = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const cell = (text: string): string => text.replaceAll("|", "\\|").replaceAll("\n", " ");
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const row = (cells: (string | number)[]): string => `| ${cells.join(" | ")} |`;
/** A Markdown table, as one block. */
const table = (head: string[], rows: (string | number)[][]): string =>
  [row(head), `|${head.map(() => "---").join("|")}|`, ...rows.map(row)].join("\n");

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function listed(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** Bugs found, as a count beside its rate. */
const recall = (c: Counts): string =>
  c.planted === 0 ? "nothing planted" : `${c.found} of ${c.planted}, ${percent(c.recall)}`;

/** Precision, as a count beside its rate: duplicates count on neither side. */
function precision(c: Counts): string {
  const counted = c.findings - c.duplicates;
  return counted === 0 ? "nothing kept" : `${c.found} of ${counted}, ${percent(c.precision)}`;
}

function runSection(scores: Scores, meta: ReportMeta): string[] {
  const planted = meta.cases.filter((c) => c.planted !== null).length;
  const clean = meta.cases.length - planted;
  const runs =
    meta.runs === 1
      ? "One run: each setup reviewed each case once"
      : `${meta.runs} runs: each setup reviewed each case ${meta.runs} times`;
  const lines = [
    `Run on ${meta.date}: ${meta.cases.length} cases (${planted} with a planted bug, ${clean} clean), ` +
      `${scores.compared.length} compared (every setup complete). ${runs}, so no difference smaller than the ` +
      `rule's margin (${DEEP_MARGIN} of F0.5) means anything.`,
  ];
  if (scores.incomplete.length > 0) {
    const left = scores.incomplete.map(
      (i) => `\`${i.caseId}\` (${listed(i.setups.map((s) => SETUP[s]))} missing)`,
    );
    lines.push(`Not compared: ${left.join(", ")}.`);
  }
  lines.push(clis(meta.clis));
  return lines;
}

function clis(list: SessionCli[]): string {
  const said = (cli: SessionCli) =>
    `${engineName(cli.name)}: version ${cli.version ?? "unknown"}, model ${cli.model ?? "unknown"}.`;
  return list.length === 0 ? "No session ran." : list.map(said).join(" ");
}

function verdictSection(scores: Scores, decision: Decision): string[] {
  const { said, rule } = VERDICT[decision.verdict];
  const kept = (s: SetupName) => scores.setups[s].kept;
  const [quick, cross, deep] = [kept("quick"), kept("standard-cross"), kept("deep")];
  return [
    `**${said(decision.compared)}** ADR 0050: “${rule}”`,
    `The rule read the kept findings over the ${decision.compared} compared cases: ` +
      `F0.5 Quick ${f05(quick.f05)}, Standard cross-model ${f05(cross.f05)}, Deep ${f05(deep.f05)}; ` +
      `bugs found Standard cross-model ${cross.found}, Deep ${deep.found}; ` +
      `noise Standard cross-model ${cross.noise}, Deep ${deep.noise}.`,
    "Standard, one engine against cross-model decides nothing about the default: it says what an owner with one subscription gets.",
  ];
}

function setupsSection(scores: Scores, runs: number): string[] {
  const head = ["Setup", "Bugs found", "Precision", "F0.5", "Noise", "Duplicates"];
  const rows = (pick: (s: SetupScore) => Counts) =>
    SETUPS_IN_ORDER.map((name) => {
      const c = pick(scores.setups[name]);
      return [SETUP[name], recall(c), precision(c), f05(c.f05), c.noise, c.duplicates];
    });
  return [
    `What each setup keeps: what its round would post at the default strictness, over the ${scores.compared.length} compared cases, ${runs === 1 ? "one run" : `${runs} runs`}.`,
    table(
      head,
      rows((s) => s.kept),
    ),
    "With its hidden findings counted too:",
    table(
      head,
      rows((s) => s.all),
    ),
  ];
}

/** What a setup kept on one compared case, in a few words. */
function caseCell(findings: ScoredFinding[], planted: boolean): string {
  const unmatched = findings.filter((f) => f.match === "unmatched").length;
  const duplicates = findings.filter((f) => f.match === "duplicate").length;
  const onBug = findings.filter((f) => f.match !== "unmatched");
  const found = onBug.every((f) => f.fromAlso) ? "found from another place" : "found";
  const parts = planted ? [onBug.length > 0 ? found : "missed"] : [];
  if (unmatched > 0) parts.push(`${unmatched} unmatched`);
  if (duplicates > 0) parts.push(plural(duplicates, "duplicate", "duplicates"));
  return parts.length === 0 ? "nothing" : parts.join(", ");
}

/** A place as the report names it: `path:3, 9-11`. */
const placed = ({ path, ranges }: Place): string =>
  `\`${path}:${ranges.map(([start, end]) => (start === end ? `${start}` : `${start}-${end}`)).join(", ")}\``;

const where = (c: EvalCase): string => {
  if (c.planted === null) return "clean";
  const also = c.planted.also === undefined ? "" : `, also ${listed(c.planted.also.map(placed))}`;
  return `${placed(c.planted)}${also}: ${cell(c.planted.what)}`;
};

function perCaseSection(scores: Scores, meta: ReportMeta): string[] {
  const rows = meta.cases.map((c) => {
    const incomplete = scores.incomplete.find((i) => i.caseId === c.id);
    const cells = SETUPS_IN_ORDER.map((name) => {
      if (incomplete !== undefined) return incomplete.setups.includes(name) ? "missing" : "not compared";
      const kept = scores.findings.filter((f) => f.caseId === c.id && f.setup === name && f.kept);
      return caseCell(kept, c.planted !== null);
    });
    return [`\`${c.id}\``, where(c), ...cells];
  });
  return [table(["Case", "Planted", ...SETUPS_IN_ORDER.map((s) => SETUP[s])], rows)];
}

function confirmSection(scores: Scores): string[] {
  const rows = SETUPS_IN_ORDER.flatMap((name) => {
    const confirm = scores.setups[name].confirm;
    if (confirm === null) return [];
    const { confirmer, plantedRefuted, unmatchedRefuted, demoted } = confirm;
    return [[SETUP[name], engineName(confirmer), plantedRefuted, unmatchedRefuted, demoted]];
  });
  const head = [
    "Setup",
    "Confirmer",
    "Planted bugs it refuted (lost)",
    "Unmatched candidates it refuted (gained)",
    "Demoted",
  ];
  return [table(head, rows)];
}

function costSection(scores: Scores): string[] {
  const rows = SETUPS_IN_ORDER.map((name) => {
    const { sessions, inputTokens, outputTokens, unknownUsage, wallMs } = scores.setups[name].cost;
    const unknown = unknownUsage === 0 ? "" : ` (${plural(unknownUsage, "session", "sessions")} unknown)`;
    return [
      SETUP[name],
      sessions,
      `${thousands(inputTokens)}${unknown}`,
      `${thousands(outputTokens)}${unknown}`,
      duration(wallMs),
    ];
  });
  return [table(["Setup", "Sessions", "Input tokens", "Output tokens", "Wall time"], rows)];
}

function findingLine(f: ScoredFinding): string {
  const notes = [
    ...(f.kept ? [] : ["hidden"]),
    ...(f.match === "duplicate" ? ["a duplicate"] : []),
    ...(f.fromAlso ? ["from another place"] : []),
  ];
  const said = notes.length === 0 ? "" : ` (${notes.join(", ")})`;
  return `- \`${f.caseId}\`, ${SETUP[f.setup]}: \`${f.file}:${f.line}\` ${f.title.replaceAll("\n", " ")}${said}`;
}

/** A section: its heading, then its blocks (paragraphs, tables, lists), a blank line between each. */
const part = (heading: string, blocks: string[]): string => [heading, ...blocks].join("\n\n");

function findingsList(findings: ScoredFinding[]): string[] {
  return [findings.length === 0 ? "None." : findings.map(findingLine).join("\n")];
}

/**
 * The report as Markdown: a title, the author's reading (marked, kept by `keepReading`), then the generated part
 * (marked): the run, the verdict, the setups, each case, the confirm, the cost, and every finding that matched the
 * bug or nothing.
 */
export function report(scores: Scores, decision: Decision, meta: ReportMeta): string {
  const onBug = scores.findings.filter((f) => f.match !== "unmatched");
  const unmatched = scores.findings.filter((f) => f.match === "unmatched");
  const parts = [
    "# Evaluation: the default depth",
    "> Research note, written by `writeReport` from the answers committed in `apps/evals/recorded/` " +
      "([ADR 0050](../adr/0050-the-evaluation-harness.md)). The generated part is written again from them " +
      "each time; the reading is the author's, kept.",
    MARK.readingStart,
    NOT_READ,
    MARK.readingEnd,
    MARK.generatedStart,
    part("## The run", runSection(scores, meta)),
    part("## The verdict", verdictSection(scores, decision)),
    part("## The setups", setupsSection(scores, meta.runs)),
    part("## Per case", perCaseSection(scores, meta)),
    part("## The confirm", confirmSection(scores)),
    part("## Cost", costSection(scores)),
    part("## Findings on the bug", findingsList(onBug)),
    part("## Findings that matched nothing", findingsList(unmatched)),
    MARK.generatedEnd,
  ];
  return `${parts.join("\n\n")}\n`;
}

/** The author's reading in `markdown`, its markers included; null when it holds none. */
function readingOf(markdown: string): string | null {
  const start = markdown.indexOf(MARK.readingStart);
  const end = markdown.indexOf(MARK.readingEnd);
  if (start === -1 || end < start) return null;
  return markdown.slice(start, end + MARK.readingEnd.length);
}

/**
 * A new report with the author's reading of the one it replaces, as it is. Throws when the old report lost its
 * reading's markers: writing over it would lose what the author wrote.
 */
export function keepReading(previous: string, next: string): string {
  const kept = readingOf(previous.replaceAll("\r\n", "\n"));
  if (kept === null)
    throw new Error(
      `The report has no reading between "${MARK.readingStart}" and "${MARK.readingEnd}": put the markers back around the author's reading, then write it again.`,
    );
  const fresh = readingOf(next);
  return fresh === null ? next : next.replace(fresh, () => kept);
}
