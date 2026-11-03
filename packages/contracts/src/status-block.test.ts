// The status block's splice into a pull request's description (ADR 0074): what the host port suite can't reach
// cheaply, as a table (CRLF, a closing marker before the opening one, two blocks, text after the block, an opening
// marker with no end left by the author).
import { describe, expect, test } from "bun:test";
import {
  commitSha,
  type Finding,
  findingPermalink,
  STATUS_END_MARKER,
  STATUS_MARKER,
  showsStatus,
  spliceStatus,
  statusOf,
  statusRoom,
} from "./index.ts";

describe("a finding's permalink, for one with no line comment", () => {
  const repo = { owner: "acme", name: "shop" };
  const base = commitSha("b".repeat(40));
  const one = commitSha("1".repeat(40));
  const two = commitSha("2".repeat(40));
  const commits = {
    base,
    rounds: [
      { n: 1, sha: one },
      { n: 2, sha: two },
    ],
  };
  type At = Pick<Finding, "side" | "anchoredIn" | "file" | "line" | "endLine">;
  const at = (o: Partial<At>): At => ({
    side: "head",
    anchoredIn: 2,
    file: "src/a b/c.ts",
    line: 4,
    endLine: null,
    ...o,
  });

  test("on the commit of the round its lines are on, its path escaped part by part, at its line or range", () => {
    expect(findingPermalink(repo, at({}), commits)).toEqual({
      url: `https://github.com/acme/shop/blob/${"2".repeat(40)}/src/a%20b/c.ts#L4`,
      sha: two,
    });
    expect(findingPermalink(repo, at({ anchoredIn: 1, endLine: 6 }), commits)).toEqual({
      url: `https://github.com/acme/shop/blob/${"1".repeat(40)}/src/a%20b/c.ts#L4-L6`,
      sha: one,
    });
    expect(findingPermalink(repo, at({ endLine: 4 }), commits)?.url).toBe(
      `https://github.com/acme/shop/blob/${"2".repeat(40)}/src/a%20b/c.ts#L4`,
    );
  });

  test("a base-side finding's on the merge base; none when its commit isn't known", () => {
    expect(findingPermalink(repo, at({ side: "base" }), commits)).toEqual({
      url: `https://github.com/acme/shop/blob/${"b".repeat(40)}/src/a%20b/c.ts#L4`,
      sha: base,
    });
    expect(findingPermalink(repo, at({ side: "base" }), { ...commits, base: null })).toBeNull();
    expect(findingPermalink(repo, at({ anchoredIn: 3 }), commits)).toBeNull();
  });
});

/** A block as the description holds it. */
const marked = (block: string) => `${STATUS_MARKER}\n${block}\n${STATUS_END_MARKER}`;

describe("the status block spliced into a description", () => {
  test.each([
    ["no description (GitHub's null)", null, marked("New")],
    ["an empty one", "", marked("New")],
    ["whitespace only: no rule above the block", " \n\n", marked("New")],
    [
      "the author's text: a rule between, their trailing whitespace trimmed",
      "Fixes the total.\n\n",
      `Fixes the total.\n\n---\n\n${marked("New")}`,
    ],
    [
      "a closing marker before any opening one: written anew at the end",
      `A ${STATUS_END_MARKER} B`,
      `A ${STATUS_END_MARKER} B\n\n---\n\n${marked("New")}`,
    ],
    [
      "an opening marker with no end: written anew at the end",
      `A\n${STATUS_MARKER}\nhalf`,
      `A\n${STATUS_MARKER}\nhalf\n\n---\n\n${marked("New")}`,
    ],
    [
      "a closing marker only before the opening one: written anew at the end",
      `${STATUS_END_MARKER}\n${STATUS_MARKER}`,
      `${STATUS_END_MARKER}\n${STATUS_MARKER}\n\n---\n\n${marked("New")}`,
    ],
  ] as const)("first write, %s", (_, description, expected) => {
    expect(spliceStatus(description, "New")).toBe(expected);
  });

  test.each([
    ["under the author's text", `Intro\n\n---\n\n${marked("Old")}`, `Intro\n\n---\n\n${marked("New")}`],
    [
      "CRLF outside the markers kept byte for byte",
      `Intro\r\n\r\n---\r\n\r\n${marked("Old")}\r\nAfter  `,
      `Intro\r\n\r\n---\r\n\r\n${marked("New")}\r\nAfter  `,
    ],
    [
      "text after the block stays where it is",
      `${marked("Old")}\n\nAdded by the author.`,
      `${marked("New")}\n\nAdded by the author.`,
    ],
    [
      "two blocks: the first is rewritten, the second left",
      `A${marked("One")}B${marked("Two")}C`,
      `A${marked("New")}B${marked("Two")}C`,
    ],
    [
      "the author's trailing whitespace kept",
      `Intro   \n\n\n${marked("Old")}`,
      `Intro   \n\n\n${marked("New")}`,
    ],
    ["a block someone emptied", `Intro\n${STATUS_MARKER}${STATUS_END_MARKER}`, `Intro\n${marked("New")}`],
    [
      "an opening marker with no end above the block: kept byte for byte, the block after it rewritten",
      `A\n${STATUS_MARKER}\nhalf\n\n---\n\n${marked("Old")}`,
      `A\n${STATUS_MARKER}\nhalf\n\n---\n\n${marked("New")}`,
    ],
    [
      "two opening markers before one end: the block from the last of them",
      `${STATUS_MARKER} A ${STATUS_MARKER}Old${STATUS_END_MARKER} B`,
      `${STATUS_MARKER} A ${marked("New")} B`,
    ],
  ] as const)("a rewrite, %s", (_, description, expected) => {
    expect(spliceStatus(description, "New")).toBe(expected);
  });
});

describe("the status block read back", () => {
  test("is the block last written", () => {
    expect(statusOf(spliceStatus("Intro", "Round 1\n\n- one"))).toBe("Round 1\n\n- one");
  });

  test("is the block after an opening marker the author left with no end", () => {
    expect(statusOf(spliceStatus(`A ${STATUS_MARKER} half`, "Round 1"))).toBe("Round 1");
  });

  test("is null with no block, or one with no end", () => {
    expect(statusOf(null)).toBeNull();
    expect(statusOf("Intro")).toBeNull();
    expect(statusOf(`Intro ${STATUS_MARKER} half`)).toBeNull();
  });
});

describe("a description showing a block", () => {
  test("is one holding it, its line endings and the newlines at its edges aside", () => {
    const crlf = `Intro\r\n\r\n---\r\n\r\n${STATUS_MARKER}\r\nRound 1\r\n\r\n- one\r\n${STATUS_END_MARKER}`;
    expect(showsStatus(crlf, "Round 1\n\n- one")).toBe(true);
    expect(showsStatus(`${STATUS_MARKER}\n\nRound 1\n\n${STATUS_END_MARKER}`, "Round 1")).toBe(true);
  });

  test("is not one holding another block, or none", () => {
    expect(showsStatus(spliceStatus("Intro", "Round 1"), "Round 2")).toBe(false);
    expect(showsStatus("Intro", "Round 1")).toBe(false);
    expect(showsStatus(null, "")).toBe(false);
  });
});

describe("the room left for the block", () => {
  test("is GitHub's 65,536 characters less the author's text, the rule and the markers", () => {
    // The markers are 24 and 25 characters, with a line break after the first and before the second.
    expect(statusRoom(null)).toBe(65_485);
    // "Hi", then "\n\n---\n\n".
    expect(statusRoom("Hi")).toBe(65_476);
    expect(statusRoom(`Hi\n\n---\n\n${marked("A long block that goes away")}`)).toBe(65_476);
  });

  test("counts characters, not bytes", () => {
    expect(statusRoom("é😀")).toBe(65_476);
  });

  test("is below zero when the author's text alone is past the limit", () => {
    expect(statusRoom("x".repeat(65_536))).toBe(-58);
  });
});
