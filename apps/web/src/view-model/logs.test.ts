// The Logs page's list (ADR 0055): the log file's tail, then each line as the service writes it, read again whenever
// the stream opens again, and how a line of the file is shown.
import { expect, test } from "bun:test";
import type { LogMessage } from "@lookover/contracts";
import { followLogs, logRunsShown } from "./logs.ts";

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

test("a line shows its time apart from its words, so they wrap under themselves; the day too when it isn't the newest line's day", () => {
  expect(
    logRunsShown([
      "2026-10-10T23:59:58.120+02:00 Lookover is stopping (Ctrl+C)",
      "2026-10-11T00:00:03.000+02:00 Lookover service (program) · http://127.0.0.1:4000",
      "2026-10-11T09:30:00.000+02:00 sasensi/lookover-sandbox#1 review queued (asked in the app) for a1b2c3d",
      "not a line of the file's",
    ]),
  ).toEqual([
    {
      pr: null,
      day: true,
      lines: [
        { day: "10-10", time: "23:59:58", words: "Lookover is stopping (Ctrl+C)" },
        { day: null, time: "00:00:03", words: "Lookover service (program) · http://127.0.0.1:4000" },
      ],
    },
    {
      pr: "sasensi/lookover-sandbox#1",
      day: false,
      // A line not of the file's shape stays in the run before it: a stack's lines under its error.
      lines: [
        { day: null, time: "09:30:00", words: "review queued (asked in the app) for a1b2c3d" },
        { day: null, time: null, words: "not a line of the file's" },
      ],
    },
  ]);
});

test("a pull request is named once: its consecutive lines sit under a head naming it, a line about none stands alone", () => {
  const runs = logRunsShown([
    "2026-11-08T08:52:00.000+01:00 self-test of claude 2.4.1: passed, 0 ms",
    "2026-11-08T08:52:00.000+01:00 self-test of codex 0.162.1: passed, 0 ms",
    "2026-11-08T08:52:00.000+01:00 sasensi/lookover-sandbox#135 opened by sasensi: Format amounts",
    "2026-11-08T08:52:00.000+01:00 sasensi/lookover-sandbox#135 review queued (on opening) for 135a1b2",
    "2026-11-08T08:52:00.000+01:00 sasensi/lookover-sandbox#137 opened by mira: Link the testing guide",
    "2026-11-08T08:52:00.000+01:00 sasensi/lookover-sandbox#135 round 1 posted: no open findings",
    "2026-11-08T08:52:00.000+01:00 Codex is signed out",
  ]);
  expect(runs.map(({ pr, lines }) => ({ pr, words: lines.map((l) => l.words) }))).toEqual([
    {
      pr: null,
      words: ["self-test of claude 2.4.1: passed, 0 ms", "self-test of codex 0.162.1: passed, 0 ms"],
    },
    {
      pr: "sasensi/lookover-sandbox#135",
      words: ["opened by sasensi: Format amounts", "review queued (on opening) for 135a1b2"],
    },
    { pr: "sasensi/lookover-sandbox#137", words: ["opened by mira: Link the testing guide"] },
    // Another pull request's line came between: named again, under a head of its own.
    { pr: "sasensi/lookover-sandbox#135", words: ["round 1 posted: no open findings"] },
    { pr: null, words: ["Codex is signed out"] },
  ]);
});

test("a run's time column says the day for all its lines when one does, so a run across midnight keeps its words on one x", () => {
  const runs = logRunsShown([
    "2026-11-07T23:59:58.000+01:00 sasensi/lookover-sandbox#135 round 1 started",
    "2026-11-08T00:00:03.000+01:00 sasensi/lookover-sandbox#135 round 1 posted: no open findings",
    "2026-11-08T00:00:04.000+01:00 Codex is signed out",
  ]);
  expect(runs.map(({ pr, day, lines }) => ({ pr, day, days: lines.map((l) => l.day) }))).toEqual([
    // Its first line says yesterday, its second doesn't: the head and both lines take the day's wider column.
    { pr: "sasensi/lookover-sandbox#135", day: true, days: ["11-07", null] },
    { pr: null, day: false, days: [null] },
  ]);
});

test("lines before any of the file's shape stand alone, under no head", () => {
  expect(logRunsShown(["Error: boom", "    at main.ts:1"])).toEqual([
    {
      pr: null,
      day: false,
      lines: [
        { day: null, time: null, words: "Error: boom" },
        { day: null, time: null, words: "    at main.ts:1" },
      ],
    },
  ]);
  expect(logRunsShown([])).toEqual([]);
});
