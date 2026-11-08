// Whether a change that asks for a review gets a review job, or is skipped and why (ADR 0016, ADR 0026).
import { describe, expect, test } from "bun:test";
import type { Change, SettingValues, SkipReason, Trigger } from "@lookover/contracts";
import { endUnsent, type Intake, intake, skipOutcome } from "./index.ts";

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
  reposChosen = true,
): Intake {
  return intake(
    { author: change.author ?? "you", draft: change.draft ?? false, fork: change.fork ?? false },
    { enabled: repository.enabled ?? true, settings: { ...DEFAULTS, ...repository.settings } },
    trigger,
    { reposChosen },
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
      ask("opened", { draft: true, fork: true }, { enabled: false, settings: { onOpen: false } }),
    ],
    ["a change from a fork", ask("opened", { draft: true, fork: true }, { settings: { onOpen: false } })],
    ["a draft that opens", ask("opened", { draft: true }, { settings: { onOpen: false } })],
    ["a push to a draft", ask("push", { draft: true }, { settings: { onPush: true } })],
    ["reviews on open switched off", ask("opened", {}, { settings: { onOpen: false } })],
  ];
  expect(cases).toEqual([
    ["repository switched off", { kind: "skipped", reason: "repo-off" }],
    ["a change from a fork", { kind: "skipped", reason: "fork" }],
    ["a draft that opens", { kind: "skipped", reason: "draft" }],
    ["a push to a draft", { kind: "skipped", reason: "draft" }],
    ["reviews on open switched off", { kind: "skipped", reason: "on-open-off" }],
  ]);
});

test("another author's change is not asked by a trigger nobody asked in person, fork or not, draft or not, repository on or off (ADR 0078)", () => {
  for (const trigger of ["opened", "push", "first-review"] satisfies Trigger[])
    for (const fork of [false, true])
      for (const draft of [false, true])
        for (const enabled of [true, false])
          expect([
            trigger,
            fork,
            draft,
            enabled,
            ask(trigger, { author: "other", fork, draft }, { enabled, settings: { onPush: true } }),
          ]).toEqual([trigger, fork, draft, enabled, { kind: "not-asked" }]);
});

test("the owner's request on another author's change is reviewed: a comment or the app, a fork's too (ADR 0016, ADR 0043)", () => {
  for (const trigger of ["comment", "manual"] satisfies Trigger[])
    for (const fork of [false, true])
      expect([trigger, fork, ask(trigger, { author: "other", draft: true, fork })]).toEqual([
        trigger,
        fork,
        { kind: "job" },
      ]);
  // A repository switched off is off for a request too.
  expect(ask("comment", { author: "other" }, { enabled: false })).toEqual({
    kind: "skipped",
    reason: "repo-off",
  });
});

test("the owner's fork change is never reviewed by itself: it is skipped, told; only a request reviews it (ADR 0048)", () => {
  const authors: Change["author"][] = ["you", "agent"];
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
  expect(skipOutcome("opened", "fork", false)).toBe("record");
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

test("an automatic trigger's skip is recorded only for a fork's; a request's always (ADR 0043, ADR 0048, ADR 0078)", () => {
  const reasons: SkipReason[] = ["not-yours", "fork", "draft", "repo-off", "on-open-off", "codex-not-yours"];
  const told = (trigger: Trigger) =>
    reasons.filter((reason) => skipOutcome(trigger, reason, false) === "record");
  expect(told("opened")).toEqual(["fork"]);
  expect(told("push")).toEqual(["fork"]);
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
  expect(ask("push", { author: "other" }, { settings: { onPush: true } })).toEqual({ kind: "not-asked" });
});

test("an old skip's end owed on another author's change, nobody asked in person, with no check created, is never sent; the person's fork's is (ADR 0078)", () => {
  const skipped = (skip: SkipReason, trigger: Trigger = "opened") => ({
    state: "skipped" as const,
    skip,
    trigger,
  });
  expect([
    endUnsent(skipped("not-yours"), "other", { created: false }),
    // A change no longer listed open: its `not-yours` skip says whose it was.
    endUnsent(skipped("not-yours"), null, { created: false }),
    endUnsent(skipped("fork", "push"), "other", { created: false }),
    endUnsent(skipped("fork"), "you", { created: false }),
    endUnsent(skipped("fork"), "agent", { created: false }),
    // A closed pull request, whose author the store no longer keeps: its skip end is worth nothing.
    endUnsent(skipped("fork"), null, { created: false }),
    // A request's skip was asked in person: its end is sent.
    endUnsent(skipped("repo-off", "comment"), "other", { created: false }),
    endUnsent(skipped("draft"), "other", { created: false }),
    endUnsent({ state: "cancelled", skip: null, trigger: "opened" }, "other", { created: false }),
    // A check already created on the host: its end is sent, so it completes.
    endUnsent(skipped("not-yours"), "other", { created: true }),
    endUnsent(skipped("fork"), null, { created: true }),
  ]).toEqual([true, true, true, false, false, true, false, false, false, false, false]);
});

describe("before the repositories are chosen, nothing asks by itself (ADR 0079)", () => {
  type Case = [
    string,
    Partial<Pick<Change, "author" | "draft" | "fork">>,
    { enabled?: boolean; settings?: Partial<SettingValues> },
  ];
  const cases: Case[] = [
    ["the owner's change", { author: "you" }, {}],
    ["the owner's agent's change", { author: "agent" }, {}],
    ["a teammate's change", { author: "other" }, {}],
    ["the owner's fork change, never told", { author: "you", fork: true }, {}],
    ["a teammate's fork change", { author: "other", fork: true }, {}],
    ["a draft", { draft: true }, {}],
    ["in a repository switched off", {}, { enabled: false }],
    ["with reviews on open switched off", {}, { settings: { onOpen: false } }],
  ];

  test("a change opened or marked ready, and a push, are not asked, before every other rule", () => {
    for (const trigger of ["opened", "push"] as const) {
      for (const [name, change, repository] of cases) {
        const pushes = { ...repository, settings: { onPush: true, ...repository.settings } };
        expect([trigger, name, ask(trigger, change, pushes, false)]).toEqual([
          trigger,
          name,
          { kind: "not-asked" },
        ]);
      }
    }
  });

  test("once chosen, the same changes are asked as the other rules say", () => {
    expect(ask("opened", { author: "you" }, {}, true)).toEqual({ kind: "job" });
    expect(ask("push", { author: "agent" }, { settings: { onPush: true } }, true)).toEqual({ kind: "job" });
    expect(ask("opened", { author: "you", fork: true }, {}, true)).toEqual({
      kind: "skipped",
      reason: "fork",
    });
    expect(ask("opened", { author: "other" }, {}, true)).toEqual({ kind: "not-asked" });
  });

  test("asked in person, it is answered as before: a request, Review now, setup's first review", () => {
    expect(ask("comment", { author: "you" }, {}, false)).toEqual({ kind: "job" });
    expect(ask("manual", { author: "other" }, {}, false)).toEqual({ kind: "job" });
    expect(ask("comment", { author: "you", fork: true }, {}, false)).toEqual({ kind: "job" });
    expect(ask("manual", {}, { enabled: false }, false)).toEqual({ kind: "skipped", reason: "repo-off" });
    expect(ask("first-review", { author: "you" }, {}, false)).toEqual({ kind: "job" });
    expect(ask("first-review", { author: "other" }, {}, false)).toEqual({ kind: "not-asked" });
  });
});
