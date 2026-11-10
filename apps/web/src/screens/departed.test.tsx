// Repositories' departed notices on the screen (design-system.md "Departed summary and No access", ADR 0082): the
// summary held down to one while the app is open, Dismiss all sending the ids the summary showed, a repository
// departing meanwhile still said, and an account gone in its No access notice. What the app holds is the store's; the
// notices' controls are read from the screen's own tree, there being no page to click in here.
import { expect, test } from "bun:test";
import {
  type Command,
  type DepartedRepository,
  type RepositoryId,
  repositoryId,
  type State,
  type UnreachedAccount,
} from "@lookover/contracts";
import { departedShown } from "../view-model/departed.ts";

import { RepositoriesChoice } from "../view-model/repositories.ts";
import { DepartedNotices } from "./departed.tsx";
import { app, elements, screen, world } from "./repositories.test-support.tsx";
import { RepositoriesOn } from "./settings.tsx";

const departed = (owner: string, name: string): DepartedRepository => ({
  id: repositoryId(`${owner}/${name}`),
  owner,
  name,
  at: 0,
});

const DOCS = departed("fernhill", "docs");
const SITE = departed("fernhill", "site");
const DOTFILES = departed("sasensi", "dotfiles");

const at = (gone: DepartedRepository[]): State => ({ ...world(), departed: gone });

/**
 * The page as it renders on `store`, and its notices' controls: the notices as the page gives them (the state, and
 * what the store holds of it), their commands kept, each control read from their tree.
 */
function page(state: State, store = app()) {
  // The state the page renders, taken by the store first, as the store does with each one (`store.test.ts`).
  store.leftSummary.see(state);
  const html = screen(store, state, () => RepositoriesOn({ choice: new RepositoriesChoice() }));
  const sent: Command[] = [];
  const tree = DepartedNotices({
    shown: departedShown(state, store.leftSummary.get()),
    connection: state.connection,
    send: (c) => sent.push(c),
  });
  /** The control `name` of the notice that has `held` too (a notice is told by the controls it has). */
  const control = (name: string, held = name) => {
    const found = elements(tree).find((e) => typeof e.props[held] === "function")?.props[name];
    if (typeof found !== "function") throw new Error(`no ${name} on the page`);
    return found;
  };
  return {
    html,
    /** What the page says, its tags left out. */
    text: html.replace(/<[^>]*>/g, ""),
    sent,
    dismissAll: () => control("dismissAll")(),
    dismiss: () => control("dismiss")(),
    /** The notice's link as GitHub's page opens (No access's fix, Add it back): what it sends, if anything. */
    open: () => control("opened")(),
    /** A line's Dismiss, in the summary. */
    line: (repoId: RepositoryId) => control("dismiss", "dismissAll")(repoId),
  };
}

test("two quiet: the summary and Dismiss all, which sends the ids it showed, not one departed since", () => {
  const shown = page(at([DOCS, SITE]));
  expect(shown.text).toContain("2 repositories left the App&#x27;s installation.");
  expect(shown.html).toContain("Dismiss all");
  expect(shown.html).not.toContain("Add it back");
  // dotfiles departs before the click lands: the click still names the two it showed.
  page(at([DOCS, SITE, DOTFILES]));
  shown.dismissAll();
  expect(shown.sent).toEqual([{ type: "repos.dismiss", repoIds: [DOCS.id, SITE.id] }]);
});

test("the summary's sentence sits flush under its label, as No access's: plain words, no control in it (round 6)", () => {
  const { html } = page(at([DOCS, SITE]));
  expect(html).toContain(
    '<span class="lb">Left</span>2 repositories left the App&#x27;s installation.</span>',
  );
  expect(html).not.toContain('class="disc-btn"');
});

/** A control's name: its `aria-label`, else its words, what is hidden from the reader (`aria-hidden`) left out. */
function nameOf(attributes: string, inner: string): string {
  const label = /aria-label="([^"]*)"/.exec(attributes)?.[1];
  if (label !== undefined) return label;
  return inner
    .replace(/<span aria-hidden="true">[^<]*<\/span>/g, "")
    .replace(/<span class="tip"[^>]*>.*?<\/span>/g, "")
    .replace(/<[^>]*>/g, "");
}

/**
 * Each notice on the page: its label, then what its action place holds, from its start to what opens under the notice
 * or the notice's end, by name, and its tooltips.
 */
function notices(html: string) {
  return html
    .split('<div class="banner')
    .slice(1)
    .map((notice) => {
      const from = notice.indexOf('<span class="banner-acts">');
      const below = notice.indexOf('<div class="banner-below');
      const acts = from < 0 ? "" : notice.slice(from, below < 0 ? undefined : below);
      return {
        label: /<span class="lb">([^<]*)<\/span>/.exec(notice)?.[1],
        acts: [...acts.matchAll(/<(a|button) ([^>]*)>(.*?)<\/\1>/g)].map(
          ([, , attributes = "", inner = ""]) => nameOf(attributes, inner),
        ),
        tips: [...acts.matchAll(/<span class="tip" role="tooltip">([^<]*)<\/span>/g)].map(([, tip]) => tip),
      };
    });
}

test("Left's summary is laid out as No access: label, sentence, then at the edge Show beside the same ×, Dismiss all", () => {
  const [sdk, cli] = [departed("ledger-labs", "ledger-sdk"), departed("ledger-labs", "ledger-cli")];
  const { html } = page(at([sdk, cli, DOCS, SITE]));
  const [gone, left] = notices(html);
  expect(gone).toEqual({
    label: "No access",
    acts: ["Install on ledger-labs", "Dismiss"],
    tips: ["Dismiss"],
  });
  // The disclosure at the action edge, beside the × where No access has its own, never inside what opens.
  expect(left).toEqual({
    label: "Left",
    acts: ["Show the 2 repositories", "Dismiss all"],
    tips: ["Dismiss all"],
  });
  expect(html).toMatch(
    /<span class="banner-acts"><button type="button" class="btn btn-quiet btn-sm " aria-label="Show the 2 repositories" aria-expanded="false" aria-controls="[^"]+">/,
  );
});

test("Show holds Hide's width (SameWidth), so the × beside it never moves as the list opens", () => {
  const { html } = page(at([DOCS, SITE]));
  expect(html).toContain(
    '<span class="same-width"><span class="same-width-slot">Show</span><span class="same-width-slot" aria-hidden="true">Hide</span></span></button>',
  );
});

test("the summary's Tab order follows the screen: Show, Dismiss all at the top right, then the lines (#643)", () => {
  const { html } = page(at([DOCS, SITE]));
  const left = html.slice(html.indexOf('<span class="lb">Left</span>'));
  const order = [
    left.indexOf('aria-label="Show the 2 repositories"'),
    left.indexOf('aria-label="Dismiss all"'),
    left.indexOf('class="banner-below'),
    left.indexOf('aria-label="Dismiss fernhill/docs"'),
  ];
  expect(order.every((at) => at >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
});

test("what opens is the button's, closed and out of Tab's way until Show is pressed", () => {
  const { html } = page(at([DOCS, SITE]));
  const controls = /aria-label="Show the 2 repositories" aria-expanded="false" aria-controls="([^"]+)"/.exec(
    html,
  )?.[1];
  expect(controls).toBeDefined();
  expect(html).toContain(`<div class="banner-below" id="${controls}" inert="">`);
});

test("once shown, the summary stays while the app is open, down to one; none left, a later one alone is alone", () => {
  const store = app();
  page(at([DOCS, SITE]), store);
  const one = page(at([SITE]), store).text;
  expect(one).toContain("1 repository left the App&#x27;s installation.");
  expect(one).toContain("Dismiss all");
  // The page left and visited again: still the summary.
  expect(page(at([SITE]), store).text).toContain("1 repository left");
  // None left: it goes; a later one alone is said alone, with Add it back.
  expect(page(at([]), store).text).not.toContain("left the App");
  const alone = page(at([DOTFILES]), store).html;
  expect(alone).toContain("Add it back");
  expect(alone).not.toContain("Dismiss all");
  // Another app, opened on one: alone.
  expect(page(at([SITE])).html).toContain("Add it back");
});

test("a line's dismiss, a quiet bordered button that says Dismiss and is named by its repository, dismisses it alone", () => {
  const shown = page(at([DOCS, SITE]));
  const lines = shown.html.match(/<li>.*?<\/li>/g) ?? [];
  expect(lines).toHaveLength(2);
  for (const [i, name] of ["fernhill/docs", "fernhill/site"].entries()) {
    const line = lines[i] ?? "";
    // The name as plain text, not bold: ten lines no heavier than the No access notice.
    expect(line).toContain(`<span class="departed-name">${name}</span>`);
    expect(line).toMatch(
      new RegExp(
        `<button type="button" class="btn btn-quiet btn-sm " aria-label="Dismiss ${name}">Dismiss</button>`,
      ),
    );
    expect(line).not.toContain('role="tooltip"');
  }
  shown.line(SITE.id);
  expect(shown.sent).toEqual([{ type: "repos.dismiss", repoIds: [SITE.id] }]);
});

test("an account gone: its No access notice, amber, with its fix; its × dismisses every repository it names", () => {
  const [sdk, cli] = [departed("ledger-labs", "ledger-sdk"), departed("ledger-labs", "ledger-cli")];
  const shown = page(at([sdk, cli, DOCS]));
  expect(shown.html).toContain('class="banner warn"');
  expect(shown.html).toContain("No access");
  expect(shown.html).toContain(
    "Lookover no longer has access to ledger-labs. Its 2 repositories are no longer reviewed.",
  );
  expect(shown.html).toContain("Install on ledger-labs");
  // fernhill/docs, of an account still there, alone and quiet.
  expect(shown.html).toContain("Add it back");
  shown.dismiss();
  expect(shown.sent).toEqual([{ type: "repos.dismiss", repoIds: [sdk.id, cli.id] }]);
});

test("an account gone the person is a member of: No access asks to install, and its fix sends the ask", () => {
  const base = at([departed("ledger-labs", "ledger-sdk")]);
  const member: UnreachedAccount = {
    account: { id: 501, login: "ledger-labs" },
    kind: "organisation",
    owner: false,
    askedAt: null,
  };
  const shown = page({ ...base, connection: { ...base.connection, unreached: [member] } });
  expect(shown.html).toContain("Ask to install on ledger-labs");
  shown.open();
  // The ask alone: the service starts the look as it keeps it (ADR 0088).
  expect(shown.sent).toEqual([{ type: "connection.askToInstall", account: "ledger-labs" }]);
});

test("an account gone the person owns: No access's Install on starts the look as GitHub's page opens (ADR 0088)", () => {
  const base = at([departed("ledger-labs", "ledger-sdk")]);
  const owned: UnreachedAccount = {
    account: { id: 501, login: "ledger-labs" },
    kind: "organisation",
    owner: true,
    askedAt: null,
  };
  const shown = page({ ...base, connection: { ...base.connection, unreached: [owned] } });
  expect(shown.html).toContain("Install on ledger-labs");
  shown.open();
  expect(shown.sent).toEqual([{ type: "connection.look" }]);
});

test("one repository left: Add it back starts the look as GitHub's page opens (ADR 0088)", () => {
  const shown = page(at([DOCS]));
  expect(shown.html).toContain("Add it back");
  shown.open();
  expect(shown.sent).toEqual([{ type: "connection.look" }]);
});
