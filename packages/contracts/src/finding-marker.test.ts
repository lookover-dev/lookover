// The finding marker an inline comment ends with, read back (ADR 0052): how a thread is told to be a finding's.
import { describe, expect, test } from "bun:test";
import { FINDING_MARKER, findingId, findingOfMarker } from "./index.ts";

/** An inline comment as `publish` writes one: the text, then its marker on the last line. */
const comment = (json: string) =>
  `**Off by one** · Should fix\n\nThe loop stops early.\n\n${FINDING_MARKER}${json} -->`;

describe("the finding marker", () => {
  test("names the finding of an inline comment that ends with it", () => {
    const json = `{"v":1,"id":"F3","fingerprints":{"location":"loc:a","meaning":"sem:b"},"severity":"blocking","sha":"5d9114c"}`;
    expect(findingOfMarker(comment(json))).toBe(findingId("F3"));
  });

  test("a comment without it, or whose marker isn't one Lookover writes, names no finding", () => {
    expect(findingOfMarker("Won't fix: the caller checks it.")).toBeNull();
    expect(findingOfMarker(comment("not json"))).toBeNull();
    expect(findingOfMarker(comment(`{"v":1}`))).toBeNull();
    expect(findingOfMarker(comment(`{"v":1,"id":""}`))).toBeNull();
    expect(findingOfMarker(comment(`{"v":1,"id":3}`))).toBeNull();
    expect(findingOfMarker(comment("[]"))).toBeNull();
    expect(findingOfMarker(`${FINDING_MARKER}{"v":1,"id":"F1"}`)).toBeNull();
  });

  test("a marker quoted in a reply is read too: who wrote the comment is the reader's to check", () => {
    expect(findingOfMarker(`> quoting\n${comment(`{"v":1,"id":"F2"}`)}\n\nThanks.`)).toBe(findingId("F2"));
  });
});
