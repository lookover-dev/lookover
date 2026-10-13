// Reading Lookover's threads (ADR 0052): the newest unanswered reply after Lookover's last word, from the owner or
// the change's author (the owner only on a fork's change), its first line read with the grammar. Expected values
// are written by hand from the record, never recomputed the way the code does it.
import { expect, test } from "bun:test";
import {
  FINDING_MARKER,
  type Finding,
  type FindingStatus,
  findingId,
  type HostThread,
  type HostThreadReply,
  REPLY_MARKER,
  type Severity,
} from "@lookover/contracts";
import { readThreads } from "./index.ts";

const OWNER = { id: 1, login: "owner", bot: false };
const AUTHOR = { id: 2, login: "author", bot: false };
const STRANGER = { id: 3, login: "stranger", bot: false };
const LOOKOVER = { id: 99, login: "lookover[bot]", bot: true };
const OTHER_BOT = { id: 98, login: "linter[bot]", bot: true };

/** The hidden marker on Lookover's own reply, naming the claim it answers, as `publish` writes it. */
const answers = (claim: HostThreadReply, finding = "F1") =>
  `${REPLY_MARKER}${JSON.stringify({ v: 1, run: "run-2", finding, claim: claim.commentId })} -->`;

const SAME_REPO = { owner: { id: 1 }, author: { id: 2 }, fork: false };

function finding(n: number, status: FindingStatus = "open", extra: Partial<Finding> = {}): Finding {
  const severity: Severity = "should_fix";
  return {
    id: findingId(`F${n}`),
    fingerprints: { location: `loc${n}`, meaning: `meaning${n}` },
    severity,
    category: "Correctness",
    title: `Title ${n}`,
    file: "src/app.ts",
    side: "head",
    line: n,
    endLine: null,
    lineText: null,
    anchoring: "reported",
    body: `Body ${n}`,
    foundBy: "claude",
    confirmation: { verdict: "not_checked", demoted: false },
    why: { ruleText: null },
    rule: null,
    snippet: null,
    fix: null,
    status,
    posted: true,
    commented: true,
    raisedIn: 1,
    anchoredIn: 1,
    closedIn: null,
    verifiedSha: null,
    closedWhy: null,
    claim: null,
    kept: 0,
    ...extra,
  };
}

let nextId = 1000;
function reply(
  author: HostThreadReply["author"],
  body: string,
  at = "2026-10-10T10:00:00Z",
): HostThreadReply {
  nextId += 1;
  return { commentId: nextId, nodeId: `PRRC_${nextId}`, author, body, at };
}

function thread(n: number, replies: HostThreadReply[], extra: Partial<HostThread> = {}): HostThread {
  return {
    commentId: 500 + n,
    url: `https://github.com/o/r/pull/7#discussion_r${500 + n}`,
    nodeId: `PRRC_${500 + n}`,
    findingId: findingId(`F${n}`),
    outdated: false,
    replies,
    ...extra,
  };
}

/** The kind each first line is read as, on one thread each. */
function kindsOf(bodies: string[]): (string | undefined)[] {
  const ledger = bodies.map((_, i) => finding(i + 1));
  const threads = bodies.map((body, i) => thread(i + 1, [reply(AUTHOR, body)]));
  const reading = readThreads(ledger, threads, SAME_REPO);
  return ledger.map((f) => reading.claims.find((c) => c.findingId === f.id)?.kind);
}

test("the first line names the claim, case-insensitive; anything else is a question", () => {
  expect(
    kindsOf([
      "Fixed",
      "fixed in a1b2c3d",
      "FIXED: moved the check up.",
      "Won't fix: the header is needed.",
      "Won’t fix, on purpose.",
      "wontfix",
      "Disputed: the client sets a timeout.",
      "False positive",
      "not a bug: see line 12",
      "Deferred to #42.",
      "Out of scope for this change.",
      "Why is this a problem?",
      "Fixedness is not the point.",
      "I fixed it.",
    ]),
  ).toEqual([
    "claimed_fixed",
    "claimed_fixed",
    "claimed_fixed",
    "wont_fix",
    "wont_fix",
    "wont_fix",
    "disputed",
    "disputed",
    "disputed",
    "deferred",
    "deferred",
    "question",
    "question",
    "question",
  ]);
});

test("only the first line names it; the claim keeps the whole reply, who wrote it, when and its id", () => {
  const r = reply(AUTHOR, "  Won't fix\nThe header is needed by the proxy.  ", "2026-10-10T11:00:00Z");
  const reading = readThreads([finding(1)], [thread(1, [r])], SAME_REPO);
  expect(reading.claims).toEqual([
    {
      findingId: findingId("F1"),
      kind: "wont_fix",
      text: "Won't fix\nThe header is needed by the proxy.",
      by: "author",
      at: "2026-10-10T11:00:00Z",
      commentId: r.commentId,
    },
  ]);
});

test("the newest reply from the owner or the author counts; anyone else's, a bot's included, is never read", () => {
  const ledger = [finding(1), finding(2), finding(3)];
  const threads = [
    thread(1, [reply(AUTHOR, "Won't fix"), reply(OWNER, "Disputed: intended."), reply(STRANGER, "Fixed")]),
    thread(2, [reply(STRANGER, "Not a bug"), reply(OTHER_BOT, "Fixed")]),
    thread(3, [reply(OWNER, "Fixed"), reply(AUTHOR, "Deferred")]),
  ];
  const reading = readThreads(ledger, threads, SAME_REPO);
  expect(reading.claims.map((c) => [String(c.findingId), c.kind, c.by])).toEqual([
    ["F1", "disputed", "owner"],
    ["F3", "deferred", "author"],
  ]);
});

test("on a fork's change only the owner's reply counts, even from the change's author", () => {
  const ledger = [finding(1), finding(2)];
  const threads = [
    thread(1, [reply(OWNER, "Won't fix"), reply(AUTHOR, "Fixed")]),
    thread(2, [reply(AUTHOR, "Not a bug")]),
  ];
  const reading = readThreads(ledger, threads, { ...SAME_REPO, fork: true });
  expect(reading.claims.map((c) => [String(c.findingId), c.kind, c.by])).toEqual([
    ["F1", "wont_fix", "owner"],
  ]);
});

test("only a reply after the claim Lookover last answered counts: one it already answered is not a claim", () => {
  const ledger = [finding(1), finding(2)];
  const disputed = reply(AUTHOR, "Disputed");
  const why = reply(AUTHOR, "Why?");
  const threads = [
    // Lookover answered the dispute; nothing since.
    thread(1, [disputed, reply(LOOKOVER, `Still there: line 9 reads it.\n${answers(disputed)}`)]),
    // Lookover answered the question; the author answered back.
    thread(2, [
      why,
      reply(LOOKOVER, `The loop never ends.\n${answers(why, "F2")}`),
      reply(AUTHOR, "Won't fix"),
    ]),
  ];
  const reading = readThreads(ledger, threads, SAME_REPO);
  expect(reading.claims.map((c) => [String(c.findingId), c.kind])).toEqual([["F2", "wont_fix"]]);
});

test("a claim Lookover answered with its reply, as publish writes it, is not read again", () => {
  // `publish`'s reply exactly: its words, a blank line, then the marker with the run, the finding and the claim.
  const claim = reply(AUTHOR, "Won't fix");
  const marker = `${REPLY_MARKER}${JSON.stringify({ v: 1, run: "run-2", finding: "F1", claim: claim.commentId })} -->`;
  const answer = `Kept.\n\nThe loop still stops one short.\n\nIf it is kept again, the owner decides.\n\n${marker}`;
  const ledger = [finding(1)];
  const threads = [thread(1, [claim, reply(LOOKOVER, answer)])];
  expect(readThreads(ledger, threads, SAME_REPO).claims).toEqual([]);
});

test("a claim written while a round ran, before Lookover's reply to the one it read, is read next round", () => {
  // The round read A; the author wrote B while it ran; Lookover's reply to A landed after B.
  const a = reply(AUTHOR, "Why does it loop?", "2026-10-10T10:00:00Z");
  const b = reply(AUTHOR, "Won't fix", "2026-10-10T10:01:00Z");
  const answer = reply(LOOKOVER, `The retry never stops.\n\n${answers(a)}`, "2026-10-10T10:02:00Z");
  const ledger = [
    finding(1, "open", {
      claim: { kind: "question", text: a.body, by: "author", at: a.at, commentId: a.commentId },
    }),
  ];
  const reading = readThreads(ledger, [thread(1, [a, b, answer])], SAME_REPO);
  expect(reading.claims.map((c) => [c.kind, c.commentId])).toEqual([["wont_fix", b.commentId]]);
  // Without the ledger's record of A too: the marker names what Lookover answered, not what came before its reply.
  const bare = readThreads([finding(1)], [thread(1, [a, b, answer])], SAME_REPO);
  expect(bare.claims.map((c) => [c.kind, c.commentId])).toEqual([["wont_fix", b.commentId]]);
});

test("a claim older than the one the finding holds is never read, even when the newer one is gone", () => {
  const old = reply(AUTHOR, "Deferred");
  const held = reply(AUTHOR, "Won't fix");
  const ledger = [
    finding(1, "open", {
      claim: { kind: "wont_fix", text: held.body, by: "author", at: held.at, commentId: held.commentId },
    }),
  ];
  expect(readThreads(ledger, [thread(1, [old])], SAME_REPO).claims).toEqual([]);
});

test("only a bot's reply with Lookover's reply marker is Lookover's word: another App quoting Lookover hides nothing", () => {
  const ledger = [finding(1), finding(2), finding(3)];
  const threads = [
    thread(1, [reply(AUTHOR, "Won't fix"), reply(OTHER_BOT, "Coverage: 80%.")]),
    // Another App quotes Lookover's finding comment, marker included.
    thread(2, [
      reply(AUTHOR, "Deferred"),
      reply(OTHER_BOT, `Lookover said:\n${FINDING_MARKER}{"v":1,"id":"F2"} -->`),
    ]),
    // A person pasting Lookover's reply marker is still a person.
    thread(3, [reply(AUTHOR, `Disputed\n${REPLY_MARKER}{"v":1,"finding":"F3","claim":1} -->`)]),
  ];
  const reading = readThreads(ledger, threads, SAME_REPO);
  expect(reading.claims.map((c) => [String(c.findingId), c.kind])).toEqual([
    ["F1", "wont_fix"],
    ["F2", "deferred"],
    ["F3", "disputed"],
  ]);
});

test("a claim the finding already holds is not read twice", () => {
  const read = reply(AUTHOR, "Won't fix");
  const ledger = [
    finding(1, "open", {
      claim: { kind: "wont_fix", text: "Won't fix", by: "author", at: read.at, commentId: read.commentId },
    }),
  ];
  expect(readThreads(ledger, [thread(1, [read])], SAME_REPO).claims).toEqual([]);
  // A newer reply is.
  const newer = reply(AUTHOR, "Fixed in b2c3d4e");
  const reading = readThreads(ledger, [thread(1, [read, newer])], SAME_REPO);
  expect(reading.claims.map((c) => [c.kind, c.commentId])).toEqual([["claimed_fixed", newer.commentId]]);
});

test("an outdated thread is read by its marker's finding, whatever line it was on", () => {
  const ledger = [finding(1, "open", { line: 40 })];
  const threads = [thread(1, [reply(AUTHOR, "Fixed")], { outdated: true })];
  expect(readThreads(ledger, threads, SAME_REPO).claims.map((c) => [String(c.findingId), c.kind])).toEqual([
    ["F1", "claimed_fixed"],
  ]);
});

test("a thread on no finding of the ledger, or on a settled one, gives no claim; a thread with no reply neither", () => {
  const ledger = [finding(1, "verified_fixed", { closedIn: 2 }), finding(2), finding(3, "escalated")];
  const threads = [
    thread(1, [reply(AUTHOR, "Fixed")]),
    thread(2, []),
    thread(3, [reply(OWNER, "Won't fix")]),
    thread(9, [reply(AUTHOR, "Won't fix")]),
  ];
  const reading = readThreads(ledger, threads, SAME_REPO);
  expect(reading.claims.map((c) => [String(c.findingId), c.kind])).toEqual([["F3", "wont_fix"]]);
});

test("the claims come in the ledger's order", () => {
  const ledger = [finding(1), finding(2)];
  const threads = [thread(2, [reply(AUTHOR, "Fixed")]), thread(1, [reply(AUTHOR, "Deferred")])];
  expect(readThreads(ledger, threads, SAME_REPO).claims.map((c) => String(c.findingId))).toEqual([
    "F1",
    "F2",
  ]);
});

test("the owner's dismissal, as publish writes it, is Lookover's word, answers no claim, and leaves its finding unread", () => {
  // `publish`'s dismissal reply exactly: no run, no claim, the dismissal's id and the finding.
  const marker = `${REPLY_MARKER}${JSON.stringify({ v: 1, dismissal: "dismissal-1", finding: "F1" })} -->`;
  const dismissal = reply(
    LOOKOVER,
    `Dismissed by the owner.\n\nIt won't be raised again on this pull request.\n\n${marker}`,
  );
  const after = reply(AUTHOR, "Won't fix");
  const dismissed = finding(1, "dismissed", { closedIn: 1 });
  expect(readThreads([dismissed], [thread(1, [dismissal, after])], SAME_REPO).claims).toEqual([]);
  // On a finding still unsettled, the dismissal answers nothing: the claim before it is still read.
  const before = reply(AUTHOR, "Deferred");
  const reading = readThreads([finding(1)], [thread(1, [before, dismissal])], SAME_REPO);
  expect(reading.claims.map((c) => [c.kind, c.commentId])).toEqual([["deferred", before.commentId]]);
});
