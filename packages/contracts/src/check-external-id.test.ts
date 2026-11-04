// The check's `external_id` (ADR 0066, 0077): the job's id, the pull request's number and the person's, built and read back.
import { describe, expect, test } from "bun:test";
import { checkExternalId, checkIsFor, readCheckExternalId } from "./index.ts";

describe("the check's external id", () => {
  test("names the job, the pull request and the person Lookover posts for, the person last", () => {
    expect(checkExternalId("2f0c4b7e-job", 6000, 11247504)).toBe("2f0c4b7e-job#6000@11247504");
  });

  test("is never written for a person that is no GitHub id, which its reader would refuse", () => {
    for (const person of [0, -4, 4.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])
      expect(() => checkExternalId("job-1", 1, person)).toThrow(`${person} is no person's id`);
    expect(() => checkExternalId("", 1, 11247504)).toThrow("no job");
  });

  test("is never written for a number that is no pull request's", () => {
    for (const number of [0, -4, 4.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])
      expect(() => checkExternalId("job-1", number, 11247504)).toThrow(
        `${number} is no pull request's number`,
      );
  });

  test("read back: the job, the pull request and the person", () => {
    expect(readCheckExternalId(checkExternalId("2f0c4b7e-job", 6000, 11247504))).toEqual({
      job: "2f0c4b7e-job",
      number: 6000,
      person: 11247504,
    });
  });

  test("one from before ADR 0077 names no pull request, and still its person", () => {
    expect(readCheckExternalId("job-1@11247504")).toEqual({ job: "job-1", number: null, person: 11247504 });
  });

  test("anything else is unreadable: an older check's job id alone, an empty one, a person or a number that is no id", () => {
    for (const other of [
      "job-1",
      "",
      "@11247504",
      "job-1@",
      "job-1@sasensi",
      "job-1@0",
      "job-1@-4",
      "job-1@4.5",
      "job-1@ 4",
      "job-1@012",
      "spike-20:11247504",
      "job-1#@11247504",
      "job-1#0@11247504",
      "job-1#x@11247504",
      "job-1#012@11247504",
      "job-1#-4@11247504",
      "#6000@11247504",
    ])
      expect(readCheckExternalId(other)).toBeNull();
  });
});

describe("whose check, for which pull request", () => {
  const id = checkExternalId("job-1", 6000, 11247504);

  test("is for the person and the pull request it names", () => {
    expect(checkIsFor(id, 11247504, 6000)).toBe(true);
  });

  test("is not for another pull request, another person, or when it names no pull request", () => {
    expect(checkIsFor(id, 11247504, 5562)).toBe(false);
    expect(checkIsFor(id, 4242, 6000)).toBe(false);
    expect(checkIsFor("job-1@11247504", 11247504, 6000)).toBe(false);
    expect(checkIsFor("job-1", 11247504, 6000)).toBe(false);
  });
});
