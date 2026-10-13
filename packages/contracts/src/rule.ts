// A review rule, from a repository's files or the owner's own. A repository's rules are read from the root of its
// default branch, never from the change under review (ADR 0048): `prepare` reads the files, `core` parses them into
// rules, both prompts give them, and a finding that follows one cites it.
import type { CommitSha, RepositoryId } from "./ids.ts";

/**
 * The rules files Lookover reads at the root of a repository's default branch (ADR 0048), in the order they are
 * read, kept and given to the prompts: the review's own file first.
 */
export const RULES_FILES = ["REVIEW.md", "AGENTS.md", "CLAUDE.md"] as const;

/** A rules file Lookover reads at the root of a repository's default branch (ADR 0048). */
export type RulesFileName = (typeof RULES_FILES)[number];

/**
 * A rule's text as its id hashes it (ADR 0048) and a repository's settings file keeps a rule switched off by it
 * (ADR 0049): every run of whitespace one space, trimmed. Two texts that differ only in spacing are one rule.
 */
export const normalisedRuleText = (text: string): string => text.replaceAll(/\s+/g, " ").trim();

export interface Rule {
  /** Hashed from the repository, the file and the rule's text: an edited rule is a new rule, its counts at zero. */
  id: string;
  text: string;
  source: RulesFileName | "yours";
  /** The rule's first line in its file; null for the owner's own. */
  line: number | null;
  repoId: RepositoryId | null;
  /** Findings that cited it. */
  raised: number;
  /** Of those, the ones verified fixed. */
  acted: number;
  /** Its own switch, as the repository's settings file keeps it (ADR 0049). */
  enabled: boolean;
  /**
   * Off with a rule it sits in (ADR 0049): a rule switched off takes the rules nested in it with it, whatever their
   * own switch, which is kept for when that rule comes back on.
   */
  parentOff: boolean;
  /** How many rules are nested in it: switching it off switches them off too (ADR 0049). */
  nested: number;
}

/**
 * A rules file as `prepare` read it (ADR 0048): from the commit the repository's default branch was at when the
 * job's fetch ran, never from the change's worktree. Only a regular file in UTF-8 is read.
 */
export interface RulesFile {
  path: RulesFileName;
  text: string;
  /** The default branch's commit it was read at. */
  commit: CommitSha;
}

/** The rule a finding follows (ADR 0048): which rule, in which file, at which line of it. */
export interface CitedRule {
  id: string;
  file: RulesFileName;
  /** 1-based, the rule's first line in `file`. */
  line: number;
}

/** A rule as both prompts give it (ADR 0048): its label in the prompt (`R1`, `R2`…), the rule it cites, its text. */
export interface PromptRule extends CitedRule {
  /** `R<n>`, numbered across every file the prompt gives: what the finder answers in `rule`. */
  label: `R${number}`;
  text: string;
  /** The headings above it in its file, outermost first (`["Hard rules", "Security"]`): the scope the file gives it. */
  section: string[];
  /**
   * The list items it is nested in, by their first lines, outermost first (`["Only in test fixtures:"]`): the scope
   * its parent items give it, after its headings. Empty for a rule of the list's first level or a paragraph.
   */
  parents: string[];
}

/**
 * A paragraph of a rules file that holds list items (ADR 0048): no rule, but context the prompts give unlabelled
 * under its headings, such as "These apply only to `tests/`.".
 */
export interface PromptContext {
  /** 1-based, the paragraph's first line in its file. */
  line: number;
  text: string;
  /** The headings above it, outermost first, as a rule's. */
  section: string[];
}

/**
 * One rules file as both prompts give it (ADR 0048): where it was read, its rules and its context paragraphs in the
 * file's order, and where the prompt budget cut it. `cut`: the file's last line given and how many lines it has;
 * null when it is whole.
 */
export interface PromptRulesFile {
  file: RulesFileName;
  commit: CommitSha;
  rules: PromptRule[];
  context: PromptContext[];
  cut: { afterLine: number; lines: number } | null;
}
