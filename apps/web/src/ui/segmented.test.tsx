// A segmented control can dim one option alone, in place (design-system.md, Switch / checkbox / radio / segmented;
// ADR 0070): All reviews' filters that hold nothing. The whole control's `disabled` still dims every option.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Segmented } from "./basics.tsx";

const buttons = (html: string) => html.match(/<button[^>]*>[^<]*<\/button>/g) ?? [];

test("an option disabled alone is dimmed in place; the others stay pickable", () => {
  const html = renderToStaticMarkup(
    <Segmented
      label="Outcome"
      value="all"
      options={[
        { value: "all", label: "All" },
        { value: "skipped", label: "Skipped", disabled: true },
      ]}
      onChange={() => {}}
    />,
  );
  expect(buttons(html)).toEqual([
    '<button type="button" aria-pressed="true">All</button>',
    '<button type="button" disabled="" aria-pressed="false">Skipped</button>',
  ]);
});

test("the whole control disabled dims every option", () => {
  const html = renderToStaticMarkup(
    <Segmented
      label="Theme"
      value="dark"
      options={[
        { value: "dark", label: "Dark" },
        { value: "light", label: "Light" },
      ]}
      onChange={() => {}}
      disabled
    />,
  );
  expect(buttons(html).every((b) => b.includes('disabled=""'))).toBe(true);
});
