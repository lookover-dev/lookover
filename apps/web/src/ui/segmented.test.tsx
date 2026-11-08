// A segmented control can hold one option alone that can't be pressed, in place (design-system.md, Switch / checkbox /
// radio / segmented; ADR 0070): All reviews' filters that hold nothing. It is drawn as any option not pressed, in
// `--muted`, never dimmed: an empty filter is still a place to go once something lands there. The whole control's
// `disabled` dims every option, said on the group so the style can tell the two apart.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Segmented } from "./basics.tsx";

const buttons = (html: string) => html.match(/<button[^>]*>[^<]*<\/button>/g) ?? [];
const group = (html: string) => html.match(/<div[^>]*>/)?.[0];

test("an option disabled alone can't be pressed, and the group isn't dimmed for it", () => {
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
  expect(group(html)).toBe('<div class="seg" role="group" aria-label="Outcome">');
});

test("the whole control disabled dims every option, said on the group", () => {
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
  expect(group(html)).toBe('<div class="seg" role="group" aria-label="Theme" aria-disabled="true">');
});
