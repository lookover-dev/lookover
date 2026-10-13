import { test } from "bun:test";
import { expectDraft } from "./kinds.test-support.ts";

test("a draft", () => {
  expectDraft("draft");
});
