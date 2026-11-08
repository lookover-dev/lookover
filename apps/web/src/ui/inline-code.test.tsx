// A finding's text renders its code spans as `<code>` and the rest as escaped text, nothing else (ADR 0070).
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { InlineCode } from "./inline-code.tsx";

test("code spans become code, the rest stays text", () => {
  expect(renderToStaticMarkup(<InlineCode text="When `day` is today, `it's" />)).toBe(
    'When <code class="path"><span class="piece">day</span></code> is today, `it&#x27;s',
  );
});

test("no other markdown: tags and emphasis stay as typed", () => {
  expect(renderToStaticMarkup(<InlineCode text="*a* <b>`<i>`</b>" />)).toBe(
    '*a* &lt;b&gt;<code class="path"><span class="piece">&lt;i&gt;</span></code>&lt;/b&gt;',
  );
});

test("a short path in a code span is never broken; a long one only after its separators", () => {
  expect(renderToStaticMarkup(<InlineCode text="See `src/a.ts`." />)).toBe(
    'See <code class="path"><span class="piece">src/a.ts</span></code>.',
  );
  expect(renderToStaticMarkup(<InlineCode text="See `src/webhooks/handlers/payments/refund.ts`." />)).toBe(
    'See <code class="path"><span class="piece">src/</span><wbr/><span class="piece">webhooks/</span><wbr/><span class="piece">handlers/</span><wbr/><span class="piece">payments/</span><wbr/><span class="piece">refund.ts</span></code>.',
  );
});
