import { test } from "bun:test";
import { expectDraft } from "../test/outside.test-support.ts";

test("a draft", () => {
  expectDraft("draft");
});
