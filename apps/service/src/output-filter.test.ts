// What a finding says is filtered before it is posted (ADR 0056, SR-08), through the service's door on fakes: the
// publisher is handed the log sink's secrets filter, so a secret the service registered never reaches GitHub, while
// the app, from the store, keeps the finding as the engine wrote it.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readResult } from "@lookover/contracts";
import { DemoClock, ScriptedRetrieval, type ScriptedRun } from "@lookover/testkit";
import { openLogSink } from "./index.ts";
import {
  api,
  fakeEngines,
  home,
  messages,
  openApp,
  PLANTED,
  pr1,
  review,
  SANDBOX,
  snapshot,
  start,
  stopAll,
  T0,
  TEST_LIMIT_MS,
  until,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

/** A block as the engine writes it. */
const answered = (block: unknown): ScriptedRun => ({
  outcome: "ok",
  text: ["```json", JSON.stringify(block), "```"].join("\n"),
});

/** `src/total.ts`, its 40 lines added: line 12 takes a comment. */
const TOTAL_ADDED = [
  "diff --git a/src/total.ts b/src/total.ts",
  "--- /dev/null",
  "+++ b/src/total.ts",
  "@@ -0,0 +1,40 @@",
  ...Array.from({ length: 40 }, (_, i) => `+line ${i + 1}`),
  "",
].join("\n");

test("a secret the service knows and a mention in a finding never reach GitHub; the app keeps the finding as written", async () => {
  const dir = home();
  const sink = await openLogSink({ home: dir, clock: { now: () => T0 }, userOnly: async () => {} });
  const time = new DemoClock({ at: T0 });
  const engines = fakeEngines({ time });
  const retrieval = new ScriptedRetrieval();
  retrieval.diff = TOTAL_ADDED;
  const { service, host } = await start({
    home: dir,
    time,
    engines,
    retrieval,
    changes: [pr1],
    logSink: sink,
  });
  // The session's secret, registered with the sink as the server started.
  const secret = readFileSync(join(dir, "session"), "utf8");
  const title = `The session ${secret} is logged`;
  engines.answer(
    answered({
      findings: [
        {
          path: "src/total.ts",
          line: 12,
          severity: "blocking",
          category: "security",
          title,
          body: "Ask @dana before ![x](https://evil.example/p.png) ships.",
          defect_key: "session-logged",
        },
      ],
    }),
    answered({
      verdicts: [
        {
          id: "C1",
          verdict: "confirmed",
          reason: "It is.",
          evidence: ["src/total.ts:12"],
          severity: "blocking",
        },
      ],
    }),
  );
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "round.finished");

  const { reviews, comments } = host.view({ repo: SANDBOX, number: pr1.number });
  const comment = reviews[0]?.comments[0]?.body ?? "";
  expect(comment).toStartWith(
    "**The session [redacted] is logged** · Blocking\n\nAsk @\u{200B}dana before !\u{200B}[x](https://evil.example/p.png) ships.",
  );
  const check = host.posts.findLast((p) => p.kind === "check.completed");
  const posted = [comment, comments[0]?.body ?? "", JSON.stringify(check)];
  for (const text of posted) expect(text).not.toContain(secret);
  const result = readResult(check?.kind === "check.completed" ? check.output.text : "");
  expect(result?.findings[0]?.title).toBe("The session [redacted] is logged");
  // The store keeps what the engine wrote: the app shows it to the owner.
  const shown = (await snapshot(service, cookie)).reviews[PLANTED].findings;
  expect(shown?.[0]?.title).toBe(title);
});
