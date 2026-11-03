// The status block written into a pull request's description (ADR 0074): read fresh right before the write, read
// again while GitHub's read lags Lookover's last write (ADR 0069), refused as a standing refusal, never a sign-out.
import { expect, test } from "bun:test";
import { SHARED_APP, STATUS_END_MARKER, STATUS_MARKER } from "@lookover/contracts";
import { z } from "zod";
import { AT, type Call, stubGitHub, withToken } from "./github.test-support.ts";
import { createGitHub, type Session } from "./index.ts";

const REPO = { owner: "sasensi", name: "lookover-sandbox" };
const CHANGE = { repo: REPO, number: 7 };
const PATH = "/repos/sasensi/lookover-sandbox/pulls/7";
const TOKEN = "ghu_person";
const SESSION: Session = {
  appId: SHARED_APP.id,
  withToken: (_repo, call) => call(TOKEN),
  poster: () => Promise.resolve({ id: 338297044, login: "lookover-person" }),
};
const HEAD = { ref: "live/2026-10-06", sha: "126ba1dae30bd5bb918afe71a1ecd88ff9744fb1" };

const marked = (block: string) => `${STATUS_MARKER}\n${block}\n${STATUS_END_MARKER}`;
const sentBody = z.object({ body: z.string() });

/**
 * GitHub's pull request 7: each read answers the next of `reads` once they are given (a lagging read), then what the
 * last write left; a write answers `refusal` when one is given.
 */
function pullRequest(
  description: string | null,
  options: { reads?: (string | null)[]; refusal?: number } = {},
) {
  const held = { description, reads: [...(options.reads ?? [])] };
  const route = withToken(TOKEN, (call: Call) => {
    if (call.path !== PATH) return undefined;
    if (call.method === "GET") {
      const body = held.reads.length > 0 ? held.reads.shift() : held.description;
      return { status: 200, body: { body, head: HEAD } };
    }
    if (call.method !== "PATCH") return undefined;
    if (options.refusal !== undefined)
      return { status: options.refusal, body: { message: "Resource not accessible by integration" } };
    held.description = sentBody.parse(call.body).body;
    return { status: 200, body: { body: held.description, head: HEAD } };
  });
  return { held, route };
}

/** The adapter on the stub, its clock moved by each pause it takes. */
function adapter(route: Parameters<typeof stubGitHub>[0]) {
  const api = stubGitHub(route);
  let now = AT;
  const pauses: number[] = [];
  const github = createGitHub({
    session: SESSION,
    repositories: [REPO],
    fetch: api.fetch,
    clock: { now: () => now },
    sleep: (ms) => {
      pauses.push(ms);
      now += ms;
      return Promise.resolve();
    },
  });
  const sent = () => api.calls.filter((c) => c.path === PATH).map((c) => c.method);
  return { github, api, pauses, sent };
}

test("the description is read fresh, never with an ETag, and written with the block under the author's text", async () => {
  const pr = pullRequest("Fixes the total.");
  const { github, api, sent } = adapter(pr.route);
  const rooms: number[] = [];
  await github.writer.upsertStatus(CHANGE, (room) => {
    rooms.push(room);
    return "Round 1";
  });
  await github.writer.upsertStatus(CHANGE, () => "One thing to fix");
  expect(pr.held.description).toBe(`Fixes the total.\n\n---\n\n${marked("One thing to fix")}`);
  // 65,536 less "Fixes the total." (16), the rule (7) and the markers with their line breaks (51).
  expect(rooms).toEqual([65_462]);
  expect(sent()).toEqual(["GET", "PATCH", "GET", "PATCH"]);
  expect(api.calls.every((c) => c.ifNoneMatch === null)).toBe(true);
});

test("GitHub's null is an empty description: the block alone", async () => {
  const pr = pullRequest(null);
  const { github } = adapter(pr.route);
  await github.writer.upsertStatus(CHANGE, () => "Round 1");
  expect(pr.held.description).toBe(marked("Round 1"));
});

test("a description already holding the block is not written again; none to write is nothing written", async () => {
  const pr = pullRequest(`Intro\n\n---\n\n${marked("Round 1")}`);
  const { github, sent } = adapter(pr.route);
  await github.writer.upsertStatus(CHANGE, () => "Round 1");
  await github.writer.upsertStatus(CHANGE, () => null);
  expect(sent()).toEqual(["GET", "GET"]);
});

test("a read not showing the last block sent is read again, a second apart, and the write keeps the author's edit", async () => {
  const pr = pullRequest("First words.");
  const { github, pauses, sent } = adapter(pr.route);
  await github.writer.upsertStatus(CHANGE, () => "Round 1");
  // The author edits under the block; GitHub's next two reads still give what was there before Lookover's write.
  const edited = `Second words.\n\n---\n\n${marked("Round 1")}`;
  pr.held.description = edited;
  pr.held.reads.push("First words.", "First words.");
  await github.writer.upsertStatus(CHANGE, () => "Round 2");
  expect(pr.held.description).toBe(`Second words.\n\n---\n\n${marked("Round 2")}`);
  expect(pauses).toEqual([1_000, 1_000]);
  expect(sent()).toEqual(["GET", "PATCH", "GET", "GET", "GET", "PATCH"]);
});

test("a read showing the last block sent with CRLF, as a browser's edit saves it, is not read again", async () => {
  const pr = pullRequest("First words.");
  const { github, pauses, sent } = adapter(pr.route);
  await github.writer.upsertStatus(CHANGE, () => "Round 1\n\n- one");
  // The author edited the description in the browser: every line ending is CRLF now, the block's too.
  pr.held.description = `Second words.\r\n\r\n---\r\n\r\n${STATUS_MARKER}\r\nRound 1\r\n\r\n- one\r\n${STATUS_END_MARKER}`;
  await github.writer.upsertStatus(CHANGE, () => "Round 2");
  expect(pauses).toEqual([]);
  expect(pr.held.description).toBe(`Second words.\r\n\r\n---\r\n\r\n${marked("Round 2")}`);
  expect(sent()).toEqual(["GET", "PATCH", "GET", "PATCH"]);
});

test("a read that never shows the last block sent is written on after 30 s, the last read's text kept", async () => {
  const pr = pullRequest("First words.");
  const { github, pauses } = adapter(pr.route);
  await github.writer.upsertStatus(CHANGE, () => "Round 1");
  // Someone rewrote the whole description and dropped the block: no read will show it.
  pr.held.description = "Rewritten.";
  await github.writer.upsertStatus(CHANGE, () => "Round 2");
  expect(pauses.reduce((a, b) => a + b, 0)).toBe(30_000);
  expect(pr.held.description).toBe(`Rewritten.\n\n---\n\n${marked("Round 2")}`);
});

test("a block past the room left is too large, and nothing is sent", async () => {
  const pr = pullRequest("Intro");
  const { github, sent } = adapter(pr.route);
  await expect(github.writer.upsertStatus(CHANGE, (room) => "y".repeat(room + 1))).rejects.toMatchObject({
    failure: "too_large",
  });
  expect(sent()).toEqual(["GET"]);
});

test("GitHub's 403 on the write is the person's permission, invalid, never a sign-out", async () => {
  const pr = pullRequest("Intro", { refusal: 403 });
  const { github } = adapter(pr.route);
  const refused = github.writer.upsertStatus(CHANGE, () => "Round 1");
  await expect(refused).rejects.toMatchObject({ failure: "invalid", connectionCause: undefined });
});

test("GitHub's 'body is too long' is too large", async () => {
  const api = stubGitHub(
    withToken(TOKEN, (call) => {
      if (call.path !== PATH) return undefined;
      if (call.method === "GET") return { status: 200, body: { body: "Intro", head: HEAD } };
      return {
        status: 422,
        body: {
          message: "Validation Failed",
          errors: [{ message: "body is too long (maximum is 65536 characters)" }],
        },
      };
    }),
  );
  const github = createGitHub({ session: SESSION, repositories: [REPO], fetch: api.fetch });
  await expect(github.writer.upsertStatus(CHANGE, () => "Round 1")).rejects.toMatchObject({
    failure: "too_large",
  });
});

test("a change off the list is refused before any request", async () => {
  const api = stubGitHub();
  const github = createGitHub({ session: SESSION, repositories: [REPO], fetch: api.fetch });
  const elsewhere = { repo: { owner: "sasensi", name: "elsewhere" }, number: 1 };
  await expect(github.writer.upsertStatus(elsewhere, () => "Round 1")).rejects.toMatchObject({
    failure: "not_found",
  });
  expect(api.calls).toEqual([]);
});
