// `lookover` on the shared App (ADR 0066): nothing names the App, several people's Lookovers post under it, each
// as its person, and the agent reads only its own person's checks and threads. Each case on both ways in (`MODES`).
import { describe, expect, test } from "bun:test";
import { REPLY_MARKER, reviewRequest, SHARED_APP } from "@lookover/contracts";
import {
  APP,
  colleague,
  finding,
  iso,
  MODES,
  owner,
  ref,
  result,
  sha,
  world,
} from "./agent-cli.test-support.ts";

/** A round started a minute before the start, with F1 to fix. */
const fix = (id = "F1") =>
  result({
    run: { started_at: iso(-60_000), completed_at: iso(-30_000) },
    loop: { next_action: "fix" },
    verdict: { value: "blocking", conclusion: "neutral" },
    findings: [finding(id)],
  });

describe("no App named", () => {
  test("the shared App's checks are read, with nothing to say so", async () => {
    const w = world({ shared: true, env: {} });
    expect(w.app).toBe(SHARED_APP.slug);
    w.at(10_000, () => w.check("round", "queued"));
    w.at(30_000, () => w.complete("round", "success", result({})));
    expect(await w.lookover("wait")).toBe(0);
  });

  test("an own App's checks, with nothing naming it, are not read: no review appears under the shared App", async () => {
    const w = world({ env: {} });
    w.at(10_000, () => w.check("round", "queued"));
    w.at(30_000, () => w.complete("round", "success", result({})));
    expect(await w.lookover("wait", "--appear-timeout", "1m")).toBe(9);
  });

  test("LOOKOVER_APP naming an own App reads its checks", async () => {
    const w = world({ env: { LOOKOVER_APP: APP } });
    w.at(10_000, () => w.check("round", "queued"));
    w.at(30_000, () => w.complete("round", "success", result({})));
    expect(await w.lookover("wait")).toBe(0);
  });
});

for (const { mode, shared } of MODES)
  describe(`whose checks, on ${mode}`, () => {
    test("two people's checks on one commit: the agent's own is read, never the other's, even when newer", async () => {
      const w = world({ shared });
      w.at(10_000, () => w.check("mine", "queued"));
      w.at(20_000, () => w.check("theirs", "queued", sha, colleague.id));
      w.at(30_000, () => w.complete("theirs", "success", result({})));
      w.at(50_000, () => w.complete("mine", "neutral", fix()));
      expect(await w.lookover("wait")).toBe(3);
      expect(w.elapsed()).toBe(50_000);
    });

    test("another person's check alone answers nothing: the request is posted, and no review appears", async () => {
      const w = world({ shared });
      await w.check("theirs", "in_progress", sha, colleague.id);
      await w.complete("theirs", "success", result({}));
      expect(await w.lookover("wait", "--appear-timeout", "1m")).toBe(9);
      expect(w.comments().map((c) => c.body)).toEqual([reviewRequest(sha)]);
    });

    test("a colleague's 👀 on their request is no sign Lookover has the agent's: no review appears in time", async () => {
      const w = world({ shared });
      const theirs = w.fake.seedComment(ref, { author: colleague, body: reviewRequest(sha) });
      await w.fake.react(ref.repo, theirs, "eyes");
      w.at(40_000, () => w.check("mine", "queued"));
      w.at(60_000, () => w.complete("mine", "success", result({})));
      expect(await w.lookover("wait", "--appear-timeout", "30s")).toBe(9);
      expect(w.comments().map((c) => c.body)).toEqual([reviewRequest(sha), reviewRequest(sha)]);
      expect(w.err[0]).toBe("Asked Lookover to review 5d9114c (pull request #7).");
    });

    test("a colleague's request for the commit: the agent's own request is posted and its check read", async () => {
      const w = world({ shared });
      w.fake.seedComment(ref, { author: colleague, body: reviewRequest(sha) });
      w.at(10_000, () => w.check("mine", "queued"));
      w.at(30_000, () => w.complete("mine", "success", result({})));
      expect(await w.lookover("wait")).toBe(0);
      expect(w.comments().map((c) => c.author.id)).toEqual([colleague.id, owner.id]);
    });

    test("a colleague's request naming the agent's reply is no request of the agent's: it asks its own", async () => {
      const w = world({ shared });
      const [root = 0] = await w.review("F1");
      await w.check("first", "in_progress");
      await w.complete("first", "neutral", fix());
      const reply = w.agentReply(root, "Won't fix: the caller checks the range.");
      const theirs = w.fake.seedComment(ref, { author: colleague, body: reviewRequest(sha, { reply }) });
      await w.fake.react(ref.repo, theirs, "rocket");
      w.at(20_000, () => w.check("second", "queued"));
      w.at(50_000, () => w.complete("second", "success", result({ run: { started_at: iso(25_000) } })));
      expect(await w.lookover("wait")).toBe(0);
      expect(w.comments().map((c) => [c.author.id, c.body])).toEqual([
        [colleague.id, reviewRequest(sha, { reply })],
        [owner.id, reviewRequest(sha, { reply })],
      ]);
      expect(w.err[1]).toBe("Asked Lookover to answer your reply on F1 (5d9114c, pull request #7).");
    });

    test("a check naming nobody, from before checks named their person, is read while none names the agent", async () => {
      const w = world({ shared });
      await w.check("old", "in_progress", sha, null);
      await w.complete("old", "neutral", fix());
      expect(await w.lookover("feedback")).toBe(3);
      expect(w.comments()).toEqual([]);
    });

    test("once a check names the agent, one naming nobody is left out", async () => {
      const w = world({ shared });
      await w.check("mine", "in_progress");
      await w.complete("mine", "neutral", fix());
      await w.check("old", "in_progress", sha, null);
      await w.complete("old", "success", result({}));
      expect(await w.lookover("feedback")).toBe(3);
    });

    test("another person's thread is none of the agent's: reply refuses it, feedback shows none", async () => {
      const w = world({ shared });
      w.foreignFinding(colleague, "F1");
      await w.check("mine", "in_progress");
      await w.complete("mine", "neutral", fix());
      expect(await w.lookover("reply", "F1", "wont-fix", "Not here.")).toBe(1);
      expect(w.err).toEqual(["Lookover has no thread for F1 on pull request #7."]);
      w.out.length = 0;
      expect(await w.lookover("feedback", "--json")).toBe(3);
      expect(w.json()).toMatchObject({ findings: [{ id: "F1", thread: null, lookover_reply: null }] });
    });

    test("Lookover's reply is whoever posts with a reply marker; the agent's own words, without one, are the agent's", async () => {
      const w = world({ shared });
      const [root = 0] = await w.review("F1");
      w.appReply(root, "Kept: a caller doesn't check.");
      w.agentReply(root, "Disputed: every caller checks.");
      await w.check("mine", "in_progress");
      await w.complete("mine", "neutral", fix());
      expect(await w.lookover("feedback", "--json")).toBe(3);
      expect(w.json()).toMatchObject({
        findings: [{ id: "F1", lookover_reply: { body: "Kept: a caller doesn't check." } }],
      });
    });
  });

describe("the shared App, as the agent's person", () => {
  test("a reply of the agent's holding a reply marker it copied is Lookover's, and asks no round", async () => {
    const w = world({ shared: true });
    const [root = 0] = await w.review("F1");
    await w.check("first", "in_progress");
    await w.complete("first", "neutral", fix());
    w.agentReply(root, `Kept: quoted.\n${REPLY_MARKER}{"v":1} -->`);
    expect(await w.lookover("wait")).toBe(3);
    expect(w.comments()).toEqual([]);
  });

  test("the agent's reply without a marker asks a round on the same commit", async () => {
    const w = world({ shared: true });
    const [root = 0] = await w.review("F1");
    await w.check("first", "in_progress");
    await w.complete("first", "neutral", fix());
    const reply = w.agentReply(root, "Won't fix: the caller checks the range.");
    w.at(20_000, () => w.check("second", "queued"));
    w.at(50_000, () => w.complete("second", "success", result({ run: { started_at: iso(25_000) } })));
    expect(await w.lookover("wait")).toBe(0);
    expect(w.comments().map((c) => c.body)).toEqual([reviewRequest(sha, { reply })]);
  });
});

describe("a reply asked about", () => {
  test("the first check naming the agent, after one naming nobody, appeared since asked: it answers", async () => {
    const w = world();
    const [root = 0] = await w.review("F1");
    await w.check("old", "in_progress", sha, null);
    await w.complete("old", "neutral", fix());
    w.agentReply(root, "Won't fix: the caller checks the range.");
    w.at(20_000, () => w.check("mine", "queued"));
    // Its result says it started before the reply: only its appearing says it read it.
    w.at(50_000, () => w.complete("mine", "success", result({ run: { started_at: iso(-60_000) } })));
    expect(await w.lookover("wait", "--appear-timeout", "2m")).toBe(0);
    expect(w.elapsed()).toBe(50_000);
  });
});

describe("the own App, as its bot alone", () => {
  test("a reply of the agent's holding a reply marker it copied is the agent's, and asks a round", async () => {
    const w = world();
    const [root = 0] = await w.review("F1");
    await w.check("first", "in_progress");
    await w.complete("first", "neutral", fix());
    const reply = w.agentReply(root, `Won't fix: quoted.\n${REPLY_MARKER}{"v":1} -->`);
    w.at(20_000, () => w.check("second", "queued"));
    w.at(50_000, () => w.complete("second", "success", result({ run: { started_at: iso(25_000) } })));
    expect(await w.lookover("wait")).toBe(0);
    expect(w.comments().map((c) => c.body)).toEqual([reviewRequest(sha, { reply })]);
  });

  test("the agent's own root holding a finding marker is no thread of Lookover's: reply and feedback leave it", async () => {
    const w = world();
    w.foreignFinding(owner, "F1");
    await w.check("mine", "in_progress");
    await w.complete("mine", "neutral", fix());
    expect(await w.lookover("reply", "F1", "wont-fix", "Not here.")).toBe(1);
    expect(w.err).toEqual(["Lookover has no thread for F1 on pull request #7."]);
    w.out.length = 0;
    expect(await w.lookover("feedback", "--json")).toBe(3);
    expect(w.json()).toMatchObject({ findings: [{ id: "F1", thread: null }] });
  });
});

describe("the shared App, the agent's own root", () => {
  test("holding a finding marker, it is Lookover's thread as the agent's person: reply answers on it", async () => {
    const w = world({ shared: true });
    w.foreignFinding(owner, "F1");
    await w.check("mine", "in_progress");
    await w.complete("mine", "neutral", fix());
    expect(await w.lookover("reply", "F1", "wont-fix", "Not here.")).toBe(0);
  });
});
