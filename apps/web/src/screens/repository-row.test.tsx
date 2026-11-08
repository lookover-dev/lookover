// Repositories' rows (design-system.md "Table"): a repository's name without its owner, its group's head naming the
// account; its open pull requests counted, zero included and muted, so the rare row with any stands out and none reads as
// missing (row 47, round 5).
import { expect, test } from "bun:test";
import { changeId } from "@lookover/contracts";
import { app, change, screen, world } from "./repositories.test-support.tsx";

test("a repository's row names it without its owner, its switch still naming it whole", () => {
  const html = screen(app());
  expect(html).toContain("<b>ledger-api</b>");
  expect(html).toContain("<b>api</b>");
  expect(html).not.toContain("<b>sasensi/ledger-api</b>");
  expect(html).not.toContain("<b>fernhill/api</b>");
  // Two accounts may each have an api: the switch's name says whose.
  expect(html).toContain('aria-label="Review fernhill/api"');
});

test("a repository's link names it whole to a screen reader, its owner and its name", () => {
  const html = screen(app());
  expect(html).toMatch(/<a [^>]*aria-label="fernhill\/api"[^>]*><b>api<\/b><\/a>/);
  expect(html).toMatch(/<a [^>]*aria-label="sasensi\/ledger-api"[^>]*><b>ledger-api<\/b><\/a>/);
});

test("every reviewed repository says how many pull requests are open, zero included, muted, in the same place", () => {
  const state = world();
  state.changes = { [changeId("fernhill/api#3")]: change("fernhill/api", 3) };
  const html = screen(app(), state);
  // ledger-api, dotfiles and cli are reviewed with nothing open; web is off and says so; api has one open.
  expect(html.match(/<span class="repos-open[^"]*">\d+ open<\/span>/g)?.sort()).toEqual([
    '<span class="repos-open open-zero">0 open</span>',
    '<span class="repos-open open-zero">0 open</span>',
    '<span class="repos-open open-zero">0 open</span>',
    '<span class="repos-open">1 open</span>',
  ]);
  // Zero is data: no blank cell said only to a screen reader, no dash.
  expect(html).not.toContain('visually-hidden">no open pull requests');
  expect(html).not.toContain("–");
  expect(html).toContain("not reviewed");
});
