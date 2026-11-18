// A labelled input (design-system.md "Input"): its label above, the help below, both tied to the field by id, so a
// screen reader says the name and the help on focus; the field passes on what an input takes. An error takes the
// help's place, in pink, and marks the field invalid, its border pink too.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Input } from "./basics.tsx";

test("the label above names the field, the help below describes it, the field takes an input's props", () => {
  const html = renderToStaticMarkup(
    <Input label="Why, in one line" help="Optional." maxLength={200} defaultValue="" />,
  );
  const id = /<input[^>]* id="([^"]+)"/.exec(html)?.[1];
  const help = /<span class="help" id="([^"]+)"/.exec(html)?.[1];
  expect(id).toBeDefined();
  expect(help).toBeDefined();
  expect(html.startsWith('<div class="field">')).toBe(true);
  expect(html).toContain(`<label for="${id}">Why, in one line</label>`);
  expect(html).toContain(`aria-describedby="${help}"`);
  expect(html).toContain('class="input"');
  expect(html).toContain('maxLength="200"');
  expect(html.indexOf("<label")).toBeLessThan(html.indexOf("<input"));
  expect(html.indexOf("<input")).toBeLessThan(html.indexOf('class="help"'));
});

test("with no help, nothing describes the field", () => {
  const html = renderToStaticMarkup(<Input label="Name" />);
  expect(html).not.toContain("aria-describedby");
  expect(html).not.toContain('class="help"');
});

test("an error takes the help's place, describes the field and marks it invalid", () => {
  const html = renderToStaticMarkup(
    <Input label="Why, in one line" help="Optional." error="Keep it to 200 characters." defaultValue="" />,
  );
  const err = /<span class="err" id="([^"]+)"/.exec(html)?.[1];
  expect(err).toBeDefined();
  expect(html).toContain(`aria-describedby="${err}"`);
  expect(html).toContain('aria-invalid="true"');
  expect(html).toContain("Keep it to 200 characters.");
  expect(html).not.toContain('class="help"');
  expect(html).not.toContain("Optional.");
});

test("with no error, the field is not marked invalid", () => {
  expect(renderToStaticMarkup(<Input label="Name" help="Optional." />)).not.toContain("aria-invalid");
});
