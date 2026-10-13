// What a restart does with a job the stopped service left running (ADR 0043, #62, ADR 0044): a run that had reached
// publishing resumes its posts (its round is saved, nothing is found again); any other runs again once, unless a
// restart already retried it (a crash loop stops).
import { expect, test } from "bun:test";
import { afterRestart } from "./index.ts";

test("a job interrupted before publishing, never retried, runs again", () => {
  expect(afterRestart({ step: "preparing", retries: 0 })).toBe("runs-again");
  expect(afterRestart({ step: "finding", retries: 0 })).toBe("runs-again");
  expect(afterRestart({ step: "confirming", retries: 0 })).toBe("runs-again");
});

test("a job interrupted a second time before publishing fails", () => {
  expect(afterRestart({ step: "finding", retries: 1 })).toBe("fails");
});

test("a job interrupted while publishing resumes its posts, however often it was retried (ADR 0044)", () => {
  expect(afterRestart({ step: "publishing", retries: 0 })).toBe("resumes");
  expect(afterRestart({ step: "publishing", retries: 1 })).toBe("resumes");
});
