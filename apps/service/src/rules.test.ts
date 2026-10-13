// The repository's rules in a review (ADR 0048): "Review now" on the planted sandbox through the real retrieval
// (git on a local bare repository), with `main`'s `REVIEW.md` and pull request #1 shipping its own hostile
// `REVIEW.md`, `AGENTS.md` and `CLAUDE.md`. Both passes are given `main`'s rule and none of the change's; the finder
// cites it, the finding carries it, and what is posted names it. The rules read, and their counts once the round cites
// one, are sent to the UI as `rules.changed`, and the snapshot holds them. A rule switched off (ADR 0049) is kept in
// the repository's settings file and given to neither pass. `FakeEngines` answer: no `claude`, no `codex`.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Rule, readResult, repositoryId, SUMMARY_MARKER } from "@lookover/contracts";
import { openStore } from "@lookover/store";
import { SANDBOX_BAIT, ScriptedRetrieval, type ScriptedRun } from "@lookover/testkit";
import {
  api,
  fakeEngines,
  home,
  messages,
  openApp,
  plantedSandbox,
  post,
  realRetrieval,
  review,
  SANDBOX,
  SANDBOX_SETTINGS,
  SHA1,
  snapshot,
  start,
  stopAll,
  TEST_LIMIT_MS,
  until,
  withRules,
  writeSettings,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

/** The sandbox with its rules, planted once before the test, not at load: the change, its clone URL, its owner. */
let planted: {
  changes: ReturnType<typeof withRules>;
  cloneUrl: string;
  owner: { id: number; login: string };
};
let remove = () => {};
beforeAll(() => {
  const { dir, sandbox, remove: removeDir } = plantedSandbox();
  remove = removeDir;
  const changes = withRules(dir, sandbox.changes);
  // The planted change is the owner's, as in demo mode.
  const owner = changes[0]?.author;
  if (!owner) throw new Error("the planted sandbox has no pull request");
  planted = { changes, cloneUrl: sandbox.cloneUrl, owner };
});
afterAll(() => remove());

/** A block as the engine writes it, after a line of notes. */
const answered = (block: unknown): ScriptedRun => ({
  outcome: "ok",
  text: ["Notes.", "```json", JSON.stringify(block), "```"].join("\n"),
});

const LOGGED = 'console.log("listing invoices", all.map((i) => i.apiKey));';

/** The finder: the planted log of the API key, citing `main`'s rule by its label. */
const FOUND = answered({
  findings: [
    {
      path: "src/invoices.ts",
      line: 9,
      line_text: LOGGED,
      severity: "blocking",
      category: "repo_rule",
      title: "listInvoices logs every API key",
      body: "When invoices are listed, each one's API key is written to the log, because the call maps them all.",
      defect_key: "secret_logged",
      rule: "R1",
    },
  ],
});

const CONFIRMED = answered({
  verdicts: [
    {
      id: "C1",
      verdict: "confirmed",
      reason: "Line 9 logs `i.apiKey`.",
      evidence: ["src/invoices.ts:9"],
      severity: "blocking",
    },
  ],
});

/** A prompt's rules section: from its heading to the next section's. */
const rulesOf = (prompt: string) => /## The repository's rules\n[\s\S]*?\n(?=## )/.exec(prompt)?.[0] ?? "";

const RULE = "Never log a secret: an API key, a token or a password.";
const CENTS = "Every amount is in integer cents.";

test("both passes follow main's rules, not the change's; the finding cites REVIEW.md, line 3, and the post names it", async () => {
  const dir = home();
  const engines = fakeEngines();
  engines.answer(FOUND, CONFIRMED);
  const { service, host } = await start({
    home: dir,
    engines,
    retrieval: realRetrieval(dir),
    ...planted,
  });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  const toRound = await until(stream, "round.finished");
  const finished = toRound.at(-1);
  if (finished?.type !== "round.finished") throw new Error("no round");
  // The rules read are sent before the round, none cited yet; the round that cites one moves its count.
  const read = toRound.find((e) => e.type === "rules.changed");
  const counted = (await until(stream, "rules.changed")).at(-1);
  if (read?.type !== "rules.changed" || counted?.type !== "rules.changed") throw new Error("no rules sent");
  const counts = (rules: Rule[]) =>
    rules.map((r) => [r.text, r.source, r.line, r.raised, r.acted, r.enabled]);
  expect(read.repoId).toBe(repositoryId("sasensi/lookover-sandbox"));
  expect(counts(read.rules)).toEqual([
    [RULE, "REVIEW.md", 3, 0, 0, true],
    [CENTS, "REVIEW.md", 4, 0, 0, true],
  ]);
  expect(counts(counted.rules)).toEqual([
    [RULE, "REVIEW.md", 3, 1, 0, true],
    [CENTS, "REVIEW.md", 4, 0, 0, true],
  ]);
  expect(counted.rules[0]?.id).toBe(finished.findings[0]?.rule?.id ?? "");
  expect((await snapshot(service, cookie)).rules).toEqual(counted.rules);

  // Both passes: main's rule, labelled, and nothing the change ships, though its diff holds the bait.
  const [find, confirm] = engines.runs.map((r) => r.prompt);
  expect(rulesOf(find ?? "")).toContain(`R1 (line 3): ${RULE}`);
  expect(rulesOf(confirm ?? "")).toContain(`R1 (line 3): ${RULE}`);
  for (const prompt of [find, confirm]) expect(rulesOf(prompt ?? "")).not.toContain(SANDBOX_BAIT);
  expect(find).toContain(SANDBOX_BAIT);
  expect(confirm).toContain(
    `It cites the repository's rule R1 (REVIEW.md, line 3):\n\n\`\`\`markdown\n# Review rules\n${RULE}\n`,
  );

  expect(finished.findings.map((f) => [f.category, f.rule?.file, f.rule?.line, f.why.ruleText])).toEqual([
    ["repo_rule", "REVIEW.md", 3, RULE],
  ]);
  const view = host.view({ repo: SANDBOX, number: 1 });
  expect(view.reviews[0]?.comments[0]?.body).toContain("Rule: REVIEW.md, line 3.");
  expect(view.comments.find((c) => c.body.startsWith(SUMMARY_MARKER))).toBeDefined();
  const result = readResult(view.checks[0]?.output.text ?? "");
  expect(result?.findings.map((f) => f.rule)).toEqual([
    { id: finished.findings[0]?.rule?.id ?? "", source: "REVIEW.md", line: 3 },
  ]);
});

test("rules the store kept that the UI never heard of (a crash between the two) are sent at start", async () => {
  const dir = home();
  const repoId = repositoryId("sasensi/lookover-sandbox");
  const store = openStore({ home: dir, durable: false });
  store.rules.read(repoId, [{ id: "r-1", file: "REVIEW.md", line: 3, text: RULE, parentIds: [] }]);
  store.close();
  const { service } = await start({ home: dir, ...planted });
  const cookie = await openApp(service);
  const rules: Rule[] = (await snapshot(service, cookie)).rules;
  expect(rules.map((r) => [r.repoId, r.id, r.text, r.source, r.line, r.raised, r.acted, r.enabled])).toEqual([
    [repoId, "r-1", RULE, "REVIEW.md", 3, 0, 0, true],
  ]);
});

const NOTHING = answered({ findings: [] });
const EDITED = "Every amount is a whole number of cents.";

/** No git: `main`'s REVIEW.md as scripted, a rule per line from line 1. */
function mainRules(...rules: string[]): ScriptedRetrieval {
  const retrieval = new ScriptedRetrieval();
  const text = rules.map((rule) => `- ${rule}\n`).join("");
  retrieval.scriptRules(SANDBOX, [{ path: "REVIEW.md", text, commit: SHA1 }]);
  return retrieval;
}

test("a rule switched off is written to the repository's file, stays off after a restart and goes to neither pass; an edited one is on", async () => {
  const dir = home();
  const engines = fakeEngines();
  engines.answer(NOTHING, NOTHING, NOTHING);
  const first = await start({ home: dir, engines, retrieval: mainRules(RULE, CENTS) });
  const cookie = await openApp(first.service);
  const stream = messages(await fetch(api(first.service, "/events"), { headers: { cookie } }));
  expect((await review(first.service, cookie)).status).toBe(200);
  await until(stream, "round.finished");
  const [secret, cents]: Rule[] = (await snapshot(first.service, cookie)).rules;
  if (secret?.text !== RULE || cents?.text !== CENTS) throw new Error("not the rules of main");

  // Switched off: the line in the repository's file, then the event.
  const off = { type: "rule.setEnabled", ruleId: cents.id, enabled: false };
  expect((await post(first.service, cookie, off)).status).toBe(200);
  expect((await until(stream, "rule.changed")).at(-1)).toMatchObject({ ruleId: cents.id, enabled: false });
  expect(readFileSync(join(dir, SANDBOX_SETTINGS), "utf8")).toBe(
    `$schema: lookover.settings/v1\nversion: 1\nrulesOff:\n  - file: REVIEW.md\n    text: ${CENTS}\n`,
  );
  await first.service.stop();

  // Restarted, it is still off, and the next round's passes are given only the rule on.
  const retrieval = mainRules(RULE, CENTS);
  const again = await start({ home: dir, engines, retrieval, time: first.time, idsFrom: 100 });
  const kept = await openApp(again.service);
  const switches = (rules: Rule[]) => rules.map((r) => [r.text, r.enabled]);
  expect(switches((await snapshot(again.service, kept)).rules)).toEqual([
    [RULE, true],
    [CENTS, false],
  ]);
  const next = messages(await fetch(api(again.service, "/events"), { headers: { cookie: kept } }));
  /** A round on main's rules as they are: the rules sections both passes were given. */
  const round = async () => {
    const before = engines.runs.length;
    expect((await review(again.service, kept)).status).toBe(200);
    await until(next, "round.finished");
    const given = engines.runs.slice(before).map((r) => rulesOf(r.prompt));
    expect(given.length).toBeGreaterThan(0);
    return given;
  };
  for (const prompt of await round()) {
    expect(prompt).toContain(`R1 (line 1): ${RULE}`);
    expect(prompt).not.toContain(CENTS);
  }

  // The rule is edited on main: a new rule, on, and given to the passes.
  retrieval.scriptRules(SANDBOX, [{ path: "REVIEW.md", text: `- ${RULE}\n- ${EDITED}\n`, commit: SHA1 }]);
  for (const prompt of await round()) {
    expect(prompt).toContain(`R1 (line 1): ${RULE}`);
    expect(prompt).toContain(`R2 (line 2): ${EDITED}`);
  }
  expect(switches((await snapshot(again.service, kept)).rules)).toEqual([
    [RULE, true],
    [EDITED, true],
  ]);
});

test("a rule switch refused on a file that doesn't read, retried once it is repaired, sends the settings it reads now", async () => {
  const dir = home();
  const store = openStore({ home: dir, durable: false });
  store.rules.read(repositoryId("sasensi/lookover-sandbox"), [
    { id: "r-1", file: "REVIEW.md", line: 3, text: RULE, parentIds: [] },
  ]);
  store.close();
  writeSettings(dir, SANDBOX_SETTINGS, "$schema: lookover.settings/v1\nversion: 1\ndepth: [\n");
  const { service } = await start({ home: dir });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  const off = { type: "rule.setEnabled", ruleId: "r-1", enabled: false };
  expect((await post(service, cookie, off)).status).toBe(409);

  // Repaired by hand, with a value of its own: the retried switch is written, and the depth is sent with it.
  writeSettings(dir, SANDBOX_SETTINGS, "$schema: lookover.settings/v1\nversion: 1\ndepth: deep\n");
  expect((await post(service, cookie, off)).status).toBe(200);
  const changed = (await until(stream, "settings.changed")).at(-1);
  if (changed?.type !== "settings.changed") throw new Error("no settings sent");
  expect(changed.repos[repositoryId("sasensi/lookover-sandbox")]?.depth).toMatchObject({ value: "deep" });
  expect((await snapshot(service, cookie)).rules.map((r: Rule) => [r.id, r.enabled])).toEqual([
    ["r-1", false],
  ]);
});

test("a setting refused on a file that doesn't read, retried once it is repaired, sends the rule switches it holds", async () => {
  const dir = home();
  const store = openStore({ home: dir, durable: false });
  store.rules.read(repositoryId("sasensi/lookover-sandbox"), [
    { id: "r-1", file: "REVIEW.md", line: 3, text: CENTS, parentIds: [] },
  ]);
  store.close();
  const rulesOff = `rulesOff:\n  - file: REVIEW.md\n    text: ${CENTS}\n`;
  writeSettings(dir, SANDBOX_SETTINGS, `$schema: lookover.settings/v1\nversion: 1\ndepth: [\n${rulesOff}`);
  const { service } = await start({ home: dir });
  const cookie = await openApp(service);
  expect((await snapshot(service, cookie)).rules.map((r: Rule) => [r.id, r.enabled])).toEqual([
    ["r-1", true],
  ]);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  const deep = { type: "repo.setSetting", repoId: "sasensi/lookover-sandbox", key: "depth", value: "deep" };
  expect((await post(service, cookie, deep)).status).toBe(409);

  // Repaired by hand, the rule switched off there: the retried setting is written, and the switch is sent with it.
  writeSettings(dir, SANDBOX_SETTINGS, `$schema: lookover.settings/v1\nversion: 1\n${rulesOff}`);
  expect((await post(service, cookie, deep)).status).toBe(200);
  const changed = (await until(stream, "rules.changed")).at(-1);
  if (changed?.type !== "rules.changed") throw new Error("no rules sent");
  expect(changed.rules.map((r) => [r.id, r.enabled])).toEqual([["r-1", false]]);
});

test("a rule switched off takes the rules nested in it with it: shown off with their own switch kept, given to neither pass", async () => {
  const engines = fakeEngines();
  engines.answer(NOTHING, NOTHING);
  const retrieval = new ScriptedRetrieval();
  const text = "- Only in tests:\n  - Mocks are fine.\n- Never log a token.\n";
  retrieval.scriptRules(SANDBOX, [{ path: "REVIEW.md", text, commit: SHA1 }]);
  const { service } = await start({ engines, retrieval });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "round.finished");
  const shown = async () =>
    (await snapshot(service, cookie)).rules.map((r: Rule) => [r.text, r.enabled, r.parentOff]);
  const [tests]: Rule[] = (await snapshot(service, cookie)).rules;
  const off = { type: "rule.setEnabled", ruleId: tests?.id ?? "", enabled: false };
  expect((await post(service, cookie, off)).status).toBe(200);
  expect(await shown()).toEqual([
    ["Only in tests:", false, false],
    ["Mocks are fine.", true, true],
    ["Never log a token.", true, false],
  ]);

  const before = engines.runs.length;
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "round.finished");
  const given = engines.runs.slice(before).map((r) => rulesOf(r.prompt));
  expect(given.length).toBeGreaterThan(0);
  for (const prompt of given) {
    expect(prompt).toContain("R1 (line 3): Never log a token.");
    expect(prompt).not.toContain("Only in tests:");
    expect(prompt).not.toContain("Mocks");
  }

  // Back on, it brings them back as their own switches say.
  expect((await post(service, cookie, { ...off, enabled: true })).status).toBe(200);
  expect(await shown()).toEqual([
    ["Only in tests:", true, false],
    ["Mocks are fine.", true, false],
    ["Never log a token.", true, false],
  ]);
});

test("a rule the service doesn't keep can't be switched: 404, nothing sent, the file as it was", async () => {
  const dir = home();
  const text = `$schema: lookover.settings/v1\nversion: 1\nrulesOff:\n  - file: REVIEW.md\n    text: ${CENTS}\n`;
  writeSettings(dir, SANDBOX_SETTINGS, text);
  const { service } = await start({ home: dir });
  const cookie = await openApp(service);
  const before = (await snapshot(service, cookie)).seq;
  const unknown = { type: "rule.setEnabled", ruleId: "no-such-rule", enabled: false };
  const refused = await post(service, cookie, unknown);
  expect(refused.status).toBe(404);
  expect(await refused.json()).toEqual({ error: "no such rule", refused: "no_such_rule" });
  expect((await snapshot(service, cookie)).seq).toBe(before);
  expect(readFileSync(join(dir, SANDBOX_SETTINGS), "utf8")).toBe(text);
});
