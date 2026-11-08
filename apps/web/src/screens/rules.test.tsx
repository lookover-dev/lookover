// Settings › Review rules (design-system.md "Switch / checkbox / radio / segmented", ADR 0049): a rule held off with
// the rule it sits in says so in words under its own, never in a tooltip over the row's values, and its switch is drawn
// held, not as a plain off one.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RuleRow, RuleSwitch, RulesHead, RulesIntro, RuleTitle } from "./settings.tsx";

const rule = {
  id: "r1",
  text: "A total is rounded once, at the end.",
  enabled: true,
  parentOff: false,
  nestedIn: false,
};

test("a rule of its own: its words alone, its switch plain", () => {
  expect(renderToStaticMarkup(<RuleTitle rule={rule} />)).toBe("<b>A total is rounded once, at the end.</b>");
  const html = renderToStaticMarkup(<RuleSwitch rule={rule} save={() => {}} />);
  expect(html).toStartWith('<label class="switch">');
  expect(html).not.toContain("disabled");
});

test("a rule held off with the rule it sits in: why, in words under it, and a held switch with no tooltip", () => {
  const held = { ...rule, nestedIn: true, parentOff: true };
  expect(renderToStaticMarkup(<RuleTitle rule={held} />)).toBe(
    '<b>A total is rounded once, at the end.</b><span class="rule-held">Off with the rule it sits in.</span>',
  );
  const html = renderToStaticMarkup(<RuleSwitch rule={held} save={() => {}} />);
  expect(html).toStartWith('<label class="switch held">');
  expect(html).toContain('aria-label="A total is rounded once, at the end. Off with the rule it sits in."');
  expect(html).toContain('disabled=""');
  expect(html).not.toContain("tooltip");
});

test("a nested rule keeps the room of why under its words while its parent is on, so no row moves as the parent toggles", () => {
  const nested = { ...rule, nestedIn: true };
  expect(renderToStaticMarkup(<RuleTitle rule={nested} />)).toBe(
    '<b>A total is rounded once, at the end.</b><span class="rule-held room" aria-hidden="true">Off with the rule it sits in.</span>',
  );
});

test("the save stamp sits by the switches it confirms: on the line over the table, at its end, not by the page's title", () => {
  const html = renderToStaticMarkup(<RulesIntro stamp={{ shown: "saved", text: "Saved" }} />);
  // The page's one description (round 6: the title's own line and this one said the same thing twice).
  expect(html).toStartWith(
    '<div class="rules-intro"><p class="t-small t-help">What the reviewer checks, read from REVIEW.md, AGENTS.md and CLAUDE.md on each repository&#x27;s default branch.</p>',
  );
  expect(html).toMatch(/<\/p><span class="save-state "[^>]*>.*Saved<\/span><\/div>$/);
});

test("a rule's From is two lines, its repository over its file and line, so the rule's words get the room (round 6)", () => {
  const row = (source: { repo: string | null; where: string }) =>
    renderToStaticMarkup(
      <table>
        <tbody>
          <RuleRow rule={{ ...rule, raised: 0, acted: 0 }} source={source} save={() => {}} />
        </tbody>
      </table>,
    );
  expect(row({ repo: "lookover-sandbox", where: "REVIEW.md, line 3" })).toContain(
    '<td class="from"><span class="t-small">lookover-sandbox</span><span class="t-small">REVIEW.md, line 3</span></td>',
  );
  expect(row({ repo: null, where: "you" })).toContain(
    '<td class="from"><span class="t-small">you</span></td>',
  );
});

test("the columns' names can't be confused: Verified fixed for the findings, In use for the switch", () => {
  const html = renderToStaticMarkup(
    <table>
      <RulesHead />
    </table>,
  );
  const names = [...html.matchAll(/<th>([^<]*)<\/th>/g)].map((m) => m[1] ?? "");
  // "Verified fixed", never "Fixed" alone, which reads as claimed fixed too (GLOSSARY.md).
  expect(names).toEqual(["Rule", "From", "Raised", "Verified fixed", "In use"]);
  // No name is a word of another's ("On" was one of "Acted on").
  for (const name of names)
    for (const other of names)
      if (other !== name) expect(other.toLowerCase().split(" ")).not.toContain(name.toLowerCase());
  // The column says it: the intro explains no name.
  expect(renderToStaticMarkup(<RulesIntro stamp={{ shown: "hidden", text: "" }} />)).not.toContain("“");
});

test("a nested rule's row is set in under the rule it sits in, so its held switch reads as that rule's", () => {
  const row = (r: typeof rule) =>
    renderToStaticMarkup(
      <table>
        <tbody>
          <RuleRow
            rule={{ ...r, raised: 0, acted: 0 }}
            source={{ repo: "lookover-sandbox", where: "REVIEW.md, line 6" }}
            save={() => {}}
          />
        </tbody>
      </table>,
    );
  expect(row(rule)).toContain('<td class="rule">');
  expect(row({ ...rule, nestedIn: true })).toContain('<td class="rule nested">');
});
