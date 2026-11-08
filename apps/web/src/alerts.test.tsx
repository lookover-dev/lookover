// The alert band's lines (design-system.md "Alert band", "Refused line"): each is tinted by its own tone, so a
// Waiting line beside one that needs you is amber, never on pink, and a band of one refused command is amber too.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AlertLine, RefusedLine } from "./shell.tsx";
import type { Problem } from "./view-model/select.ts";

const problem = (tone: Problem["tone"]): Problem => ({
  id: "claude",
  tone,
  short: "Claude signed out",
  title: "Claude is signed out",
  detail: "Its reviews wait until you sign in again.",
  fix: null,
  busy: false,
});

test("a line that needs the person is a pink line, labelled Needs you", () => {
  const html = renderToStaticMarkup(<AlertLine problem={problem("need")} fix={null} />);
  expect(html).toMatch(/^<div class="alert need"><span class="alert-label">Needs you<\/span>/);
});

test("a line that only waits is an amber line, labelled Waiting, whatever else the band holds", () => {
  const html = renderToStaticMarkup(<AlertLine problem={problem("warn")} fix={null} />);
  expect(html).toMatch(/^<div class="alert warn"><span class="alert-label">Waiting<\/span>/);
});

test("a refused command is an amber line of its own: a band holding only it is amber", () => {
  const html = renderToStaticMarkup(
    <RefusedLine refusal={{ status: 409, error: "loading" }} dismiss={() => {}} />,
  );
  expect(html).toMatch(/^<div class="alert warn refused"><span class="alert-label">Refused<\/span>/);
});
