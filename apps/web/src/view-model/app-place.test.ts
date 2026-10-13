// Where "Create your App" makes the App (ADR 0059): the choices and the line under them, for a given connection.
// Connections are built by hand: the view model reads state only.
import { expect, test } from "bun:test";
import { type Connection, type GhChoices, GITHUB_WEB } from "@lookover/contracts";
import { appPlace } from "./app-place.ts";

const SAM = { id: 7, login: "sam" };
const LEDGER = { id: 338, login: "ledger-dev" };
const ACME = { id: 40, login: "acme" };

function connection(patch: Partial<Connection> = {}): Connection {
  return {
    id: null,
    state: "not-connected",
    cause: null,
    bot: null,
    app: null,
    installationId: null,
    web: GITHUB_WEB,
    since: 0,
    limitUntil: null,
    gh: null,
    ...patch,
  };
}

const listed = (...organisations: { id: number; login: string }[]): GhChoices => ({
  person: { kind: "signed-in", account: SAM },
  organisations: { kind: "listed", organisations },
});

const OWN = { organisation: null, label: "Your GitHub account", detail: "Repositories you own." };
const org = (login: string) => ({
  organisation: login,
  label: login,
  detail: "An organisation you're an admin of.",
});

const NOT_AN_ADMIN =
  "Not an admin of your organisation? Ask an admin to create the App there, then give it under “Advanced: use an existing App”, below.";
const SIGNED_OUT = {
  before: "To create it on an organisation, run",
  command: "gh auth login",
  after: "and check again.",
};
const MISSING = {
  before: "To create it on an organisation, install gh, then run",
  command: "gh auth login",
  after: "and check again.",
};

test("your own account first, then each organisation gh lists you as an admin of; your own account chosen unless you pick one", () => {
  const view = appPlace(connection({ gh: listed(LEDGER, ACME) }), null);
  expect(view.options).toEqual([OWN, org("ledger-dev"), org("acme")]);
  expect(view.chosen).toBeNull();
  expect(view.enabled).toBe(true);
  expect(view.line).toBe(NOT_AN_ADMIN);
  expect(appPlace(connection({ gh: listed(LEDGER, ACME) }), "acme").chosen).toBe("acme");
});

test("an organisation picked that gh no longer lists falls back to your own account", () => {
  expect(appPlace(connection({ gh: listed(LEDGER) }), "acme").chosen).toBeNull();
  expect(appPlace(connection({ gh: null }), "acme").chosen).toBeNull();
});

test("gh signed out or missing: your own account still there, alone, with the one command and check again", () => {
  const signedOut = appPlace(
    connection({ gh: { person: { kind: "signed-out" }, organisations: { kind: "signed-out" } } }),
    null,
  );
  expect(signedOut.options).toEqual([OWN]);
  expect(signedOut.chosen).toBeNull();
  expect(signedOut.line).toEqual(SIGNED_OUT);
  const missing = appPlace(
    connection({ gh: { person: { kind: "missing" }, organisations: { kind: "missing" } } }),
    null,
  );
  expect(missing.options).toEqual([OWN]);
  expect(missing.line).toEqual(MISSING);
});

test("gh couldn't answer: why, in plain words, never gh's own", () => {
  const unanswered = (why: "offline" | "sso" | "scope" | "timeout" | "failed") =>
    appPlace(
      connection({
        gh: { person: { kind: "signed-in", account: SAM }, organisations: { kind: "unanswered", why } },
      }),
      null,
    ).line;
  expect(unanswered("offline")).toBe(
    "gh couldn't reach GitHub to list your organisations. Check again in a moment.",
  );
  expect(unanswered("timeout")).toBe("gh didn't answer in time. Check again in a moment.");
  expect(unanswered("failed")).toBe("gh couldn't list your organisations. Check again in a moment.");
  expect(unanswered("sso")).toBe(
    "An organisation's single sign-on refused gh. Authorise gh's token for it on GitHub, then check again.",
  );
  expect(unanswered("scope")).toEqual({
    before: "gh needs the read:org scope to list your organisations. Run",
    command: "gh auth refresh -s read:org",
    after: "to add it, then check again.",
  });
});

test("before gh is read, the line says it is looking", () => {
  const view = appPlace(connection(), null);
  expect(view.options).toEqual([OWN]);
  expect(view.line).toBe("Looking for the organisations you're an admin of…");
});

test("the line keeps the height of every line it can show, so nothing under it moves when gh answers", () => {
  const view = appPlace(connection(), null);
  expect(view.held).toEqual(
    expect.arrayContaining([
      "Looking for the organisations you're an admin of…",
      NOT_AN_ADMIN,
      SIGNED_OUT,
      MISSING,
      "gh couldn't reach GitHub to list your organisations. Check again in a moment.",
    ]),
  );
  expect(view.held).toContainEqual(view.line);
});

test("the list keeps the room of your own account and two organisations, so those gh lists move nothing under it", () => {
  expect(appPlace(connection(), null).spare).toBe(2);
  expect(appPlace(connection({ gh: listed() }), null).spare).toBe(2);
  expect(appPlace(connection({ gh: listed(LEDGER) }), null).spare).toBe(1);
  expect(appPlace(connection({ gh: listed(LEDGER, ACME) }), null).spare).toBe(0);
  expect(appPlace(connection({ gh: listed(LEDGER, ACME, { id: 41, login: "acme-labs" }) }), null).spare).toBe(
    0,
  );
});

test("once the App is made, the choice is where it was made, and can't change", () => {
  const onOrganisation = appPlace(
    connection({
      gh: listed(),
      app: {
        id: 1,
        slug: "lookover-k3x9q2",
        account: { ...LEDGER, type: "Organization" },
        person: SAM,
      },
    }),
    null,
  );
  // Still shown though gh no longer lists it: it is where the App is.
  expect(onOrganisation.options).toEqual([OWN, org("ledger-dev")]);
  expect(onOrganisation.chosen).toBe("ledger-dev");
  expect(onOrganisation.enabled).toBe(false);
  // The line says where it is, in the room the other lines keep; nothing is left to check.
  expect(onOrganisation.line).toBe("Your App is on ledger-dev.");
  expect(onOrganisation.held).toContain("Your App is on ledger-dev.");
  expect(onOrganisation.held).toContain(NOT_AN_ADMIN);
  const own = appPlace(
    connection({
      gh: listed(LEDGER),
      app: { id: 1, slug: "lookover-k3x9q2", account: { ...SAM, type: "User" }, person: SAM },
    }),
    "ledger-dev",
  );
  expect(own.chosen).toBeNull();
  expect(own.enabled).toBe(false);
  expect(own.line).toBe("Your App is on your GitHub account.");
});
