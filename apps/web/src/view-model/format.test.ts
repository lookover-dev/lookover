import { expect, test } from "bun:test";
import { duration, itOrThem, LONGEST_RUNNING_TIMES, startsAt, until } from "./format.ts";

const PARIS = "Europe/Paris";
const NEW_YORK = "America/New_York";

test("until when: the time today, tomorrow's with the word, a later one with its day (ADR 0055)", () => {
  const now = Date.parse("2026-10-11T08:00:00+02:00");
  const cases: [string, string, string][] = [
    ["2026-10-11T10:11:00+02:00", "until 10:11", "at 10:11"],
    ["2026-10-12T10:11:00+02:00", "until tomorrow 10:11", "tomorrow at 10:11"],
    ["2026-10-14T10:11:00+02:00", "until Wed 14 Oct, 10:11", "on Wed 14 Oct at 10:11"],
  ];
  for (const [at, untilText, startsText] of cases) {
    expect([until(now, Date.parse(at), PARIS), startsAt(now, Date.parse(at), PARIS)]).toEqual([
      untilText,
      startsText,
    ]);
  }
});

test("days are calendar days, not 24 hours: across midnight a time an hour away is tomorrow's", () => {
  const now = Date.parse("2026-10-11T23:30:00+02:00");
  expect(until(now, Date.parse("2026-10-12T00:30:00+02:00"), PARIS)).toBe("until tomorrow 00:30");
  // Nearly a day away, the same evening's calendar day after: still tomorrow, not the day after.
  expect(until(now, Date.parse("2026-10-12T23:00:00+02:00"), PARIS)).toBe("until tomorrow 23:00");
  // Just after midnight, a time 23 hours away is today.
  const early = Date.parse("2026-10-12T00:10:00+02:00");
  expect(until(early, Date.parse("2026-10-12T23:10:00+02:00"), PARIS)).toBe("until 23:10");
});

test("the day is the time zone's: the same instants read another way six hours west", () => {
  const now = Date.parse("2026-10-11T23:30:00+02:00");
  const at = Date.parse("2026-10-12T05:00:00+02:00");
  expect(until(now, at, PARIS)).toBe("until tomorrow 05:00");
  // 17:30 and 23:00 the same day in New York.
  expect(until(now, at, NEW_YORK)).toBe("until 23:00");
});

test("a clock change between today and the day is no day more or less", () => {
  // Paris leaves summer time on 25 Oct 2026: the day after is still the next calendar day.
  const now = Date.parse("2026-10-24T22:00:00+02:00");
  expect(until(now, Date.parse("2026-10-25T22:00:00+01:00"), PARIS)).toBe("until tomorrow 22:00");
  expect(until(now, Date.parse("2026-10-26T09:05:00+01:00"), PARIS)).toBe("until Mon 26 Oct, 09:05");
});

test("one thing is it, any other count them", () => {
  expect([itOrThem(1), itOrThem(2), itOrThem(0)]).toEqual(["it", "them", "them"]);
});

test("a duration reads in words, floored, its minutes carried into the hour (ADR 0070)", () => {
  const cases: [number, string][] = [
    [0, "0 s"],
    [999, "0 s"],
    [59_999, "59 s"],
    [60_000, "1 min"],
    [760_000, "12 min 40 s"],
    [3_599_999, "59 min 59 s"],
    [3_600_000, "1 h"],
    [7_170_000, "1 h 59 min"],
    [7_199_999, "1 h 59 min"],
    [7_200_000, "2 h"],
    [-5_000, "0 s"],
  ];
  expect(cases.map(([ms]) => [ms, duration(ms)])).toEqual(cases);
});

test("a running time's sizers are durations it writes, none shorter in characters than any under a hundred hours", () => {
  expect<readonly string[]>(LONGEST_RUNNING_TIMES).toEqual([
    duration(3_599_000),
    duration(99 * 3_600_000 + 59 * 60_000),
  ]);
  let longest = 0;
  for (let s = 0; s < 100 * 3600; s += 1) longest = Math.max(longest, duration(s * 1000).length);
  for (const sizer of LONGEST_RUNNING_TIMES) expect(sizer.length).toBe(longest);
});
