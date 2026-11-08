// A commit is drawn one way on every review screen (design-system.md "Inline code"): its first seven characters, as
// inline code.
import { expect, test } from "bun:test";
import { commitSha } from "@lookover/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { Sha, ShaWords } from "./sha.tsx";

test("a commit is its first seven characters as inline code, whether given whole or short", () => {
  expect(renderToStaticMarkup(<Sha sha="a6e7f80c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a" />)).toBe(
    '<code class="sha">a6e7f80</code>',
  );
  expect(renderToStaticMarkup(<Sha sha="c9d0e1f" />)).toBe('<code class="sha">c9d0e1f</code>');
});

test("a commit followed by punctuation keeps it tight: no room on its right, so it never reads as 'a7b8c9d .'", () => {
  expect(renderToStaticMarkup(<Sha sha="a7b8c9d" tight />)).toBe('<code class="sha tight">a7b8c9d</code>');
});

test("words with a commit in them: the text as said, the commit as a Sha, tight before punctuation only", () => {
  const sha = (s: string) => ({ commit: commitSha(s) });
  expect(renderToStaticMarkup(<ShaWords words={["Looked over ", sha("a7b8c9d"), ". Two things."]} />)).toBe(
    'Looked over <code class="sha tight">a7b8c9d</code>. Two things.',
  );
  expect(
    renderToStaticMarkup(<ShaWords words={["Couldn't look over ", sha("b2e8d1f"), " 3 min ago"]} />),
  ).toBe('Couldn&#x27;t look over <code class="sha">b2e8d1f</code> 3 min ago');
  expect(renderToStaticMarkup(<ShaWords words={["On ", sha("b2e8d1f")]} />)).toBe(
    'On <code class="sha">b2e8d1f</code>',
  );
});
