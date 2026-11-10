// The look line (ADR 0088) for each state a connection can be in: its words, Check again, and the hidden status line,
// which changes with the state and never with each new time. Connections are built by hand: the view model reads
// the look, the accounts waiting for an owner and GitHub's wait only.
import { expect, test } from "bun:test";
import type { Connection, InstallLook } from "@lookover/contracts";
import { arrivalToast, type LookLineView, type LookWords, lookLine } from "./look-line.ts";

/** 2026-11-10 16:00:00 UTC; times are said in UTC here. */
const NOW = Date.UTC(2026, 10, 10, 16, 0, 0);
const S = 1000;
const MIN = 60 * S;

/** A look begun a minute ago, running for two more. */
const RUNNING: InstallLook = {
  since: NOW - MIN,
  until: NOW + 2 * MIN,
  lookedAt: null,
  ended: null,
  arrived: null,
  stopped: null,
};

type Seen = Pick<Connection, "look" | "unreached" | "limitUntil" | "cause" | "listingCause">;
const connection = (o: Partial<Seen> = {}): Seen => ({
  look: null,
  unreached: [],
  limitUntil: null,
  cause: null,
  listingCause: null,
  ...o,
});
const ended = (o: Partial<InstallLook>): InstallLook => ({ ...RUNNING, until: NOW, ended: NOW, ...o });
const line = (c: Seen, now = NOW): LookLineView => lookLine({ now, connection: c }, { timeZone: "UTC" });
/** Words as read, the time to the second written apart (`[16:02:31]`). */
const said = (words: LookWords) => words.map((w) => (typeof w === "string" ? w : `[${w.time}]`)).join("");
/** What setup's line shows: its short words and its one action. */
const shown = (v: LookLineView) => `${v.state}: ${said(v.words)} | ${v.again.label}`;
const ledgerHq = { account: { id: 3, login: "ledger-hq" }, kind: "organisation" as const, owner: false };
const nothingNew = connection({ look: ended({}) });
const ownerAsked = connection({ look: ended({}), unreached: [{ ...ledgerHq, askedAt: NOW - 5 * MIN }] });

test("each state says its one line, and Check again is there in every one", () => {
  expect(
    [
      connection(),
      connection({ look: RUNNING }),
      connection({ look: { ...RUNNING, lookedAt: NOW - 3 * S + 451 } }),
      connection({ look: ended({ arrived: { accounts: ["ledger-labs"], back: [], repositories: 3 } }) }),
      connection({ look: ended({ arrived: { accounts: ["ledger-labs"], back: [], repositories: 1 } }) }),
      connection({ look: ended({ arrived: { accounts: ["ledger-labs"], back: [], repositories: 0 } }) }),
      // A login is named up to the accounts list's 16 characters, cut there as its row cuts it.
      connection({
        look: ended({ arrived: { accounts: ["ledger-labs-tools"], back: [], repositories: 3 } }),
      }),
      connection({
        look: ended({ arrived: { accounts: ["ledger-labs", "mira"], back: [], repositories: 5 } }),
      }),
      connection({
        look: ended({ arrived: { accounts: ["ledger-labs", "mira"], back: [], repositories: 0 } }),
      }),
      connection({ look: ended({ arrived: { accounts: [], back: [], repositories: 2 } }) }),
      connection({ look: ended({ arrived: { accounts: [], back: [], repositories: 1 } }) }),
      nothingNew,
      ownerAsked,
      connection({ look: ended({}), unreached: [{ ...ledgerHq, askedAt: null }] }),
      connection({ look: ended({ stopped: "rate-limited" }), limitUntil: NOW + 20 * MIN }),
      connection({ look: ended({ stopped: "rate-limited" }), limitUntil: NOW + 24 * 60 * MIN }),
      // GitHub's wait over, Lookover checks at its pace again.
      connection({ look: ended({ stopped: "rate-limited" }), limitUntil: NOW - S }),
      connection({ look: ended({ stopped: "rate-limited" }), limitUntil: null }),
    ].map((c) => shown(line(c))),
  ).toEqual([
    "idle: Lookover checks GitHub every 2 minutes. | Check again",
    "looking: Looking on GitHub every few seconds. | Check again",
    "looking: Looking every few seconds, last at [15:59:57]. | Check again",
    "arrived: ledger-labs arrived: 3 repositories. | Check again",
    "arrived: ledger-labs arrived: 1 repository. | Check again",
    "arrived: ledger-labs arrived: no repository. | Check again",
    "arrived: ledger-labs-tool… arrived: 3 repositories. | Check again",
    "arrived: 2 accounts arrived: 5 repositories. | Check again",
    "arrived: 2 accounts arrived: no repository. | Check again",
    "arrived: 2 repositories arrived. | Check again",
    "arrived: 1 repository arrived. | Check again",
    "nothing: Nothing new yet. Checking every 2 minutes. | Check again",
    "nothing: Nothing new yet. Checking every 2 minutes. | Check again",
    "nothing: Nothing new yet. Checking every 2 minutes. | Check again",
    "stopped: GitHub asked to wait until 16:20. | Check again",
    "stopped: GitHub asked to wait until tomorrow 16:00. | Check again",
    "idle: Lookover checks GitHub every 2 minutes. | Check again",
    "idle: Lookover checks GitHub every 2 minutes. | Check again",
  ]);
});

test("Settings' fuller line says what nothing new can mean and the step, and that Lookover keeps checking", () => {
  expect(
    [
      nothingNew,
      ownerAsked,
      connection({ look: ended({ stopped: "rate-limited" }), limitUntil: NOW + 20 * MIN }),
      connection({ look: ended({ arrived: { accounts: ["ledger-labs"], back: [], repositories: 3 } }) }),
      connection({ look: { ...RUNNING, lookedAt: NOW - 3 * S } }),
      connection(),
    ].map((c) => `${line(c).state}: ${said(line(c).full)}`),
  ).toEqual([
    "nothing: Nothing new yet. Lookover checks every 2 minutes; on GitHub, install it and choose a repository.",
    "nothing: Nothing new yet. Lookover checks every 2 minutes; an owner may still have to approve the request.",
    "stopped: GitHub asks Lookover to wait until 16:20.",
    "arrived: ledger-labs arrived: 3 repositories.",
    "looking: Looking every few seconds, last at [15:59:57].",
    "idle: Lookover checks GitHub every 2 minutes.",
  ]);
});

test("both nothing-new forms say how often Lookover checks, and neither asks a question", () => {
  for (const c of [nothingNew, ownerAsked])
    for (const words of [line(c).words, line(c).full]) {
      expect(said(words)).toContain("every 2 minutes");
      expect(said(words)).not.toContain("?");
    }
});

test("an account back from a cause (unsuspended, installed again) is said as back, in both forms and the toast", () => {
  const back = (accounts: string[], backs: string[], repositories: number) =>
    line(connection({ look: ended({ arrived: { accounts, back: backs, repositories } }) }));
  expect(
    [
      back([], ["ledger-labs"], 3),
      back([], ["ledger-labs"], 0),
      back([], ["ledger-labs-tools"], 1),
      back([], ["ledger-labs", "mira"], 4),
      // One new and one back: two accounts came, the new one arrived.
      back(["mira"], ["ledger-labs"], 5),
    ].map((v) => `${v.state}: ${said(v.words)} / ${said(v.full)}`),
  ).toEqual([
    "arrived: ledger-labs is back: 3 repositories. / ledger-labs is back: 3 repositories.",
    "arrived: ledger-labs is back: no repository. / ledger-labs is back: no repository.",
    "arrived: ledger-labs-tool… is back: 1 repository. / ledger-labs-tool… is back: 1 repository.",
    "arrived: 2 accounts are back: 4 repositories. / 2 accounts are back: 4 repositories.",
    "arrived: 2 accounts arrived: 5 repositories. / 2 accounts arrived: 5 repositories.",
  ]);
  expect(
    arrivalToast(RUNNING, ended({ arrived: { accounts: [], back: ["ledger-labs"], repositories: 3 } })),
  ).toBe("ledger-labs is back: 3 repositories.");
});

test("while a listing is refused, the line names no pace: Lookover tries again sooner than every 2 minutes", () => {
  const unreachable = { kind: "unreachable" } as const;
  expect(
    [
      connection({ listingCause: unreachable }),
      connection({ cause: unreachable }),
      connection({ look: ended({}), cause: unreachable }),
      connection({ look: ended({}), listingCause: unreachable, unreached: [{ ...ledgerHq, askedAt: NOW }] }),
    ].map((c) => `${line(c).state}: ${said(line(c).words)} / ${said(line(c).full)}`),
  ).toEqual([
    "idle: Lookover keeps checking GitHub. / Lookover keeps checking GitHub.",
    "idle: Lookover keeps checking GitHub. / Lookover keeps checking GitHub.",
    "nothing: Nothing new yet. Lookover keeps checking. / Nothing new yet. Lookover keeps checking; on GitHub, install it and choose a repository.",
    "nothing: Nothing new yet. Lookover keeps checking. / Nothing new yet. Lookover keeps checking; an owner may still have to approve the request.",
  ]);
});

test("Check again sends the look, whatever the state", () => {
  for (const look of [null, RUNNING, ended({}), ended({ stopped: "rate-limited" })])
    expect(line(connection({ look, limitUntil: NOW + MIN })).again.command).toEqual({
      type: "connection.look",
    });
});

test("the status line says a state as it comes, in the fuller words, never each new time it looked; an arrival is the toast's", () => {
  const looking = (lookedAt: number | null, now: number) =>
    line(connection({ look: { ...RUNNING, lookedAt } }), now).status;
  expect(new Set([looking(null, NOW), looking(NOW, NOW), looking(NOW + 4 * S, NOW + 4 * S)])).toEqual(
    new Set(["Looking on GitHub every few seconds."]),
  );
  expect(line(connection()).status).toBe("");
  expect(
    line(connection({ look: ended({ arrived: { accounts: ["ledger-labs"], back: [], repositories: 3 } }) }))
      .status,
  ).toBe("");
  expect(line(nothingNew).status).toBe(
    "Nothing new yet. Lookover checks every 2 minutes; on GitHub, install it and choose a repository.",
  );
  expect(
    line(connection({ look: ended({ stopped: "rate-limited" }), limitUntil: NOW + 20 * MIN })).status,
  ).toBe("GitHub asks Lookover to wait until 16:20.");
});

test("a look's arrival is toasted once, in the line's words; nothing while it runs, ended with nothing new, or already said", () => {
  const ledgerLabs = ended({ arrived: { accounts: ["ledger-labs"], back: [], repositories: 3 } });
  const later = { ...RUNNING, since: NOW + MIN, until: NOW + 4 * MIN };
  expect([
    arrivalToast(RUNNING, ledgerLabs),
    // A look that began and arrived between two states the service sent.
    arrivalToast(null, ledgerLabs),
    arrivalToast(ended({}), ledgerLabs),
    arrivalToast(
      RUNNING,
      ended({ arrived: { accounts: ["ledger-labs", "mira"], back: [], repositories: 0 } }),
    ),
    arrivalToast(RUNNING, ended({ arrived: { accounts: [], back: [], repositories: 1 } })),
    arrivalToast(RUNNING, ended({ arrived: { accounts: ["ledger-labs-tools"], back: [], repositories: 2 } })),
    // The same arrival in a later state (something else changed): once per look.
    arrivalToast(ledgerLabs, ledgerLabs),
    arrivalToast(ledgerLabs, { ...ledgerLabs, lookedAt: NOW }),
    arrivalToast(null, RUNNING),
    arrivalToast(RUNNING, { ...RUNNING, lookedAt: NOW }),
    arrivalToast(RUNNING, ended({})),
    arrivalToast(RUNNING, ended({ stopped: "rate-limited" })),
    arrivalToast(RUNNING, null),
    // A new look after an arrival: nothing until it finds something of its own.
    arrivalToast(ledgerLabs, later),
    arrivalToast(later, { ...later, ended: NOW + MIN, arrived: { accounts: [], back: [], repositories: 1 } }),
  ]).toEqual([
    "ledger-labs arrived: 3 repositories.",
    "ledger-labs arrived: 3 repositories.",
    "ledger-labs arrived: 3 repositories.",
    "2 accounts arrived: no repository.",
    "1 repository arrived.",
    "ledger-labs-tool… arrived: 2 repositories.",
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    "1 repository arrived.",
  ]);
});
