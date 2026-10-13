// What the engine does while a round runs, in words (ADR 0055): one line per activity in Details › Log, plain text.
import { expect, test } from "bun:test";
import type { RunActivity } from "@lookover/contracts";
import { activityText, liveLog } from "./activity.ts";

test("each activity says what the engine did, its path, pattern or command as it came", () => {
  expect(activityText({ kind: "read", path: "src/invoices.ts" })).toBe("Read src/invoices.ts");
  expect(activityText({ kind: "search", pattern: "listInvoices" })).toBe("Searched for listInvoices");
  expect(activityText({ kind: "list", pattern: "**/*.ts" })).toBe("Listed **/*.ts");
  expect(activityText({ kind: "command", text: "rg --files" })).toBe("Ran rg --files");
});

test("an activity carrying a link or markdown is said as plain text, nothing taken out or added", () => {
  const link = "[the fix](https://evil.example/steal?x=1) **now** <b>bold</b> `code`";
  expect(activityText({ kind: "read", path: link })).toBe(`Read ${link}`);
  expect(activityText({ kind: "command", text: "echo <script>alert(1)</script>" })).toBe(
    "Ran echo <script>alert(1)</script>",
  );
});

const found = (engine: RunActivity["engine"], activity: RunActivity["activity"]): RunActivity => ({
  engine,
  pass: engine === "claude" ? "find" : "confirm",
  activity,
});

test("the live log is the run's activities, oldest first, each with the AI that did it", () => {
  const log = liveLog({
    reviewer: "claude",
    activities: [
      found("claude", { kind: "search", pattern: "listInvoices" }),
      found("claude", { kind: "read", path: "src/invoices.ts" }),
      found("codex", { kind: "command", text: "rg --files" }),
    ],
  });
  expect(log).toEqual({
    lines: [
      { who: "Claude", text: "Searched for listInvoices" },
      { who: "Claude", text: "Read src/invoices.ts" },
      { who: "Codex", text: "Ran rg --files" },
    ],
    empty: null,
  });
});

test("before the engine did anything, and once no round runs, the block says what shows in it", () => {
  expect(liveLog({ reviewer: "codex", activities: [] })).toEqual({
    lines: [],
    empty: "Codex hasn't opened anything yet.",
  });
  expect(liveLog(null)).toEqual({
    lines: [],
    empty: "While a round runs, what the AI reads, searches and runs shows here.",
  });
});
