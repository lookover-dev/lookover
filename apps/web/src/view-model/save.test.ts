import { expect, test } from "bun:test";
import { SAVE_IDLE, type Saving, saveStep } from "./save.ts";

const run = (...steps: Parameters<typeof saveStep>[1][]): Saving => steps.reduce(saveStep, SAVE_IDLE);

test("nothing sent yet: the stamp is hidden", () => {
  expect(SAVE_IDLE.shown).toBe("hidden");
});

test("sent, it says Saving…; taken by the service, Saved", () => {
  expect(run("sent").shown).toBe("saving");
  expect(run("sent", "took").shown).toBe("saved");
});

test("refused, the stamp goes: the band and the toast say why", () => {
  expect(run("sent", "refused").shown).toBe("hidden");
  // A refusal after an earlier save takes that Saved down too: the last change is not saved.
  expect(run("sent", "took", "sent", "refused").shown).toBe("hidden");
});

test("two changes in flight: Saved only once both are answered", () => {
  expect(run("sent", "sent", "took").shown).toBe("saving");
  expect(run("sent", "sent", "took", "took").shown).toBe("saved");
  // One of the two refused: not everything is saved, so no Saved until the next change is taken.
  expect(run("sent", "sent", "refused").shown).toBe("hidden");
  expect(run("sent", "sent", "refused", "took").shown).toBe("hidden");
  expect(run("sent", "sent", "refused", "took", "sent", "took").shown).toBe("saved");
});
