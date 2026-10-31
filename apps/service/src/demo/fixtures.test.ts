// Every scenario's fixtures hold together (ADR 0046): each scripted finding's path and line text sit in its
// commit's diff, as `review` anchors them, so a hand-written mismatch never degrades a round silently (a finding
// whose text isn't in the diff goes to the summary); each confirm verdict names a candidate the find pass gave;
// each change's commits are its own, and every id is one of a kind.
import { expect, test } from "bun:test";
import type { RepositoryRef } from "@lookover/contracts";
import { findLine, indexDiff } from "@lookover/diff";
import { SCENARIOS, type Scenario } from "../index.ts";

type ScenarioChange = Scenario["changes"][number];
type ScenarioCommit = ScenarioChange["commits"][number];

/** Every commit of every change of every scenario, with where it is. */
const commits = (): { scenario: Scenario; change: ScenarioChange; commit: ScenarioCommit }[] =>
  SCENARIOS.flatMap((scenario) =>
    scenario.changes.flatMap((change) => change.commits.map((commit) => ({ scenario, change, commit }))),
  );

test("every scripted finding's path and line text are in its commit's diff, on its side, at its line", () => {
  const unanchored: string[] = [];
  for (const { scenario, change, commit } of commits()) {
    const index = indexDiff(commit.diff);
    for (const finding of commit.find?.findings ?? []) {
      const where = { path: finding.path, side: finding.side ?? "head", line: finding.line };
      const found = findLine(index, where, finding.lineText);
      if (found.kind !== "found" || found.line !== finding.line)
        unanchored.push(
          `${scenario.id} #${change.number} ${commit.sha.slice(0, 7)} ${finding.path}:${finding.line}`,
        );
    }
  }
  expect(unanchored).toEqual([]);
});

test("every confirm verdict names a candidate of its commit's find pass, C1 to Cn in the finder's order", () => {
  for (const { commit } of commits()) {
    if (!commit.confirm) continue;
    const candidates = (commit.find?.findings ?? []).map((_, i) => `C${i + 1}`);
    expect(commit.confirm.verdicts.map((v) => v.id)).toEqual(candidates);
  }
});

test("every scenario's ids are one of a kind: the scenarios', the changes' (repository and number), the commits' shas", () => {
  const ids = SCENARIOS.map((s) => s.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const scenario of SCENARIOS) {
    const changes = scenario.changes.map((c) => nameOf(c.repo ?? scenario.world.repo, c.number));
    expect(new Set(changes).size).toBe(changes.length);
    const shas = scenario.changes.flatMap((c) => c.commits.map((k) => k.sha));
    expect(new Set(shas).size).toBe(shas.length);
    // The script's moves name the scenario's own changes, by repository and number.
    for (const { move } of scenario.script)
      if ("change" in move) expect(changes).toContain(nameOf(move.change.repo, move.change.number));
  }
});

/** A change as written: `<owner>/<name>#<number>`. */
const nameOf = (repo: RepositoryRef, number: number) => `${repo.owner}/${repo.name}#${number}`;
