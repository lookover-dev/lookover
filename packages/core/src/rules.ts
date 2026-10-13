// A repository's rules files as rules (ADR 0048). `parseRules`: one rule per Markdown list item, from its first line,
// nested items each their own; a file with no list item, one rule per paragraph; headings, thematic breaks and (in a
// file with a list) paragraphs are context. A fenced block is part of the rule it sits in, never an item or a
// heading; a fence closes only on a line of its own character, at least as long. An HTML comment (`<!-- … -->`, from
// a line it starts) is context: an item commented out is no rule. A rule's id hashes the repository, the file and its
// text with the marker dropped and the whitespace collapsed, so it stays when lines move or a list is renumbered; a
// rule repeated in a file is one rule, at its first line. `promptRules`: what both prompts may give, 32 KB in total
// and 16 KB per file, counted as the file's own bytes up to a line, filled in the order REVIEW.md, AGENTS.md,
// CLAUDE.md, and labelled `R1`, `R2`… across the files, a rule switched off left out; a rule the cut falls in
// inside a fence gets the fence closed after its last line given. Each rule and each context paragraph keeps the
// headings above it (`section`), ATX or setext, so a rule under "Only in test fixtures" reaches the prompts scoped
// to them; a nested rule keeps the first lines of the items it sits in (`parents`), so "- Only in test fixtures:"
// scopes the items under it the same way; a rule switched off takes the rules nested in it with it. The id leaves
// both out.
import type {
  PromptContext,
  PromptRule,
  PromptRulesFile,
  RepositoryId,
  RulesFile,
  RulesFileName,
} from "@lookover/contracts";
import { normalisedRuleText, RULES_FILES } from "@lookover/contracts";

/**
 * A rule as its file holds it: what the prompt gives, before its label, and the ids of the items it sits in,
 * outermost first (`parentIds`): a rule switched off takes the rules nested in it with it (ADR 0049).
 */
export type ParsedRule = Omit<PromptRule, "label"> & { parentIds: string[] };

/** The order the budget fills the files in (`RULES_FILES`'): a file earlier there is given first. */
const rank = (file: RulesFileName) => RULES_FILES.indexOf(file);

const TOTAL_BYTES = 32 * 1024;
const FILE_BYTES = 16 * 1024;

const ITEM = /^( *)([-*+]|\d{1,9}[.)])( +|$)(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?: +(.*?))?(?: +#+)? *$/;
const SETEXT = /^ {0,3}(=+|-+) *$/;
const BREAK = /^ {0,3}([-*_])( *\1){2,} *$/;
const FENCE = /^ *(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ *(`{3,}|~{3,}) *$/;
const COMMENT = /^ {0,3}<!--/;

/** An open fence: its character and its length. */
interface Fence {
  char: string;
  length: number;
}

/** The fence a line opens, if it is a fence line. */
function opens(line: string): Fence | null {
  const marks = FENCE.exec(line)?.[1];
  return marks ? { char: marks.charAt(0), length: marks.length } : null;
}

/** Whether a line closes `fence`: its own character only, at least as many. */
function closes(fence: Fence, line: string): boolean {
  const marks = FENCE_CLOSE.exec(line)?.[1];
  return marks !== undefined && marks.charAt(0) === fence.char && marks.length >= fence.length;
}

/** A rule being read: its first line, its lines, the column its text starts at (0 for a paragraph), its headings. */
interface Block {
  line: number;
  lines: string[];
  column: number;
  item: boolean;
  section: string[];
  parents: Parent[];
}

/** An item a later item may nest in: the column its text starts at, its first line and where it is. */
interface Parent {
  column: number;
  text: string;
  line: number;
}

/** A heading in scope: its level (1 to 6) and its text. */
interface Heading {
  level: number;
  text: string;
}

const OFFSET = 0xcbf29ce484222325n;
const PRIME = 0x100000001b3n;
const MASK = (1n << 64n) - 1n;

/** FNV-1a over the UTF-8 bytes, 64 bits as 16 hex digits: pure and stable. */
function fnv1a64(text: string): string {
  let hash = OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

/** The file's lines, line ends as `\n`: none for an empty file, no extra one for its last line's end. */
function linesOf(text: string): string[] {
  if (text === "") return [];
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

const indentOf = (line: string) => line.length - line.trimStart().length;

/** Reads a file's lines into its list items and paragraphs, one line at a time. */
class BlockReader {
  readonly blocks: Block[] = [];
  private open: Block | null = null;
  private fenced: Fence | null = null;
  private comment = false;
  private afterBlank = false;
  private headings: Heading[] = [];
  /** The items open around the next line, outermost first. */
  private items: Parent[] = [];

  read(line: string, n: number): void {
    if (this.fenced) this.fence(line);
    else if (this.comment) this.comment = !line.includes("-->");
    else if (line.trim() === "") {
      this.open?.lines.push("");
      this.afterBlank = true;
    } else this.text(line, n);
  }

  /** A line with text, outside a fence. */
  private text(line: string, n: number): void {
    const blank = this.afterBlank;
    this.afterBlank = false;
    const item = ITEM.exec(line);
    if (COMMENT.test(line)) this.startComment(line);
    else if (this.headed(line, blank)) return;
    else if (BREAK.test(line)) {
      this.close();
      this.items = [];
    } else if (item) this.item(item, n);
    else {
      if (!this.stays(line, blank)) {
        this.close();
        this.within(indentOf(line));
        this.open = { line: n, lines: [], column: 0, item: false, section: this.section(), parents: [] };
      }
      if (FENCE.test(line)) this.fence(line);
      else this.open?.lines.push(line.trim());
    }
  }

  /**
   * Whether the line is a heading, read if so: an ATX one (`## Tests`), or a setext underline (`===`, `---`) right
   * under a paragraph, which turns that paragraph into a heading.
   */
  private headed(line: string, blank: boolean): boolean {
    const setext = SETEXT.exec(line);
    const heading = HEADING.exec(line);
    if (setext && !blank && this.open?.item === false) this.underline(setext[1]?.startsWith("=") ? 1 : 2);
    else if (heading) this.heading(heading[1]?.length ?? 1, heading[2] ?? "");
    else return false;
    return true;
  }

  /** The headings in scope, outermost first. */
  private section(): string[] {
    return this.headings.map((h) => h.text);
  }

  /** A heading ends the block before it and replaces the headings of its level and deeper. */
  private heading(level: number, text: string): void {
    this.close();
    this.items = [];
    this.headings = [...this.headings.filter((h) => h.level < level), { level, text: text.trim() }];
  }

  /** A setext underline turns the paragraph above it into a heading. */
  private underline(level: number): void {
    const text = normalisedRuleText(this.open?.lines.join(" ") ?? "");
    this.open = null;
    this.heading(level, text);
  }

  close(): void {
    const open = this.open;
    if (open) {
      while (open.lines.at(-1) === "") open.lines.pop();
      this.blocks.push(open);
    }
    this.open = null;
  }

  /** A fence's line, kept as written but for the item's indent; a fence line opens or closes the block. */
  private fence(line: string): void {
    const open = this.open;
    open?.lines.push(line.slice(Math.min(indentOf(line), open.column)));
    this.fenced = this.fenced ? (closes(this.fenced, line) ? null : this.fenced) : opens(line);
  }

  /** A comment ends the block before it and is no block; it runs to the line holding `-->`. */
  private startComment(line: string): void {
    this.close();
    this.comment = !line.slice(line.indexOf("<!--") + 4).includes("-->");
  }

  private item(match: RegExpExecArray, n: number): void {
    this.close();
    const [, indent = "", marker = "", spaces = "", rest = ""] = match;
    const column = indent.length + marker.length + spaces.length;
    this.within(indent.length);
    const parents = [...this.items];
    this.open = { line: n, lines: [rest.trim()], column, item: true, section: this.section(), parents };
    this.items.push({ column, text: rest.trim(), line: n });
    this.fenced = opens(rest);
  }

  /** A line indented by `indent` ends every item whose text starts further right: it is in none of them. */
  private within(indent: number): void {
    while ((this.items.at(-1)?.column ?? 0) > indent) this.items.pop();
  }

  /** After a blank line, a line stays in an item only when indented to its text; a paragraph ends there. */
  private stays(line: string, blank: boolean): boolean {
    const open = this.open;
    return open !== null && (!blank || (open.item && indentOf(line) >= open.column));
  }
}

/** Every list item and every paragraph of the file, in order, with what each block holds. */
function blocksOf(lines: string[]): Block[] {
  const reader = new BlockReader();
  for (const [i, line] of lines.entries()) reader.read(line, i + 1);
  reader.close();
  return reader.blocks;
}

/** The rules of one rules file and its context paragraphs (only in a file with a list), in the file's order. */
function read(repo: RepositoryId, file: RulesFile): { rules: ParsedRule[]; context: PromptContext[] } {
  const blocks = blocksOf(linesOf(file.text));
  const listed = blocks.some((b) => b.item);
  const idOf = (b: Block) => fnv1a64(`${repo}\n${file.path}\n${normalisedRuleText(b.lines.join("\n"))}`);
  const ids = new Map(blocks.filter((b) => b.item).map((b) => [b.line, idOf(b)]));
  const seen = new Set<string>();
  const rules = (listed ? blocks.filter((b) => b.item) : blocks).flatMap((b): ParsedRule[] => {
    const id = idOf(b);
    if (seen.has(id)) return [];
    seen.add(id);
    const { section } = b;
    const parents = b.parents.map((p) => p.text);
    const parentIds = b.parents.map((p) => ids.get(p.line) ?? "");
    return [{ id, file: file.path, line: b.line, text: b.lines.join("\n"), section, parents, parentIds }];
  });
  const context = listed
    ? blocks
        .filter((b) => !b.item)
        .map((b) => ({ line: b.line, text: b.lines.join("\n"), section: b.section }))
    : [];
  return { rules, context };
}

/** The rules of one rules file, in the file's order. */
export function parseRules(repo: RepositoryId, file: RulesFile): ParsedRule[] {
  return read(repo, file).rules;
}

/** Whether a rule is off: switched off itself, or nested in a rule that is (ADR 0049). */
const isOff = (rule: ParsedRule, off: ReadonlySet<string>) =>
  off.has(rule.id) || rule.parentIds.some((id) => off.has(id));

const bytesOf = (line: string) => new TextEncoder().encode(line).length + 1;

/** The last line whose bytes, with every line before it, fit in `budget`: 0 when the first doesn't. */
function lastLineIn(lines: string[], budget: number): number {
  let used = 0;
  for (const [i, line] of lines.entries()) {
    used += bytesOf(line);
    if (used > budget) return i;
  }
  return lines.length;
}

/** A rule or a paragraph as given up to `afterLine`: its lines past the cut dropped, a fence the cut left open
 * closed, a rule's id the whole rule's. */
function upTo<T extends { line: number; text: string }>(rule: T, afterLine: number): T {
  const lines = rule.text.split("\n");
  const kept = lines.slice(0, afterLine - rule.line + 1);
  if (kept.length === lines.length) return rule;
  let fence: Fence | null = null;
  for (const line of kept) fence = fence ? (closes(fence, line) ? null : fence) : opens(line);
  if (fence) kept.push(fence.char.repeat(fence.length));
  return { ...rule, text: kept.join("\n") };
}

/**
 * The rules files as both prompts give them: in the budget's order, cut where it runs out, labelled across files.
 * The rules `off` names (switched off, ADR 0049) are left out with the rules nested in them, and take no label.
 */
export function promptRules(
  repo: RepositoryId,
  files: RulesFile[],
  off: ReadonlySet<string> = new Set(),
): PromptRulesFile[] {
  let left = TOTAL_BYTES;
  let label = 0;
  return files
    .toSorted((a, b) => rank(a.path) - rank(b.path))
    .map((file) => {
      const lines = linesOf(file.text);
      const afterLine = lastLineIn(lines, Math.min(FILE_BYTES, left));
      left -= lines.slice(0, afterLine).reduce((sum, line) => sum + bytesOf(line), 0);
      const given = read(repo, file);
      const rules = given.rules
        .filter((rule) => rule.line <= afterLine && !isOff(rule, off))
        .map(({ parentIds: _, ...rule }): PromptRule => {
          label += 1;
          return { ...upTo(rule, afterLine), label: `R${label}` };
        });
      const context = given.context.filter((c) => c.line <= afterLine).map((c) => upTo(c, afterLine));
      const cut = afterLine === lines.length ? null : { afterLine, lines: lines.length };
      return { file: file.path, commit: file.commit, rules, context, cut };
    });
}
