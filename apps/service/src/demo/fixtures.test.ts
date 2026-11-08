// Every scenario's fixtures hold together (ADR 0046): each scripted finding's path and line text sit in its
// commit's diff, as `review` anchors them, so a hand-written mismatch never degrades a round silently (a finding
// whose text isn't in the diff goes to the summary), but the few meant to be outside it; each confirm verdict names a candidate the find pass gave;
// each change's commits are its own, and every id is one of a kind.
import { expect, test } from "bun:test";
import type { DiffIndex, RepositoryRef } from "@lookover/contracts";
import { findLine, indexDiff } from "@lookover/diff";
import { SCENARIOS, type Scenario } from "../index.ts";

type ScenarioChange = Scenario["changes"][number];
type ScenarioCommit = ScenarioChange["commits"][number];

/** Every commit of every change of every scenario, with where it is. */
const commits = (): { scenario: Scenario; change: ScenarioChange; commit: ScenarioCommit }[] =>
  SCENARIOS.flatMap((scenario) =>
    scenario.changes.flatMap((change) => change.commits.map((commit) => ({ scenario, change, commit }))),
  );

/**
 * The scripted findings meant to sit on a file their commit's diff doesn't touch, named as the test names them:
 * S6's F3, which the status block lists with its lines (ADR 0074).
 */
const OUTSIDE_THE_DIFF = ["S6 #153 d0e1f2a src/invoices/reminders.ts:9"];

type ScriptedFinding = NonNullable<ScenarioCommit["find"]>["findings"][number];

/** A scripted finding's line text is in the diff on its side, at its line, as `review` anchors it. */
function anchored(index: DiffIndex, finding: ScriptedFinding): boolean {
  const where = { path: finding.path, side: finding.side ?? "head", line: finding.line };
  const found = findLine(index, where, finding.lineText);
  return found.kind === "found" && found.line === finding.line;
}

test("every scripted finding's path and line text are in its commit's diff, on its side, at its line, but the ones meant to be outside", () => {
  const unanchored: string[] = [];
  const outside: string[] = [];
  for (const { scenario, change, commit } of commits()) {
    const index = indexDiff(commit.diff);
    for (const finding of commit.find?.findings ?? []) {
      const name = `${scenario.id} #${change.number} ${commit.sha.slice(0, 7)} ${finding.path}:${finding.line}`;
      if (!OUTSIDE_THE_DIFF.includes(name)) {
        if (!anchored(index, finding)) unanchored.push(name);
      } else if (!index.files.some((f) => f.path === finding.path)) outside.push(name);
    }
  }
  expect(unanchored).toEqual([]);
  // Each one named is outside indeed: its file isn't in the diff at all.
  expect(outside).toEqual(OUTSIDE_THE_DIFF);
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
    for (const { move } of scenario.script) {
      const named = "change" in move ? [move.change] : "changes" in move ? move.changes : [];
      for (const ref of named) expect(changes).toContain(nameOf(ref.repo, ref.number));
    }
  }
});

/** A change as written: `<owner>/<name>#<number>`. */
const nameOf = (repo: RepositoryRef, number: number) => `${repo.owner}/${repo.name}#${number}`;
