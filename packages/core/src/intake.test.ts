// Whether a change that asks for a review gets a review job, or is skipped and why (ADR 0016, ADR 0026).
import { expect, test } from "bun:test";
import type { Change, SettingValues, SkipReason, Trigger } from "@lookover/contracts";
import { type Intake, intake, skipOutcome } from "./index.ts";

/** Lookover's defaults (ADR 0025, ADR 0026), as `settings` resolves them with nothing set. */
const DEFAULTS: SettingValues = {
  strictness: "recommended",
  reviewers: "both",
  depth: "standard",
  onOpen: true,
  onPush: false,
};

function ask(
  trigger: Trigger,
  change: Partial<Pick<Change, "author" | "draft" | "fork">> = {},
  repository: { enabled?: boolean; settings?: Partial<SettingValues> } = {},
): Intake {
  return intake(
    { author: change.author ?? "you", draft: change.draft ?? false, fork: change.fork ?? false },
    { enabled: repository.enabled ?? true, settings: { ...DEFAULTS, ...repository.settings } },
    trigger,
  );
}

test("a change the owner or the owner's agent wrote gets a review job, whatever asked for it", () => {
  const cases: [Trigger, Change["author"]][] = [
    ["opened", "you"],
    ["opened", "agent"],
    ["comment", "agent"],
    ["manual", "you"],
    ["first-review", "you"],
  ];
  for (const [trigger, author] of cases) {
    expect([trigger, author, ask(trigger, { author })]).toEqual([trigger, author, { kind: "job" }]);
  }
});

test("each skip reason, with the first that applies winning", () => {
  const cases: [string, Intake][] = [
    [
      "repository switched off",
      ask("opened", { author: "other", draft: true }, { enabled: false, settings: { onOpen: false } }),
    ],
    [
      "a change from a fork",
      ask("opened", { author: "other", draft: true, fork: true }, { settings: { onOpen: false } }),
    ],
    [
      "someone else's change",
      ask("opened", { author: "other", draft: true }, { settings: { onOpen: false } }),
    ],
    ["a draft that opens", ask("opened", { draft: true }, { settings: { onOpen: false } })],
    ["a push to a draft", ask("push", { draft: true }, { settings: { onPush: true } })],
    ["reviews on open switched off", ask("opened", {}, { settings: { onOpen: false } })],
  ];
  expect(cases).toEqual([
    ["repository switched off", { kind: "skipped", reason: "repo-off" }],
    ["a change from a fork", { kind: "skipped", reason: "fork" }],
    ["someone else's change", { kind: "skipped", reason: "not-yours" }],
    ["a draft that opens", { kind: "skipped", reason: "draft" }],
    ["a push to a draft", { kind: "skipped", reason: "draft" }],
    ["reviews on open switched off", { kind: "skipped", reason: "on-open-off" }],
  ]);
});

test("the owner's request on another author's change is reviewed: a comment or the app (ADR 0016, ADR 0043)", () => {
  for (const trigger of ["comment", "manual"] satisfies Trigger[]) {
    expect([trigger, ask(trigger, { author: "other", draft: true })]).toEqual([trigger, { kind: "job" }]);
  }
  // Nobody asked in person: another author's change is still skipped, with the reason on its check.
  for (const trigger of ["opened", "first-review"] satisfies Trigger[]) {
    expect([trigger, ask(trigger, { author: "other" })]).toEqual([
      trigger,
      { kind: "skipped", reason: "not-yours" },
    ]);
  }
  // A repository switched off is off for a request too.
  expect(ask("comment", { author: "other" }, { enabled: false })).toEqual({
    kind: "skipped",
    reason: "repo-off",
  });
});

test("a fork change is never reviewed by itself, whoever wrote it: only a request reviews it (ADR 0048)", () => {
  const authors: Change["author"][] = ["you", "agent", "other"];
  for (const author of authors) {
    for (const trigger of ["opened", "push", "first-review"] satisfies Trigger[]) {
      expect([trigger, author, ask(trigger, { author, fork: true }, { settings: { onPush: true } })]).toEqual(
        [trigger, author, { kind: "skipped", reason: "fork" }],
      );
    }
    for (const trigger of ["comment", "manual"] satisfies Trigger[]) {
      expect([trigger, author, ask(trigger, { author, fork: true, draft: true })]).toEqual([
        trigger,
        author,
        { kind: "job" },
      ]);
    }
  }
  // A repository switched off is off for a fork too, and a push nobody asked for skips nothing.
  expect(ask("opened", { fork: true }, { enabled: false })).toEqual({ kind: "skipped", reason: "repo-off" });
  expect(ask("push", { fork: true })).toEqual({ kind: "not-asked" });
});

test("a draft is reviewed when someone asks: a review request comment, the app, or the first review", () => {
  for (const trigger of ["comment", "manual", "first-review"] satisfies Trigger[]) {
    expect([trigger, ask(trigger, { draft: true })]).toEqual([trigger, { kind: "job" }]);
  }
});

test("a push is reviewed only with reviews after every push switched on; otherwise nobody asked", () => {
  expect(ask("push", {}, { settings: { onPush: true } })).toEqual({ kind: "job" });
  expect(ask("push", {}, { settings: { onPush: false } })).toEqual({ kind: "not-asked" });
});

test("an automatic trigger's skip is recorded only for another author's change or a fork's; a request's always (ADR 0043, ADR 0048)", () => {
  const reasons: SkipReason[] = ["not-yours", "fork", "draft", "repo-off", "on-open-off", "codex-not-yours"];
  const told = (trigger: Trigger) =>
    reasons.filter((reason) => skipOutcome(trigger, reason, false) === "record");
  expect(told("opened")).toEqual(["not-yours", "fork"]);
  expect(told("push")).toEqual(["not-yours", "fork"]);
  expect(told("comment")).toEqual(reasons);
  expect(told("manual")).toEqual(reasons);
  expect(told("first-review")).toEqual(reasons);
  // What an automatic trigger doesn't record, nobody asked.
  expect(skipOutcome("opened", "repo-off", false)).toBe("nothing");
  expect(skipOutcome("push", "draft", false)).toBe("nothing");
});

test("an automatic trigger's skip is not recorded while the change has a job waiting or running: it would hide it", () => {
  const reasons: SkipReason[] = ["not-yours", "fork", "draft", "repo-off", "on-open-off"];
  for (const trigger of ["opened", "push"] as const)
    expect([trigger, reasons.map((reason) => skipOutcome(trigger, reason, true))]).toEqual([
      trigger,
      ["nothing", "nothing", "nothing", "nothing", "nothing"],
    ]);
});

test("a request beside a job waiting or running joins it: never a skip recorded that would hide it (ADR 0047)", () => {
  for (const trigger of ["comment", "manual", "first-review"] as const)
    expect([trigger, skipOutcome(trigger, "repo-off", true)]).toEqual([trigger, "join"]);
});

test("with reviews after every push off, a push asks nothing of anyone's change: nothing to skip (ADR 0043)", () => {
  const off = { settings: { onPush: false } };
  expect(ask("push", { author: "other" }, off)).toEqual({ kind: "not-asked" });
  expect(ask("push", { draft: true }, off)).toEqual({ kind: "not-asked" });
  expect(ask("push", {}, { ...off, enabled: false })).toEqual({ kind: "not-asked" });
  expect(ask("push", { author: "other" }, { settings: { onPush: true } })).toEqual({
    kind: "skipped",
    reason: "not-yours",
  });
});
