// The Logs page's list (ADR 0055): the log file's tail, then each line as the service writes it, read again whenever
// the stream opens again, and how a line of the file is shown.
import { expect, test } from "bun:test";
import type { LogMessage } from "@lookover/contracts";
import { followLogs, logLinesShown } from "./logs.ts";

/** A service whose tail answers when the test says, and whose stream the test speaks on. */
function service() {
  const reads: { resolve: (tail: string[]) => void; reject: (error: Error) => void }[] = [];
  const listeners = new Set<(message: LogMessage) => void>();
  return {
    api: {
      logs: () =>
        new Promise<string[]>((resolve, reject) => {
          reads.push({ resolve, reject });
        }),
      subscribeLogs: (listener: (message: LogMessage) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    reads,
    say: (message: LogMessage) => {
      for (const l of listeners) l(message);
    },
    listened: () => listeners.size,
  };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const line = (text: string) => ({ type: "line", line: text }) as const;

test("the tail is read once listening, and lines heard meanwhile follow it, those it already holds once", async () => {
  const s = service();
  const shown: (string[] | null)[] = [];
  const stop = followLogs(s.api, (lines) => shown.push(lines));
  expect(s.listened()).toBe(1);
  expect(s.reads).toHaveLength(1);
  // Written while the tail was read: one made it into the file's tail, one came after.
  s.say(line("a"));
  s.say(line("b"));
  s.reads[0]?.resolve(["x", "a"]);
  await settle();
  expect(shown).toEqual([["x", "a", "b"]]);
  s.say(line("c"));
  expect(shown.at(-1)).toEqual(["x", "a", "b", "c"]);
  stop();
  expect(s.listened()).toBe(0);
});

test("a line heard that is the same as one already in the tail still shows: only those the tail ends with are dropped", async () => {
  const s = service();
  const shown: string[][] = [];
  followLogs(s.api, (lines) => shown.push(lines));
  // On a clock standing still, the same words make the same line: "ready" was written before and again after.
  s.say(line("ready"));
  s.say(line("seen"));
  s.say(line("ready"));
  s.reads[0]?.resolve(["ready", "start", "ready", "seen"]);
  await settle();
  expect(shown.at(-1)).toEqual(["ready", "start", "ready", "seen", "ready"]);
});

test("lines heard none of which the tail ends with all follow it, even those it holds earlier", async () => {
  const s = service();
  const shown: string[][] = [];
  followLogs(s.api, (lines) => shown.push(lines));
  s.say(line("x"));
  s.reads[0]?.resolve(["x", "y"]);
  await settle();
  expect(shown.at(-1)).toEqual(["x", "y", "x"]);
});

test("the stream opening again reads the tail again: what was written while it was closed shows", async () => {
  const s = service();
  const shown: string[][] = [];
  followLogs(s.api, (lines) => shown.push(lines));
  s.reads[0]?.resolve(["x"]);
  await settle();
  s.say({ type: "connected" });
  expect(s.reads).toHaveLength(2);
  s.say(line("y"));
  // Until the new tail is in, a line heard still shows.
  expect(shown.at(-1)).toEqual(["x", "y"]);
  s.reads[1]?.resolve(["x", "lost while closed", "y"]);
  await settle();
  expect(shown.at(-1)).toEqual(["x", "lost while closed", "y"]);
});

test("only the latest read counts: an older tail answering late is dropped", async () => {
  const s = service();
  const shown: string[][] = [];
  followLogs(s.api, (lines) => shown.push(lines));
  s.say({ type: "connected" });
  s.reads[1]?.resolve(["new"]);
  await settle();
  s.reads[0]?.resolve(["old"]);
  await settle();
  expect(shown).toEqual([["new"]]);
});

test("the list keeps the last 200 lines", async () => {
  const s = service();
  const shown: string[][] = [];
  followLogs(s.api, (lines) => shown.push(lines));
  s.reads[0]?.resolve(Array.from({ length: 200 }, (_, i) => `line ${i + 1}`));
  await settle();
  s.say(line("line 201"));
  expect(shown.at(-1)).toHaveLength(200);
  expect(shown.at(-1)?.[0]).toBe("line 2");
  expect(shown.at(-1)?.at(-1)).toBe("line 201");
});

test("while the reader is scrolled away from the newest line, no line is dropped from the top; once back, the list is 200 again", async () => {
  const s = service();
  const shown: string[][] = [];
  let reading = false;
  followLogs(
    s.api,
    (lines) => shown.push(lines),
    () => reading,
  );
  s.reads[0]?.resolve(Array.from({ length: 200 }, (_, i) => `line ${i + 1}`));
  await settle();
  reading = true;
  s.say(line("line 201"));
  s.say(line("line 202"));
  expect(shown.at(-1)).toHaveLength(202);
  expect(shown.at(-1)?.[0]).toBe("line 1");
  reading = false;
  s.say(line("line 203"));
  expect(shown.at(-1)).toHaveLength(200);
  expect(shown.at(-1)?.[0]).toBe("line 4");
});

test("while the reader is scrolled away, the stream opening again adds what the new tail holds after the lines kept: none goes", async () => {
  const s = service();
  const shown: string[][] = [];
  let reading = false;
  followLogs(
    s.api,
    (lines) => shown.push(lines),
    () => reading,
  );
  const numbered = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}`);
  s.reads[0]?.resolve(numbered(1, 200));
  await settle();
  reading = true;
  s.say(line("line 201"));
  expect(shown.at(-1)).toEqual(numbered(1, 201));
  // The tab was hidden: the stream closed, lines 202 to 204 were written, it opened again.
  s.say({ type: "connected" });
  s.say(line("line 205"));
  s.reads[1]?.resolve(numbered(6, 205));
  await settle();
  expect(shown.at(-1)).toEqual(numbered(1, 205));
  reading = false;
  s.say(line("line 206"));
  expect(shown.at(-1)).toEqual(numbered(7, 206));
});

test("a tail that can't be read shows the lines heard, and nothing after the page left", async () => {
  const s = service();
  const shown: string[][] = [];
  const stop = followLogs(s.api, (lines) => shown.push(lines));
  s.say(line("a"));
  s.reads[0]?.reject(new Error("The service answered 500"));
  await settle();
  expect(shown).toEqual([["a"]]);
  s.say({ type: "connected" });
  stop();
  s.reads[1]?.resolve(["late"]);
  await settle();
  expect(shown).toEqual([["a"]]);
});

test("a line shows its time and its words; the day too when it isn't the newest line's day", () => {
  expect(
    logLinesShown([
      "2026-10-10T23:59:58.120+02:00 Lookover is stopping (Ctrl+C)",
      "2026-10-11T00:00:03.000+02:00 Lookover service (program) · http://127.0.0.1:4000",
      "2026-10-11T09:30:00.000+02:00 sasensi/lookover-sandbox#1 review queued (asked in the app) for a1b2c3d",
      "not a line of the file's",
    ]),
  ).toEqual([
    "10-10 23:59:58  Lookover is stopping (Ctrl+C)",
    "00:00:03  Lookover service (program) · http://127.0.0.1:4000",
    "09:30:00  sasensi/lookover-sandbox#1 review queued (asked in the app) for a1b2c3d",
    "not a line of the file's",
  ]);
});
