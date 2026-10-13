// The skill folders on disk (ADR 0058): the real adapter refuses to run under `bun test` on the user's own home, and
// its work is tested on a scratch home instead: Claude Code's `.claude/skills/<name>/SKILL.md` and Codex's
// `.agents/skills/<name>/SKILL.md` written, read and removed, the dev name's folder beside the user's; then the
// service on it, through its API: install, each state read from the folder, the refresh at start, and a remove that
// takes only a skill Lookover stamped.
import { afterAll, afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { CodingAgent } from "@lookover/contracts";
import { homeSkillFolders, renderSkill, type System, userSkillFolders } from "./index.ts";
import {
  fakeEngines,
  openApp,
  post,
  snapshot,
  start,
  stopAll,
  TEST_LIMIT_MS,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "lookover-skills-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let homes = 0;
/** A fresh home folder of the test's own, its name with a space as the owner's has. */
function home(): string {
  const folder = join(scratch, `Sam Doe ${++homes}`);
  mkdirSync(folder);
  return folder;
}

const EXE = "'C:/Users/Your Name/Downloads/lookover.exe'";

test("the real adapter refuses to run under bun test on the user's own home, whatever the name (ADR 0045)", () => {
  const machine: System = { platform: process.platform, homedir: homedir(), env: {}, which: () => null };
  expect(() => userSkillFolders(machine, "lookover-review-loop")).toThrow(/bun test/);
  expect(() => userSkillFolders(machine, "lookover-dev-review-loop")).toThrow(/bun test/);
  expect(() => homeSkillFolders({ home: homedir() })).toThrow(/bun test/);
  expect(() => homeSkillFolders({ home: homedir(), name: "lookover-dev-review-loop" })).toThrow(/bun test/);
  // `bun run live`'s suite says so, and takes the dev skill only: never the user's own.
  expect(() => homeSkillFolders({ home: homedir(), name: "lookover-review-loop", liveSuite: true })).toThrow(
    /bun test/,
  );
  expect(
    homeSkillFolders({ home: homedir(), name: "lookover-dev-review-loop", liveSuite: true }).folderOf(
      "claude",
    ),
  ).toBe(join(homedir(), ".claude", "skills", "lookover-dev-review-loop"));
});

test("each agent's folder under the home: written, read back, the other agent's untouched, removed", async () => {
  const user = home();
  const skills = homeSkillFolders({ home: user });
  expect(skills.folderOf("claude")).toBe(join(user, ".claude", "skills", "lookover-review-loop"));
  expect(skills.folderOf("codex")).toBe(join(user, ".agents", "skills", "lookover-review-loop"));
  expect(await skills.read("claude")).toBeNull();

  await skills.install("claude", "the text\n");
  expect(readFileSync(join(user, ".claude", "skills", "lookover-review-loop", "SKILL.md"), "utf8")).toBe(
    "the text\n",
  );
  expect(await skills.read("claude")).toBe("the text\n");
  expect(await skills.read("codex")).toBeNull();

  await skills.install("claude", "again\n");
  expect(await skills.read("claude")).toBe("again\n");
  await skills.remove("claude");
  expect(await skills.read("claude")).toBeNull();
  expect(existsSync(skills.folderOf("claude"))).toBe(false);
  // Removing none: nothing to do.
  await skills.remove("codex");
});

test("a remove takes only SKILL.md: a file the user put beside it stays, and so does its folder", async () => {
  const skills = homeSkillFolders({ home: home() });
  await skills.install("codex", "the text\n");
  const notes = join(skills.folderOf("codex"), "notes.md");
  writeFileSync(notes, "mine\n");
  await skills.remove("codex");
  expect(await skills.read("codex")).toBeNull();
  expect(readFileSync(notes, "utf8")).toBe("mine\n");
});

test("the dev name writes its own folder, never the user's skill", async () => {
  const user = home();
  const ours = homeSkillFolders({ home: user });
  const dev = homeSkillFolders({ home: user, name: "lookover-dev-review-loop" });
  await ours.install("claude", "the user's\n");
  await dev.install("claude", "the dev one\n");
  expect(dev.folderOf("claude")).toBe(join(user, ".claude", "skills", "lookover-dev-review-loop"));
  expect(await ours.read("claude")).toBe("the user's\n");
  await dev.remove("claude");
  expect(await ours.read("claude")).toBe("the user's\n");
});

test("a folder that can't be read is said, not taken for none", async () => {
  const user = home();
  const skills = homeSkillFolders({ home: user });
  // A folder where SKILL.md should be: reading it fails, and not as a missing file.
  mkdirSync(join(skills.folderOf("claude"), "SKILL.md"), { recursive: true });
  await expect(skills.read("claude")).rejects.toThrow();
});

/** Claude Code and Codex both installed. */
function bothAgents() {
  const engines = fakeEngines();
  engines.setHealth("codex", { installed: true, version: "0.162.1", signedIn: true });
  return engines;
}

/** The service on the real folders of `user`, calling `EXE`. */
async function serviceOn(user: string) {
  const skills = homeSkillFolders({ home: user });
  const { service } = await start({
    agent: { skills, command: { onPath: "lookover", offPath: EXE } },
    engines: bothAgents(),
  });
  return { service, cookie: await openApp(service), skills };
}

const statesIn = (agent: CodingAgent) => agent.skills.map(({ agent: id, state }) => [id, state]);

test("the service on the folders: install, each state read from disk, a remove that takes only Lookover's", async () => {
  const user = home();
  const { service, cookie, skills } = await serviceOn(user);
  expect(statesIn((await snapshot(service, cookie)).service.agent)).toEqual([
    ["claude", "none"],
    ["codex", "none"],
  ]);
  expect((await post(service, cookie, { type: "agent.skill", agent: "claude", on: true })).status).toBe(200);
  const file = join(skills.folderOf("claude"), "SKILL.md");
  expect(readFileSync(file, "utf8")).toBe(
    renderSkill({ name: "lookover-review-loop", command: EXE, version: "0.1.0" }),
  );
  // Codex's: another Lookover's, written by hand meanwhile.
  mkdirSync(skills.folderOf("codex"), { recursive: true });
  writeFileSync(
    join(skills.folderOf("codex"), "SKILL.md"),
    renderSkill({ name: "lookover-review-loop", command: "'D:/old/lookover.exe'", version: "0.1.0" }),
  );
  expect((await post(service, cookie, { type: "agent.check" })).status).toBe(200);
  expect(statesIn((await snapshot(service, cookie)).service.agent)).toEqual([
    ["claude", "ours"],
    ["codex", "another"],
  ]);
  // Claude Code's made by hand: not Lookover's, so a remove leaves it.
  writeFileSync(file, "---\nname: lookover-review-loop\ndescription: my own\n---\n\nMy loop.\n");
  const off = await post(service, cookie, { type: "agent.skill", agent: "claude", on: false });
  expect(off.status).toBe(409);
  expect(readFileSync(file, "utf8")).toContain("My loop.");
  // Another Lookover's is stamped: removed.
  expect((await post(service, cookie, { type: "agent.skill", agent: "codex", on: false })).status).toBe(200);
  expect(existsSync(skills.folderOf("codex"))).toBe(false);
});

test("a start on the folders refreshes only Lookover's own skill of another version", async () => {
  const user = home();
  const skills = homeSkillFolders({ home: user });
  await skills.install(
    "claude",
    renderSkill({ name: "lookover-review-loop", command: EXE, version: "0.0.9" }),
  );
  const another = renderSkill({
    name: "lookover-review-loop",
    command: "'D:/old/lookover.exe'",
    version: "0.0.9",
  });
  await skills.install("codex", another);
  await serviceOn(user);
  expect(await skills.read("claude")).toBe(
    renderSkill({ name: "lookover-review-loop", command: EXE, version: "0.1.0" }),
  );
  expect(await skills.read("codex")).toBe(another);
});
