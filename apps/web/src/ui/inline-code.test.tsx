// A finding's text renders its code spans as `<code>` and the rest as escaped text, nothing else (ADR 0070).
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { InlineCode } from "./inline-code.tsx";

test("code spans become code, the rest stays text", () => {
  expect(renderToStaticMarkup(<InlineCode text="When `day` is today, `it's" />)).toBe(
    "When <code>day</code> is today, `it&#x27;s",
  );
});

test("no other markdown: tags and emphasis stay as typed", () => {
  expect(renderToStaticMarkup(<InlineCode text="*a* <b>`<i>`</b>" />)).toBe(
    "*a* &lt;b&gt;<code>&lt;i&gt;</code>&lt;/b&gt;",
  );
});
