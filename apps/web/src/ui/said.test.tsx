// A sentence's command: whole in the sentence when short, on its own line under it when too long; a device code whole.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { IN_DISPLAY } from "../view-model/said.ts";
import { Said } from "./basics.tsx";

const FOLDER = "C:\\Users\\Your Name\\.claude\\skills\\lookover-review-loop";

test("a folder too long for its sentence goes on its own line, under the sentence said without it", () => {
  const html = renderToStaticMarkup(
    <Said
      words={{
        before: "Installs it in",
        command: FOLDER,
        kind: "path",
        after: "today.",
        alone: "Installs it today, in:",
      }}
    />,
  );
  expect(html).toBe(
    '<span class="said">Installs it today, in:<code class="path line"><span class="piece">C:\\</span><wbr/><span class="piece">Users\\</span><wbr/><span class="piece">Your Name\\</span><wbr/><span class="piece">.claude\\</span><wbr/><span class="piece">skills\\</span><wbr/><span class="piece">lookover-review-loop</span></code></span>',
  );
});

test("a short command sits in its sentence as one piece, never broken", () => {
  const html = renderToStaticMarkup(<Said words={{ before: "Run", command: "lookover open", after: "." }} />);
  expect(html).toBe(
    '<span class="said">Run <code class="path"><span class="piece">lookover open</span></code>.</span>',
  );
});

test("a device code is one piece, in its own face", () => {
  const html = renderToStaticMarkup(
    <Said words={{ before: "Enter", command: "WDJB-MJHT", kind: "device-code", after: "on GitHub." }} />,
  );
  expect(html).toBe('<span class="said">Enter <code class="device-code">WDJB-MJHT</code> on GitHub.</span>');
});

test("with a display-size sentence's limit, a command too long for it goes on its own line", () => {
  const words = { before: "Run", command: "lookover open --home=/tmp/a", after: ".", alone: "Run:" };
  expect(renderToStaticMarkup(<Said words={words} />)).toContain('Run <code class="path">');
  expect(renderToStaticMarkup(<Said words={words} max={IN_DISPLAY} />)).toContain(
    'Run:<code class="path line">',
  );
  // With no sentence to say it alone, it stays in the sentence, cut into its pieces.
  const inSentence = { before: "Run", command: "lookover open --home=/tmp/a", after: "." };
  expect(renderToStaticMarkup(<Said words={inSentence} max={IN_DISPLAY} />)).toContain(
    '<span class="piece">lookover</span> <span class="piece">open</span>',
  );
});
