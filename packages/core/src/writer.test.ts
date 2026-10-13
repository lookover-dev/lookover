// Who wrote a change (ADR 0044): read from what the host shows, the `Co-authored-by` trailers of its commits and its
// branch prefix, the newest signal winning; none means unknown.
import { expect, test } from "bun:test";
import { writerOf } from "./index.ts";

const CLAUDE_CODE = "Fix the total\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>";
const CODEX = "Rewrite the filter\n\nCo-authored-by: Codex <codex@openai.com>";
const BY_HAND = "Bump the version";

test("a commit whose trailer names Claude Code or Codex says who wrote the change", () => {
  expect(writerOf({ branch: "fix-total", messages: [CLAUDE_CODE], before: null })).toBe("claude");
  expect(writerOf({ branch: "fix-total", messages: [CODEX], before: null })).toBe("codex");
});

test("the trailer is read whatever its case, by name or by the address it gives", () => {
  const trailers: [string, "claude" | "codex"][] = [
    ["co-authored-by: Claude <noreply@anthropic.com>", "claude"],
    ["CO-AUTHORED-BY: claude", "claude"],
    ["Co-authored-by: Anthropic <noreply@anthropic.com>", "claude"],
    ["Co-authored-by: Codex", "codex"],
    ["Co-authored-by: ChatGPT Codex Connector <codex@openai.com>", "codex"],
    ["Co-authored-by: OpenAI <codex@openai.com>", "codex"],
  ];
  for (const [trailer, engine] of trailers) {
    expect([trailer, writerOf({ branch: "main", messages: [`Work\n\n${trailer}`], before: null })]).toEqual([
      trailer,
      engine,
    ]);
  }
});

test("another co-author, or a trailer's words in the body, says nothing", () => {
  const messages = [
    "Pair on the total\n\nCo-authored-by: Octo Cat <octocat@github.com>",
    "Pair again\n\nCo-authored-by: Ada <ada@anthropic.com>\nCo-authored-by: Sam <sam@openai.com>",
    "Explain the trailers\n\nWe add Co-authored-by: Claude to agents' commits.",
    "Claude helped with this one",
  ];
  expect(writerOf({ branch: "pairing", messages, before: null })).toBeNull();
});

test("a co-author named Claude or Codex is the engine only with no address, the company's, or the agent's bot", () => {
  const trailers: [string, "claude" | "codex" | null][] = [
    ["Co-authored-by: Claude Shannon <claude@example.com>", null],
    ["Co-authored-by: Claude Monet <monet@users.noreply.github.com>", null],
    ["Co-authored-by: Codex Team <team@example.org>", null],
    ["Co-authored-by: Claude <somebody@anthropic.com>", "claude"],
    ["Co-authored-by: Codex <somebody@openai.com>", "codex"],
    ["Co-authored-by: Claude <209825114+claude[bot]@users.noreply.github.com>", "claude"],
    [
      "Co-authored-by: chatgpt-codex-connector[bot] <199175422+chatgpt-codex-connector[bot]@users.noreply.github.com>",
      "codex",
    ],
  ];
  for (const [trailer, engine] of trailers) {
    expect([trailer, writerOf({ branch: "main", messages: [`Work\n\n${trailer}`], before: null })]).toEqual([
      trailer,
      engine,
    ]);
  }
});

test("the branch prefix says who wrote it when no commit does", () => {
  expect(writerOf({ branch: "claude/fix-total", messages: [BY_HAND], before: null })).toBe("claude");
  expect(writerOf({ branch: "codex/fix-total", messages: [], before: null })).toBe("codex");
  // Only a prefix: a branch that merely names one is no signal.
  expect(writerOf({ branch: "fix-claude-prompt", messages: [], before: null })).toBeNull();
  expect(writerOf({ branch: "claude", messages: [], before: null })).toBeNull();
});

test("the newest signal wins: the newest commit with a trailer, over older commits and the branch", () => {
  expect(writerOf({ branch: "claude/fix", messages: [CLAUDE_CODE, CODEX, BY_HAND], before: null })).toBe(
    "codex",
  );
  expect(writerOf({ branch: "codex/fix", messages: [CLAUDE_CODE], before: null })).toBe("claude");
});

test("a push whose commits say nothing keeps who wrote the change before it", () => {
  expect(writerOf({ branch: "fix-total", messages: [BY_HAND], before: "codex" })).toBe("codex");
  // What was known before came from older commits, which are newer than the branch.
  expect(writerOf({ branch: "claude/fix", messages: [], before: "codex" })).toBe("codex");
  // A trailer in the pushed commits is newer still.
  expect(writerOf({ branch: "fix-total", messages: [CLAUDE_CODE], before: "codex" })).toBe("claude");
});

test("a commit naming both agents is read by its last trailer", () => {
  const both =
    "Work\n\nCo-authored-by: Codex <codex@openai.com>\nCo-Authored-By: Claude <noreply@anthropic.com>";
  expect(writerOf({ branch: "main", messages: [both], before: null })).toBe("claude");
});
