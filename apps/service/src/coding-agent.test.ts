// Your coding agent through the service, on the fake ports (ADR 0058): `lookover` put on the PATH and taken off,
// Lookover's command following it; the skill installed, replaced and removed per agent Lookover found; the state read
// again after a change made outside Lookover; a write the machine refuses refusing the command with why, the state
// kept; and no PATH offer from a clone.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import type { CodingAgent, Event } from "@lookover/contracts";
import { memoryCommandPath, memorySkillFolders, renderSkill } from "./index.ts";
import {
  api,
  fakeEngines,
  messages,
  openApp,
  post,
  snapshot,
  start,
  stopAll,
  TEST_LIMIT_MS,
  until,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const BIN = "C:\\Users\\Your Name\\AppData\\Local\\Lookover\\bin";
const EXE = "& 'C:\\Users\\Your Name\\Downloads\\lookover.exe'";
/** Lookover's command: `lookover` once the PATH reaches it, the binary's path before. */
const command = { onPath: "lookover", offPath: EXE };
const CLAUDE_SKILL = "~/.claude/skills/lookover-review-loop";
const CODEX_SKILL = "~/.agents/skills/lookover-review-loop";

/** Claude Code and Codex both installed. */
function bothAgents() {
  const engines = fakeEngines();
  engines.setHealth("codex", { installed: true, version: "0.162.1", signedIn: true });
  return engines;
}

/** A service on the fake ports, and a session on it. */
async function serviceWith(o: { offer?: "binary" | "clone"; both?: boolean } = {}) {
  const path = memoryCommandPath({ folder: BIN });
  const skills = memorySkillFolders({ home: "~" });
  const engines = o.both ? bothAgents() : fakeEngines();
  const { service } = await start({ agent: { path, skills, offer: o.offer ?? "binary", command }, engines });
  const cookie = await openApp(service);
  const events = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  return { service, cookie, path, skills, events, engines };
}

/** The agent state the last `service.changed` among `events` carried. */
const agentIn = (events: Event[]): CodingAgent | undefined =>
  events.flatMap((e) => (e.type === "service.changed" && e.patch.agent ? [e.patch.agent] : [])).at(-1);

test("at start the snapshot says the PATH doesn't reach Lookover, offers it, and lists only the agents found", async () => {
  const { service, cookie } = await serviceWith();
  const state = await snapshot(service, cookie);
  expect(state.service.command).toBe(EXE);
  expect(state.service.agent).toEqual({
    path: { reach: "no", folder: BIN },
    offer: "binary",
    // Codex isn't installed: it isn't offered.
    skills: [{ agent: "claude", state: "none", folder: CLAUDE_SKILL }],
  });
});

test("on the PATH and off it: each sent with Lookover's command, which becomes `lookover` and back", async () => {
  const { service, cookie, path, events } = await serviceWith();
  expect((await post(service, cookie, { type: "agent.path", on: true })).status).toBe(200);
  const added = await until(events, "service.changed");
  expect(added).toContainEqual(
    expect.objectContaining({
      type: "service.changed",
      patch: expect.objectContaining({ command: "lookover" }),
    }),
  );
  expect(agentIn(added)?.path).toEqual({ reach: "yes", folder: BIN });
  expect(await path.reachable()).toEqual({ reach: "yes", folder: BIN });
  expect((await snapshot(service, cookie)).service).toMatchObject({
    command: "lookover",
    agent: { path: { reach: "yes" } },
  });

  expect((await post(service, cookie, { type: "agent.path", on: false })).status).toBe(200);
  expect((await snapshot(service, cookie)).service).toMatchObject({
    command: EXE,
    agent: { path: { reach: "no" } },
  });
});

test("a link in a folder the PATH doesn't name: linked, and the command stays the binary's path", async () => {
  const { service, cookie, path } = await serviceWith();
  path.linkedOffPath();
  expect((await post(service, cookie, { type: "agent.check" })).status).toBe(200);
  expect((await snapshot(service, cookie)).service).toMatchObject({
    command: EXE,
    agent: { path: { reach: "linked", folder: BIN } },
  });
});

test("another `lookover` first on the PATH: said with its path, on the PATH or not, and the command stays the binary's path", async () => {
  const { service, cookie, path } = await serviceWith();
  const other = "C:\\Users\\Your Name\\AppData\\Roaming\\npm\\lookover.cmd";
  path.otherFirst(other);
  expect((await post(service, cookie, { type: "agent.check" })).status).toBe(200);
  const state = { command: EXE, agent: { path: { reach: "other", folder: BIN, other } } };
  expect((await snapshot(service, cookie)).service).toMatchObject(state);
  // Lookover's folder on the PATH after the other one: a terminal still runs the other.
  expect((await post(service, cookie, { type: "agent.path", on: true })).status).toBe(200);
  expect((await snapshot(service, cookie)).service).toMatchObject(state);
  path.otherFirst(null);
  expect((await post(service, cookie, { type: "agent.check" })).status).toBe(200);
  expect((await snapshot(service, cookie)).service).toMatchObject({
    command: "lookover",
    agent: { path: { reach: "yes", folder: BIN } },
  });
});

test("Lookover's launcher running another copy: stale, with that copy, and Add points it at this Lookover", async () => {
  const { service, cookie, path } = await serviceWith();
  const old = "C:\\Users\\Your Name\\Downloads\\lookover.exe";
  await path.add();
  path.staleLauncher(old);
  expect((await post(service, cookie, { type: "agent.check" })).status).toBe(200);
  // A terminal's `lookover` runs the other copy: the command stays this one's path.
  expect((await snapshot(service, cookie)).service).toMatchObject({
    command: EXE,
    agent: { path: { reach: "stale", folder: BIN, other: old } },
  });
  expect((await post(service, cookie, { type: "agent.path", on: true })).status).toBe(200);
  expect((await snapshot(service, cookie)).service).toMatchObject({
    command: "lookover",
    agent: { path: { reach: "yes", folder: BIN } },
  });
});

test("the skill installed and removed per agent: each folder holds Lookover's stamped text, the other agent untouched", async () => {
  const { service, cookie, skills } = await serviceWith({ both: true });
  expect((await snapshot(service, cookie)).service.agent.skills).toEqual([
    { agent: "claude", state: "none", folder: CLAUDE_SKILL },
    { agent: "codex", state: "none", folder: CODEX_SKILL },
  ]);
  expect((await post(service, cookie, { type: "agent.skill", agent: "claude", on: true })).status).toBe(200);
  expect((await post(service, cookie, { type: "agent.skill", agent: "codex", on: true })).status).toBe(200);
  // The skill calls Lookover by its absolute command, whatever the PATH says.
  const written = renderSkill({ name: "lookover-review-loop", command: EXE, version: "0.1.0" });
  expect(await skills.read("claude")).toBe(written);
  expect(await skills.read("codex")).toBe(written);
  expect((await snapshot(service, cookie)).service.agent.skills).toEqual([
    { agent: "claude", state: "ours", folder: CLAUDE_SKILL },
    { agent: "codex", state: "ours", folder: CODEX_SKILL },
  ]);

  expect((await post(service, cookie, { type: "agent.skill", agent: "claude", on: false })).status).toBe(200);
  expect(await skills.read("claude")).toBeNull();
  expect((await snapshot(service, cookie)).service.agent.skills).toEqual([
    { agent: "claude", state: "none", folder: CLAUDE_SKILL },
    { agent: "codex", state: "ours", folder: CODEX_SKILL },
  ]);
});

test("another Lookover's skill and a hand-made one are told apart; on replaces either; off leaves a hand-made one", async () => {
  const { service, cookie, skills, events } = await serviceWith();
  skills.put(
    "claude",
    renderSkill({ name: "lookover-review-loop", command: "& 'D:\\old\\lookover.exe'", version: "0.1.0" }),
  );
  expect((await post(service, cookie, { type: "agent.check" })).status).toBe(200);
  expect(agentIn(await until(events, "service.changed"))?.skills).toEqual([
    { agent: "claude", state: "another", folder: CLAUDE_SKILL },
  ]);

  const mine = "---\nname: lookover-review-loop\ndescription: my own\n---\n\nMy loop.\n";
  skills.put("claude", mine);
  expect((await post(service, cookie, { type: "agent.check" })).status).toBe(200);
  expect((await snapshot(service, cookie)).service.agent.skills[0]?.state).toBe("foreign");
  // Not Lookover's: removing it is refused, the file left as it is.
  const off = await post(service, cookie, { type: "agent.skill", agent: "claude", on: false });
  expect([off.status, await off.json()]).toEqual([
    409,
    { error: "the skill isn't Lookover's", agent: "not_ours" },
  ]);
  expect(await skills.read("claude")).toBe(mine);
  // Replace: installed over it.
  expect((await post(service, cookie, { type: "agent.skill", agent: "claude", on: true })).status).toBe(200);
  expect((await snapshot(service, cookie)).service.agent.skills[0]?.state).toBe("ours");
});

test("an agent found or gone at an engine check: its skill offered or not, without asking", async () => {
  const { service, cookie, engines, events } = await serviceWith();
  engines.setHealth("codex", { installed: true, version: "0.162.1", signedIn: true });
  expect((await post(service, cookie, { type: "engine.check" })).status).toBe(200);
  for (;;) {
    const skills = agentIn(await until(events, "service.changed"))?.skills;
    if (skills === undefined) continue;
    expect(skills).toEqual([
      { agent: "claude", state: "none", folder: CLAUDE_SKILL },
      { agent: "codex", state: "none", folder: CODEX_SKILL },
    ]);
    break;
  }
  engines.setHealth("codex", { installed: false, version: null, signedIn: false });
  expect((await post(service, cookie, { type: "engine.check" })).status).toBe(200);
  for (;;) {
    const skills = agentIn(await until(events, "service.changed"))?.skills;
    if (skills === undefined) continue;
    expect(skills).toEqual([{ agent: "claude", state: "none", folder: CLAUDE_SKILL }]);
    break;
  }
});

test("a skill removed by hand shows as removed once read again", async () => {
  const { service, cookie, skills } = await serviceWith();
  expect((await post(service, cookie, { type: "agent.skill", agent: "claude", on: true })).status).toBe(200);
  skills.put("claude", null);
  // Nothing reads it by itself: the step or Settings asks.
  expect((await snapshot(service, cookie)).service.agent.skills[0]?.state).toBe("ours");
  expect((await post(service, cookie, { type: "agent.check" })).status).toBe(200);
  expect((await snapshot(service, cookie)).service.agent.skills[0]?.state).toBe("none");
});

test("removing a skill already removed by hand, or now hand-made: what the folder holds is sent", async () => {
  const { service, cookie, skills } = await serviceWith();
  expect((await post(service, cookie, { type: "agent.skill", agent: "claude", on: true })).status).toBe(200);
  skills.put("claude", null);
  expect((await post(service, cookie, { type: "agent.skill", agent: "claude", on: false })).status).toBe(200);
  expect((await snapshot(service, cookie)).service.agent.skills[0]?.state).toBe("none");

  expect((await post(service, cookie, { type: "agent.skill", agent: "claude", on: true })).status).toBe(200);
  skills.put("claude", "---\nname: lookover-review-loop\ndescription: my own\n---\n\nMy loop.\n");
  expect((await post(service, cookie, { type: "agent.skill", agent: "claude", on: false })).status).toBe(409);
  expect((await snapshot(service, cookie)).service.agent.skills[0]?.state).toBe("foreign");
});

test("a PATH or a skill the machine can't read: said not there, its folder still named", async () => {
  const { service, cookie, path, skills } = await serviceWith();
  expect((await post(service, cookie, { type: "agent.path", on: true })).status).toBe(200);
  path.unreadable("Access is denied.");
  skills.unreadable("Access is denied.");
  expect((await post(service, cookie, { type: "agent.check" })).status).toBe(200);
  expect((await snapshot(service, cookie)).service).toMatchObject({
    command: EXE,
    agent: {
      path: { reach: "no", folder: BIN },
      skills: [{ agent: "claude", state: "none", folder: CLAUDE_SKILL }],
    },
  });
});

test("removing a skill the machine can't read refuses with why: it may still be there", async () => {
  const { service, cookie, skills } = await serviceWith();
  expect((await post(service, cookie, { type: "agent.skill", agent: "claude", on: true })).status).toBe(200);
  skills.unreadable("Access is denied.");
  const removed = await post(service, cookie, { type: "agent.skill", agent: "claude", on: false });
  expect([removed.status, await removed.json()]).toEqual([
    500,
    { error: "The skill didn't change: Access is denied." },
  ]);
});

test("a write the machine refuses refuses the command with why, and the state stays as it was", async () => {
  const { service, cookie, path, skills } = await serviceWith();
  path.refuse("Access is denied.");
  const onPath = await post(service, cookie, { type: "agent.path", on: true });
  expect([onPath.status, await onPath.json()]).toEqual([
    500,
    { error: "The PATH didn't change: Access is denied." },
  ]);
  skills.refuse("The folder is read-only.");
  const skill = await post(service, cookie, { type: "agent.skill", agent: "claude", on: true });
  expect([skill.status, await skill.json()]).toEqual([
    500,
    { error: "The skill didn't change: The folder is read-only." },
  ]);
  expect((await snapshot(service, cookie)).service).toMatchObject({
    command: EXE,
    agent: {
      path: { reach: "no" },
      skills: [{ agent: "claude", state: "none" }],
    },
  });
  // Allowed again, the same commands go through.
  path.refuse(null);
  skills.refuse(null);
  expect((await post(service, cookie, { type: "agent.path", on: true })).status).toBe(200);
  expect((await post(service, cookie, { type: "agent.skill", agent: "claude", on: true })).status).toBe(200);
});

test("a command no skill line holds: the skill refused with why, nothing written", async () => {
  const skills = memorySkillFolders({ home: "~" });
  const refused = "The skill can't be installed: Lookover's command holds a backtick.";
  const skill = { name: "lookover-review-loop", command: "", version: "0.1.0", refused };
  const { service } = await start({ agent: { skills, command, skill }, engines: fakeEngines() });
  const cookie = await openApp(service);
  const on = await post(service, cookie, { type: "agent.skill", agent: "claude", on: true });
  expect([on.status, await on.json()]).toEqual([500, { error: `The skill didn't change: ${refused}` }]);
  expect(await skills.read("claude")).toBeNull();
});

test("an agent Lookover didn't find is refused", async () => {
  const { service, cookie, skills } = await serviceWith();
  const codex = await post(service, cookie, { type: "agent.skill", agent: "codex", on: true });
  expect([codex.status, await codex.json()]).toEqual([
    404,
    { error: "no such agent", agent: "no_such_agent" },
  ]);
  expect(await skills.read("codex")).toBeNull();
});

test("from a clone there is no PATH offer: the state says so and `agent.path` is refused, the PATH untouched", async () => {
  const { service, cookie, path } = await serviceWith({ offer: "clone" });
  expect((await snapshot(service, cookie)).service.agent.offer).toBe("clone");
  const on = await post(service, cookie, { type: "agent.path", on: true });
  expect([on.status, await on.json()]).toEqual([409, { error: "no PATH offer here", agent: "not_offered" }]);
  expect((await path.reachable()).reach).toBe("no");
  // The skill is still offered: it calls the clone by its absolute command.
  expect((await post(service, cookie, { type: "agent.skill", agent: "claude", on: true })).status).toBe(200);
});

test("at start, only Lookover's own skill written by another version is refreshed; nothing is created", async () => {
  const skills = memorySkillFolders({ home: "~" });
  const old = renderSkill({ name: "lookover-review-loop", command: EXE, version: "0.0.9" });
  const another = renderSkill({
    name: "lookover-review-loop",
    command: "'D:/old/lookover.exe'",
    version: "0.0.9",
  });
  skills.put("claude", old);
  skills.put("codex", another);
  const { service } = await start({ agent: { skills, command }, engines: bothAgents() });
  const cookie = await openApp(service);
  // The same command, another version: written again for this one, and shown as ours.
  expect(await skills.read("claude")).toBe(
    renderSkill({ name: "lookover-review-loop", command: EXE, version: "0.1.0" }),
  );
  // Another Lookover's: left as it is.
  expect(await skills.read("codex")).toBe(another);
  expect((await snapshot(service, cookie)).service.agent.skills).toMatchObject([
    { agent: "claude", state: "ours" },
    { agent: "codex", state: "another" },
  ]);

  // A hand-made skill, or none: nothing written.
  const mine = "---\nname: lookover-review-loop\ndescription: my own\n---\n\nMy loop.\n";
  const fresh = memorySkillFolders({ home: "~" });
  fresh.put("claude", mine);
  await start({ agent: { skills: fresh, command }, engines: bothAgents() });
  expect(await fresh.read("claude")).toBe(mine);
  expect(await fresh.read("codex")).toBeNull();
});
