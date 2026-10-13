// A repository's rules files as rules (ADR 0048): one per Markdown list item, else one per paragraph, headings as
// context; each rule's id a hash of the repository, the file and its normalised text; and the prompt budget, 32 KB
// in total and 16 KB per file, filled in the order REVIEW.md, AGENTS.md, CLAUDE.md, cut at a line.
import { expect, test } from "bun:test";
import {
  type CommitSha,
  commitSha,
  type RepositoryId,
  type RulesFile,
  repositoryId,
} from "@lookover/contracts";
import { parseRules, promptRules } from "./index.ts";

const REPO: RepositoryId = repositoryId("sasensi/lookover-sandbox");
const OTHER_REPO: RepositoryId = repositoryId("lookover-dev/lookover-private");
const MAIN: CommitSha = commitSha("1111111111111111111111111111111111111111");

const file = (text: string, path: RulesFile["path"] = "REVIEW.md"): RulesFile => ({
  path,
  text,
  commit: MAIN,
});

/** The rules' lines and texts, ids aside: what the tables below write by hand. */
const linesAndTexts = (text: string) => parseRules(REPO, file(text)).map((r) => [r.line, r.text]);

test.each<[string, string, [number, string][]]>([
  [
    "a list, one rule per item",
    "- Never log a token.\n- Use `Result`, not exceptions.\n",
    [
      [1, "Never log a token."],
      [2, "Use `Result`, not exceptions."],
    ],
  ],
  [
    "each marker",
    "* Star.\n+ Plus.\n- Dash.\n",
    [
      [1, "Star."],
      [2, "Plus."],
      [3, "Dash."],
    ],
  ],
  [
    "a numbered list",
    "1. First.\n2. Second.\n10) Tenth.\n",
    [
      [1, "First."],
      [2, "Second."],
      [3, "Tenth."],
    ],
  ],
  [
    "an item's next lines are the same rule, its first line's number",
    "- Keep functions short:\n  under 40 lines.\n- Other.\n",
    [
      [1, "Keep functions short:\nunder 40 lines."],
      [3, "Other."],
    ],
  ],
  [
    "a lazy continuation line joins the item",
    "- Keep functions short:\nunder 40 lines.\n",
    [[1, "Keep functions short:\nunder 40 lines."]],
  ],
  [
    "an indented paragraph after a blank line is still the item's",
    "- One.\n\n  More on one.\n- Two.\n",
    [
      [1, "One.\n\nMore on one."],
      [4, "Two."],
    ],
  ],
  [
    "a nested item is a rule of its own",
    "- Tests:\n  - go through the entry.\n  - assert behaviour.\n",
    [
      [1, "Tests:"],
      [2, "go through the entry."],
      [3, "assert behaviour."],
    ],
  ],
  [
    "headings and paragraphs around a list are context, not rules",
    "# Review rules\n\nWhat we look for.\n\n## Security\n\n- Never log a token.\n\nA closing word.\n",
    [[7, "Never log a token."]],
  ],
  [
    "a file with no list item: one rule per paragraph",
    "# Rules\n\nNever log a token.\nNot even in tests.\n\nUse tabs.\n",
    [
      [3, "Never log a token.\nNot even in tests."],
      [6, "Use tabs."],
    ],
  ],
  [
    "a fenced block is the item's, never a heading or an item",
    "- Prefer:\n  ```\n  # not a heading\n  - not an item\n  ```\n- Next.\n",
    [
      [1, "Prefer:\n```\n# not a heading\n- not an item\n```"],
      [6, "Next."],
    ],
  ],
  [
    "a fence closes only on its own character, at least as long",
    "- Prefer:\n  ````\n  ```\n  - not an item\n  ~~~~\n  ````\n- Next.\n",
    [
      [1, "Prefer:\n````\n```\n- not an item\n~~~~\n````"],
      [7, "Next."],
    ],
  ],
  [
    "an item opening a fence on its first line keeps the fence",
    "- ```\n  - not an item\n  ```\n- Next.\n",
    [
      [1, "```\n- not an item\n```"],
      [4, "Next."],
    ],
  ],
  [
    "an HTML comment is context: the items it holds are no rules",
    "- Kept.\n<!--\n- Old rule.\n-->\n- Next.\n<!-- A note. -->\n",
    [
      [1, "Kept."],
      [5, "Next."],
    ],
  ],
  [
    "an HTML comment is no paragraph in a file without a list",
    "<!-- Generated. -->\n\nNever log a token.\n\n<!--\nUse spaces.\n-->\n",
    [[3, "Never log a token."]],
  ],
  [
    "a rule repeated in a file is one rule, at its first line",
    "- One.\n- Two.\n-   One.\n",
    [
      [1, "One."],
      [2, "Two."],
    ],
  ],
  [
    "a thematic break ends an item and is no rule",
    "- One.\n***\n- Two.\n",
    [
      [1, "One."],
      [3, "Two."],
    ],
  ],
  [
    "Windows line ends read as the same lines",
    "- One.\r\n- Two.\r\n",
    [
      [1, "One."],
      [2, "Two."],
    ],
  ],
  ["a file of headings only has no rule", "# Rules\n\n## None yet\n", []],
  ["an empty file has no rule", "", []],
])("%s", (_, text, expected) => {
  expect(linesAndTexts(text)).toEqual(expected);
});

test("each rule cites its file", () => {
  expect(parseRules(REPO, file("- One.\n", "AGENTS.md")).map((r) => r.file)).toEqual(["AGENTS.md"]);
});

const idOf = (text: string, repo = REPO, path: RulesFile["path"] = "REVIEW.md") =>
  parseRules(repo, file(text, path))[0]?.id;

/** The rules' texts and sections, the headings above each. */
const sections = (text: string) => parseRules(REPO, file(text)).map((r) => [r.text, r.section]);

test("each rule keeps the headings above it, outermost first: the scope its file gives it", () => {
  const text = [
    "# Review rules",
    "",
    "- Everywhere.",
    "",
    "## Only in test fixtures",
    "",
    "- Plaintext credentials are allowed.",
    "",
    "### Snapshots ###",
    "",
    "- Keep them small.",
    "",
    "## Production code",
    "",
    "- Never hold a plaintext credential.",
    "",
    "#### Skipped a level",
    "- Deeper.",
    "",
    "# Other",
    "- Top.",
  ].join("\n");

  expect(sections(text)).toEqual([
    ["Everywhere.", ["Review rules"]],
    ["Plaintext credentials are allowed.", ["Review rules", "Only in test fixtures"]],
    ["Keep them small.", ["Review rules", "Only in test fixtures", "Snapshots"]],
    ["Never hold a plaintext credential.", ["Review rules", "Production code"]],
    ["Deeper.", ["Review rules", "Production code", "Skipped a level"]],
    ["Top.", ["Other"]],
  ]);
});

test("a setext heading scopes the rules beneath it like an ATX one; a rule before any heading has none", () => {
  const text = "- First.\n\nTests\n=====\n\n- In tests.\n\nFixtures and\nmocks\n---\n- In fixtures.\n";

  expect(sections(text)).toEqual([
    ["First.", []],
    ["In tests.", ["Tests"]],
    ["In fixtures.", ["Tests", "Fixtures and mocks"]],
  ]);
});

test("a heading inside a fence or a comment scopes nothing", () => {
  const text = "# Rules\n\n- Prefer:\n  ```\n  # not a heading\n  ```\n<!--\n# Old\n-->\n- Next.\n";

  expect(sections(text)).toEqual([
    ["Prefer:\n```\n# not a heading\n```", ["Rules"]],
    ["Next.", ["Rules"]],
  ]);
});

/** The rules' texts and the items each sits in, by their first lines. */
const parentsOf = (text: string) => parseRules(REPO, file(text)).map((r) => [r.text, r.parents]);

test("a nested rule keeps the items it sits in, outermost first: the scope its parent gives it", () => {
  const text = [
    "## Fixtures",
    "- Only in test fixtures:",
    "  more on where.",
    "  - Plaintext credentials are allowed.",
    "    1. Even long ones.",
    "  - Fake names too.",
    "- Everywhere else:",
    "",
    "  - Never a plaintext credential.",
    "",
    "Outside every list.",
    "",
    "    - Indented, but under no item.",
    "## Next",
    "  - Under a heading, no parent.",
  ].join("\n");

  expect(parentsOf(text)).toEqual([
    ["Only in test fixtures:\nmore on where.", []],
    ["Plaintext credentials are allowed.", ["Only in test fixtures:"]],
    ["Even long ones.", ["Only in test fixtures:", "Plaintext credentials are allowed."]],
    ["Fake names too.", ["Only in test fixtures:"]],
    ["Everywhere else:", []],
    ["Never a plaintext credential.", ["Everywhere else:"]],
    ["Indented, but under no item.", []],
    ["Under a heading, no parent.", []],
  ]);
  expect(sections(text)[1]).toEqual(["Plaintext credentials are allowed.", ["Fixtures"]]);
});

test("a rule's parents leave its id as it is", () => {
  const nested = parseRules(REPO, file("- Only in tests:\n  - Never log a token.\n"))[1];

  expect(nested?.parents).toEqual(["Only in tests:"]);
  expect(nested?.id).toBe(idOf("- Never log a token.\n"));
});

test("a heading leaves a rule's id as it is: the id is its text's", () => {
  expect(idOf("## Only in tests\n\n- Never log a token.\n")).toBe(idOf("- Never log a token.\n"));
});

test("the paragraphs of a file with a list are given as context, under their headings", () => {
  const [review] = promptRules(REPO, [
    file("# Rules\n\nWhat we look for.\n\n## Tests\n\nThese apply only to `tests/`.\n\n- Mocks are fine.\n"),
  ]);

  expect(review?.rules.map((r) => [r.label, r.text, r.section])).toEqual([
    ["R1", "Mocks are fine.", ["Rules", "Tests"]],
  ]);
  expect(review?.context).toEqual([
    { line: 3, text: "What we look for.", section: ["Rules"] },
    { line: 7, text: "These apply only to `tests/`.", section: ["Rules", "Tests"] },
  ]);
});

test("a file with no list has no context: its paragraphs are its rules", () => {
  const [review] = promptRules(REPO, [file("# Rules\n\nNever log a token.\n")]);

  expect(review?.rules.map((r) => [r.text, r.section])).toEqual([["Never log a token.", ["Rules"]]]);
  expect(review?.context).toEqual([]);
});

test("a rule's id stays when its lines move, its number or its spacing changes", () => {
  const id = idOf("- Never log a token.\n");

  expect(id).toMatch(/^[0-9a-f]{16}$/);
  expect(idOf("# Rules\n\n- Never log a token.\n")).toBe(id);
  expect(parseRules(REPO, file("- Use tabs.\n- Never log a token.\n"))[1]?.id).toBe(id);
  expect(idOf("3. Never   log a\n   token.\n")).toBe(id);
});

test("a rule's id is new when its text, its file or its repository changes", () => {
  const id = idOf("- Never log a token.\n");

  expect(idOf("- Never log a secret.\n")).not.toBe(id);
  expect(idOf("- Never log a token.\n", REPO, "AGENTS.md")).not.toBe(id);
  expect(idOf("- Never log a token.\n", OTHER_REPO)).not.toBe(id);
});

/** `n` different items of 99 bytes each, 100 with the line's end: `- `, the item's number in 3 digits, 94 letters. */
const items = (n: number, letter = "a") =>
  Array.from({ length: n }, (_, i) => `- ${String(i).padStart(3, "0")}${letter.repeat(94)}\n`).join("");

test("files within the budget are given whole, labelled across files in the order REVIEW, AGENTS, CLAUDE", () => {
  const given = promptRules(REPO, [
    file("- Claude's.\n", "CLAUDE.md"),
    file("- One.\n- Two.\n", "REVIEW.md"),
    file("- Agents'.\n", "AGENTS.md"),
  ]);

  expect(given.map((f) => [f.file, f.commit, f.cut, f.rules.map((r) => [r.label, r.line, r.text])])).toEqual([
    [
      "REVIEW.md",
      MAIN,
      null,
      [
        ["R1", 1, "One."],
        ["R2", 2, "Two."],
      ],
    ],
    ["AGENTS.md", MAIN, null, [["R3", 1, "Agents'."]]],
    ["CLAUDE.md", MAIN, null, [["R4", 1, "Claude's."]]],
  ]);
});

test("a rule switched off is left out and takes no label; its lines still count against the budget", () => {
  const [two] = parseRules(REPO, file("- Two.\n"));
  const [small] = promptRules(REPO, [file("- One.\n- Two.\n- Three.\n")], new Set([two?.id ?? ""]));
  expect(small?.rules.map((r) => [r.label, r.line, r.text])).toEqual([
    ["R1", 1, "One."],
    ["R2", 3, "Three."],
  ]);

  // 200 items of 100 bytes, the first off: the cut stays after line 163, and 162 rules are given.
  const [first] = parseRules(REPO, file(items(200)));
  const [cut] = promptRules(REPO, [file(items(200))], new Set([first?.id ?? ""]));
  expect(cut?.rules).toHaveLength(162);
  expect(cut?.rules.at(0)?.line).toBe(2);
  expect(cut?.rules.at(-1)?.label).toBe("R162");
  expect(cut?.cut).toEqual({ afterLine: 163, lines: 200 });
});

test("a rule switched off takes the rules nested in it with it, however deep; its siblings stay, labelled on", () => {
  const text =
    "## Tests\n\n- Only in fixtures:\n  - Mocks are fine:\n    - Never log a token.\n  - Dates are fixed.\n- Use tabs.\n";
  const rules = parseRules(REPO, file(text));
  expect(rules.map((r) => r.parentIds.length)).toEqual([0, 1, 2, 1, 0]);
  const mocks = rules[1]?.id ?? "";
  expect(rules[2]?.parentIds).toEqual([rules[0]?.id ?? "", mocks]);

  const [review] = promptRules(REPO, [file(text)], new Set([mocks]));
  expect(review?.rules.map((r) => [r.label, r.text, r.parents])).toEqual([
    ["R1", "Only in fixtures:", []],
    ["R2", "Dates are fixed.", ["Only in fixtures:"]],
    ["R3", "Use tabs.", []],
  ]);
  const [outer] = promptRules(REPO, [file(text)], new Set([rules[0]?.id ?? ""]));
  expect(outer?.rules.map((r) => [r.label, r.text])).toEqual([["R1", "Use tabs."]]);
  // The prompt's rules carry no ids of their parents.
  expect(outer?.rules[0]).not.toHaveProperty("parentIds");
});

test("a file over 16 KB is cut at the last line that fits, with how many lines it has", () => {
  // 200 items of 100 bytes: 20,000 bytes; 16 KB (16,384 bytes) holds 163 of them.
  const [review] = promptRules(REPO, [file(items(200))]);

  expect(review?.rules).toHaveLength(163);
  expect(review?.rules.at(-1)?.label).toBe("R163");
  expect(review?.cut).toEqual({ afterLine: 163, lines: 200 });
});

test("the budget counts bytes, not characters", () => {
  // 200 items of 99 characters, 94 of them "é": 193 bytes, 194 with the line's end; 16 KB holds 84 of them (163 if
  // counted in characters).
  const [review] = promptRules(REPO, [file(items(200, "é"))]);

  expect(review?.rules).toHaveLength(84);
  expect(review?.cut).toEqual({ afterLine: 84, lines: 200 });
});

/** One item: "- Prefer:", the lines `head`, then 200 lines of 100 bytes, past the 16 KB. */
const longItem = (head: string[]) => {
  const tail = Array.from({ length: 200 }, () => `  ${"y".repeat(97)}`);
  return file(`${["- Prefer:", ...head, ...tail].join("\n")}\n`);
};

test("a cut inside a fence closes the fence in the rule given", () => {
  // 10 and 6 bytes for the item's first two lines, then 163 lines of 100 fit in 16 KB.
  const [review] = promptRules(REPO, [longItem(["  ````"])]);
  const given = review?.rules[0]?.text.split("\n") ?? [];

  expect(review?.cut).toEqual({ afterLine: 165, lines: 202 });
  expect(given).toHaveLength(166);
  expect(given.at(-1)).toBe("````");
});

test("a cut after its fence closed adds nothing to the rule", () => {
  const [review] = promptRules(REPO, [longItem(["  ```", "  ~~~", "  ```"])]);
  const given = review?.rules[0]?.text.split("\n") ?? [];

  expect(review?.cut?.afterLine).toBe(167);
  expect(given).toHaveLength(167);
  expect(given.at(-1)).toBe("y".repeat(97));
});

test("the 32 KB in total go to REVIEW.md first, then AGENTS.md; CLAUDE.md gets what is left", () => {
  // 16,300 bytes each: REVIEW and AGENTS whole (32,600 bytes), 168 bytes left for CLAUDE: one item of 100.
  const given = promptRules(REPO, [
    file(items(163, "c"), "CLAUDE.md"),
    file(items(163, "a"), "AGENTS.md"),
    file(items(163, "r"), "REVIEW.md"),
  ]);

  expect(given.map((f) => [f.file, f.rules.length, f.cut])).toEqual([
    ["REVIEW.md", 163, null],
    ["AGENTS.md", 163, null],
    ["CLAUDE.md", 1, { afterLine: 1, lines: 163 }],
  ]);
});

test("a file the budget has no room for is listed with nothing given, cut after line 0", () => {
  const given = promptRules(REPO, [
    file(items(163, "r"), "REVIEW.md"),
    file(items(163, "a"), "AGENTS.md"),
    file(`- ${"c".repeat(200)}\n- c\n`, "CLAUDE.md"),
  ]);

  expect(given.at(-1)).toEqual({
    file: "CLAUDE.md",
    commit: MAIN,
    rules: [],
    context: [],
    cut: { afterLine: 0, lines: 2 },
  });
});

test("a rule the cut falls in keeps the lines before the cut, and the cut is said after the last of them", () => {
  // One item of 200 lines of 100 bytes: 163 of its lines fit in 16 KB.
  const lines = Array.from({ length: 200 }, (_, i) =>
    i === 0 ? `- ${"x".repeat(97)}` : `  ${"y".repeat(97)}`,
  );
  const [review] = promptRules(REPO, [file(`${lines.join("\n")}\n`)]);

  expect(review?.rules).toHaveLength(1);
  expect(review?.rules[0]?.text.split("\n")).toHaveLength(163);
  expect(review?.cut).toEqual({ afterLine: 163, lines: 200 });
});

test("the budget counts the headings and the context: past the cut, neither is given", () => {
  // A heading and a paragraph of 100 bytes each, then 200 items of 100: 16 KB holds both and 161 items.
  const [review] = promptRules(REPO, [file(`# ${"h".repeat(97)}\n${"p".repeat(99)}\n\n${items(200)}`)]);

  expect(review?.rules).toHaveLength(161);
  expect(review?.rules[0]?.section).toEqual(["h".repeat(97)]);
  expect(review?.context.map((c) => c.line)).toEqual([2]);
  expect(review?.cut).toEqual({ afterLine: 164, lines: 203 });

  const [late] = promptRules(REPO, [file(`${items(200)}\n${"p".repeat(99)}\n`)]);
  expect(late?.context).toEqual([]);
});

test("a cut rule keeps the whole rule's id: the rule cited is the file's", () => {
  const lines = Array.from({ length: 200 }, (_, i) =>
    i === 0 ? `- ${"x".repeat(97)}` : `  ${"y".repeat(97)}`,
  );
  const text = `${lines.join("\n")}\n`;

  expect(promptRules(REPO, [file(text)])[0]?.rules[0]?.id).toBe(parseRules(REPO, file(text))[0]?.id);
});
