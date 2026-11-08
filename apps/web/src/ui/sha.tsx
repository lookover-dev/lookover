import { shortSha } from "@lookover/contracts";
import { Fragment } from "react";
import { punctuationNext, type Words } from "../view-model/format.ts";

/**
 * A commit, drawn one way on every review screen (design-system.md "Inline code"): its first seven characters, as
 * inline code, in a sentence, a detail's value or a table's cell alike. `tight` when punctuation follows it: the chip
 * keeps no room on its right, so the full stop sits against it ("a7b8c9d.", never "a7b8c9d .").
 */
export function Sha({ sha, tight = false }: { sha: string; tight?: boolean }) {
  return <code className={tight ? "sha tight" : "sha"}>{shortSha(sha)}</code>;
}

/** Words with commits in them, each commit a `Sha`, tight when the words after it start with punctuation. */
export function ShaWords({ words }: { words: Words }) {
  return words.map((w, i) => {
    if (typeof w === "string") return <Fragment key={i}>{w}</Fragment>;
    const next = words[i + 1];
    return (
      <Sha key={i} sha={w.commit} tight={punctuationNext(typeof next === "string" ? next : undefined)} />
    );
  });
}
