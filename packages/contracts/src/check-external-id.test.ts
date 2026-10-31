// The check's `external_id` (ADR 0066): the job's id and the person's, built on both ways and read back.
import { describe, expect, test } from "bun:test";
import { checkExternalId, readCheckExternalId } from "./index.ts";

describe("the check's external id", () => {
  test("names the job and the person Lookover posts for", () => {
    expect(checkExternalId("2f0c4b7e-job", 11247504)).toBe("2f0c4b7e-job@11247504");
  });

  test("is never written for a person that is no GitHub id, which its reader would refuse", () => {
    for (const person of [0, -4, 4.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])
      expect(() => checkExternalId("job-1", person)).toThrow(`${person} is no person's id`);
    expect(() => checkExternalId("", 11247504)).toThrow("no job");
  });

  test("read back: the job and the person", () => {
    expect(readCheckExternalId(checkExternalId("2f0c4b7e-job", 11247504))).toEqual({
      job: "2f0c4b7e-job",
      person: 11247504,
    });
  });

  test("anything else names no person: an older check's job id alone, an empty one, a person that is no id", () => {
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
    ])
      expect(readCheckExternalId(other)).toBeNull();
  });
});
