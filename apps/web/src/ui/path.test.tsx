// A path or a command as code: whole when short enough for a sentence; longer, each piece kept whole, a break offered
// only after a separator, or at a command's spaces.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CodePath } from "./path.tsx";

test("a citation short enough for its sentence is one piece, never split after its slashes", () => {
  expect(renderToStaticMarkup(<CodePath text="src/webhooks/payments.ts:12" />)).toBe(
    '<code class="path"><span class="piece">src/webhooks/payments.ts:12</span></code>',
  );
});

test("a citation followed by punctuation is drawn tight, as a commit is: no room before the full stop", () => {
  expect(renderToStaticMarkup(<CodePath text="src/a.ts:1" kind="path" tight />)).toBe(
    '<code class="path tight"><span class="piece">src/a.ts:1</span></code>',
  );
});

test("a long path breaks only after a backslash, never at the space inside it", () => {
  expect(renderToStaticMarkup(<CodePath text="C:\Users\Your Name\AppData\Local\bin" kind="path" />)).toBe(
    '<code class="path"><span class="piece">C:\\</span><wbr/><span class="piece">Users\\</span><wbr/><span class="piece">Your Name\\</span><wbr/><span class="piece">AppData\\</span><wbr/><span class="piece">Local\\</span><wbr/><span class="piece">bin</span></code>',
  );
});

test("on its own line, even a short command breaks at the spaces between its words and after a slash", () => {
  expect(renderToStaticMarkup(<CodePath text="~/bin/lookover wait" line />)).toBe(
    '<code class="path line"><span class="piece">~/</span><wbr/><span class="piece">bin/</span><wbr/><span class="piece">lookover</span> <span class="piece">wait</span></code>',
  );
});
