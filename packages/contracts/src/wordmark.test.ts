// The wordmark every post on GitHub opens with (ADR 0074), as the owner's prototype wrote it, and taken off again.
import { describe, expect, test } from "bun:test";
import { WORDMARK_URLS, withoutWordmark, wordmark } from "./index.ts";

describe("the wordmark", () => {
  test("is the prototype's markup byte for byte, at the height asked", () => {
    expect(wordmark(26)).toBe(
      '<a href="https://lookover.dev"><picture><source media="(prefers-color-scheme: dark)" srcset="https://lookover.dev/brand/lookover-wordmark-on-dark.svg"><img src="https://lookover.dev/brand/lookover-wordmark.svg" height="26" alt="Lookover" align="absmiddle"></picture></a>',
    );
    expect(wordmark(18)).toContain('height="18"');
  });

  test("draws the two files the site keeps", () => {
    expect(WORDMARK_URLS).toEqual({
      light: "https://lookover.dev/brand/lookover-wordmark.svg",
      dark: "https://lookover.dev/brand/lookover-wordmark-on-dark.svg",
    });
  });
});

describe("a post without its wordmark opening", () => {
  test("a reply reads from its kind on", () => {
    expect(withoutWordmark(`${wordmark(18)} · Withdrawn\n\nThe guard is there.`)).toBe(
      "Withdrawn\n\nThe guard is there.",
    );
  });

  test("whatever the height", () => {
    expect(withoutWordmark(`${wordmark(26)} · Kept`)).toBe("Kept");
  });

  test("a post that doesn't open with it is left as it is", () => {
    for (const body of ["Lookover · Kept", `Kept, ${wordmark(18)} · later`, ""])
      expect(withoutWordmark(body)).toBe(body);
  });
});
