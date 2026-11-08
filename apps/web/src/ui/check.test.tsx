// A checkbox standing for several can be mixed (design-system.md, Switch / checkbox / radio / segmented; ADR 0082):
// setup's account heads, some of whose repositories are ticked. It is announced as mixed and not checked, so the
// browser's click reports it ticked (the web app's tests have no DOM to click in).
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Check } from "./basics.tsx";

const input = (html: string) => html.match(/<input[^>]*>/)?.[0] ?? "";

test("a mixed checkbox is announced as mixed, named by its label, and rendered not checked", () => {
  const html = renderToStaticMarkup(
    <Check checked={false} mixed onChange={() => {}} label="Review every repository in fernhill">
      fernhill
    </Check>,
  );
  expect(input(html)).toBe(
    '<input type="checkbox" aria-checked="mixed" aria-label="Review every repository in fernhill"/>',
  );
});

test("a checkbox not mixed says nothing more than its own state", () => {
  expect(
    input(
      renderToStaticMarkup(
        <Check checked onChange={() => {}}>
          api
        </Check>,
      ),
    ),
  ).toBe('<input type="checkbox" checked=""/>');
  expect(
    input(
      renderToStaticMarkup(
        <Check checked={false} onChange={() => {}}>
          api
        </Check>,
      ),
    ),
  ).toBe('<input type="checkbox"/>');
});
