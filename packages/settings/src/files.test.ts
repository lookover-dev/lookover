// The layer files (ADR 0011, ADR 0049): the owner's defaults and a repository's own values, each a YAML file holding
// only what it changes under `$schema` and `version`, read strictly and written through file access passed in, so
// the tests hold the files in memory.
import { expect, test } from "bun:test";
import type { SettingsFileError } from "@lookover/contracts";
import {
  type RepositoryFiles,
  type RepositorySettings,
  type SettingsFiles,
  type SettingsWrite,
  settingAccepts,
  settingsFiles,
} from "./index.ts";

function memory(initial: Record<string, string> = {}): { files: SettingsFiles; disk: Map<string, string> } {
  const disk = new Map(Object.entries(initial));
  return {
    disk,
    files: {
      read: async (file) => disk.get(file) ?? null,
      write: async (file, text) => {
        disk.set(file, text);
      },
      remove: async (file) => {
        disk.delete(file);
      },
    },
  };
}

const OWNER = "settings.yaml";
const REPO = "acme/api/settings.yaml";
const HEADER = "$schema: lookover.settings/v1\nversion: 1\n";
const RULES = [
  { id: "r1", source: "REVIEW.md" as const, text: "Never log a token." },
  { id: "r2", source: "AGENTS.md" as const, text: "Every handler\n  checks the session." },
];
const AT: RepositoryFiles = { owner: OWNER, repository: REPO, rules: RULES };

test("a value is checked by its key as a file's is: a value of another key's is refused", () => {
  expect(settingAccepts("depth", "deep")).toBe(true);
  expect(settingAccepts("strictness", "deep")).toBe(false);
  expect(settingAccepts("strictness", true)).toBe(false);
  expect(settingAccepts("onPush", false)).toBe(true);
  expect(settingAccepts("onOpen", "on")).toBe(false);
});

test("with no file, every value is Lookover's default, no rule is off and nothing is invalid", async () => {
  const { files } = memory();
  const read = await settingsFiles(files).read(AT);
  expect(read.settings.strictness).toEqual({
    value: "recommended",
    origin: "lookover-default",
    overrode: null,
  });
  expect(read.defaults.depth).toEqual({ value: "standard", origin: "lookover-default", overrode: null });
  expect(read.rulesOff.size).toBe(0);
  expect(read.invalid).toEqual([]);
});

test("a value set is written as only what the layer changes, under $schema and version, keys in their fixed order", async () => {
  const { files, disk } = memory();
  const room = settingsFiles(files);
  await room.setDefault(OWNER, "onPush", true);
  await room.setDefault(OWNER, "depth", "deep");
  await room.setDefault(OWNER, "strictness", "blocking");
  expect(disk.get(OWNER)).toBe(`${HEADER}strictness: blocking\ndepth: deep\nonPush: true\n`);
  expect(disk.has(REPO)).toBe(false);
});

test("a repository's value sits over the owner's default, which sits over Lookover's", async () => {
  const { files } = memory({
    [OWNER]: `${HEADER}strictness: blocking\nreviewers: codex\n`,
    [REPO]: `${HEADER}strictness: everything\n`,
  });
  const read = await settingsFiles(files).read(AT);
  expect(read.defaults.strictness).toEqual({
    value: "blocking",
    origin: "owner-default",
    overrode: { value: "recommended", origin: "lookover-default" },
  });
  expect(read.settings.strictness).toEqual({
    value: "everything",
    origin: "owner-repository",
    overrode: { value: "blocking", origin: "owner-default" },
  });
  expect(read.settings.reviewers.origin).toBe("owner-default");
});

test("the answer to a write is the settings read again", async () => {
  const { files } = memory();
  const written = await settingsFiles(files).set(AT, "depth", "quick");
  expect(written).toMatchObject({ ok: true, now: { settings: { depth: { value: "quick" } } } });
});

test("setting the value the layer below gives stores nothing, and a layer left with nothing is removed", async () => {
  const { files, disk } = memory({ [OWNER]: `${HEADER}onPush: true\n`, [REPO]: `${HEADER}onPush: false\n` });
  const room = settingsFiles(files);
  await room.set(AT, "onPush", true);
  expect(disk.has(REPO)).toBe(false);
  await room.setDefault(OWNER, "onPush", false);
  expect(disk.has(OWNER)).toBe(false);
});

test("a reset removes the layer's value: the inherited one applies, with its origin", async () => {
  const { files, disk } = memory({
    [OWNER]: `${HEADER}reviewers: claude\n`,
    [REPO]: `${HEADER}reviewers: codex\nonOpen: false\n`,
  });
  const written = await settingsFiles(files).reset(AT, "reviewers");
  expect(written).toMatchObject({
    ok: true,
    now: { settings: { reviewers: { value: "claude", origin: "owner-default" } } },
  });
  expect(disk.get(REPO)).toBe(`${HEADER}onOpen: false\n`);
});

test("a rule switched off is kept by its file and its text, spacing collapsed, and read back by its id", async () => {
  const { files, disk } = memory();
  const room = settingsFiles(files);
  const written = await room.setRule(AT, "r2", false);
  expect(disk.get(REPO)).toBe(
    `${HEADER}rulesOff:\n  - file: AGENTS.md\n    text: Every handler checks the session.\n`,
  );
  expect(written.ok && [...written.now.rulesOff]).toEqual(["r2"]);
  await room.setRule(AT, "r2", true);
  expect(disk.has(REPO)).toBe(false);
});

test("a hand-written rule line matches whatever its spacing; one in another file or with other words doesn't", async () => {
  const { files } = memory({
    [REPO]: `${HEADER}rulesOff:\n  - file: REVIEW.md\n    text: "  Never   log a\\n token. "\n  - file: AGENTS.md\n    text: Never log a token.\n  - file: AGENTS.md\n    text: Every handler checks the cookie.\n`,
  });
  const read = await settingsFiles(files).read(AT);
  expect([...read.rulesOff]).toEqual(["r1"]);
  // A rule read after the files were is matched the same way.
  expect(read.switchedOff({ source: "AGENTS.md", text: "Every handler  checks the cookie." })).toBe(true);
  expect(read.switchedOff({ source: "REVIEW.md", text: "Every handler checks the cookie." })).toBe(false);
});

test("a rule line that matches no rule any more is dropped when a rule's switch is next written", async () => {
  const { files, disk } = memory({
    [REPO]: `${HEADER}rulesOff:\n  - file: REVIEW.md\n    text: A rule since deleted.\n`,
  });
  await settingsFiles(files).setRule(AT, "r1", false);
  expect(disk.get(REPO)).toBe(`${HEADER}rulesOff:\n  - file: REVIEW.md\n    text: Never log a token.\n`);
});

test("a rule the place doesn't know, or the owner's own, can't be switched: a programming error", async () => {
  const { files } = memory();
  const room = settingsFiles(files);
  await expect(room.setRule(AT, "nope", false)).rejects.toThrow();
  const yours = { ...AT, rules: [{ id: "y1", source: "yours" as const, text: "Mine." }] };
  await expect(room.setRule(yours, "y1", false)).rejects.toThrow();
});

test("the owner's defaults hold no rule switches: rulesOff there is a key that isn't a setting", async () => {
  const { files } = memory({ [OWNER]: `${HEADER}rulesOff: []\n` });
  const read = await settingsFiles(files).read(AT);
  expect(read.invalid).toEqual([{ file: OWNER, problem: "unknown_key", key: "rulesOff" }]);
});

test("a hand-written file reads the same, whatever its spacing, comments or key order", async () => {
  const { files } = memory({
    [OWNER]:
      "# my defaults\n$schema: lookover.settings/v1\nonPush: true\n\nversion: 1\nstrictness: everything # loud\n",
  });
  const read = await settingsFiles(files).read(AT);
  expect(read.defaults.strictness.value).toBe("everything");
  expect(read.defaults.onPush.value).toBe(true);
  expect(read.invalid).toEqual([]);
});

test("an unknown key makes the file invalid, with the key named, and its layer counts as empty", async () => {
  const { files } = memory({
    [OWNER]: `${HEADER}strictnes: blocking\nonPush: true\n`,
  });
  const read = await settingsFiles(files).read(AT);
  expect(read.invalid).toEqual([{ file: OWNER, problem: "unknown_key", key: "strictnes" }]);
  expect(read.settings.onPush).toEqual({ value: false, origin: "lookover-default", overrode: null });
});

test("a value the key doesn't accept makes the file invalid, with the key named", async () => {
  const { files } = memory({
    [OWNER]: `${HEADER}strictness: strict\n`,
    [REPO]: `${HEADER}onPush: 'true'\n`,
  });
  const read = await settingsFiles(files).read(AT);
  expect(read.invalid).toEqual([
    { file: OWNER, problem: "wrong_type", key: "strictness" },
    { file: REPO, problem: "wrong_type", key: "onPush" },
  ]);
});

test("a rule line that isn't a file and a text is a wrong value for rulesOff", async () => {
  for (const lines of [
    "rulesOff: REVIEW.md\n",
    "rulesOff:\n  - Never log a token.\n",
    "rulesOff:\n  - file: README.md\n    text: Never log a token.\n",
    "rulesOff:\n  - file: REVIEW.md\n    text: 3\n",
    "rulesOff:\n  - file: REVIEW.md\n    text: Never.\n    line: 3\n",
  ]) {
    const { files } = memory({ [REPO]: `${HEADER}${lines}` });
    const read = await settingsFiles(files).read(AT);
    expect(read.invalid).toEqual([{ file: REPO, problem: "wrong_type", key: "rulesOff" }]);
  }
});

test("a file of another format or version is invalid, naming $schema or version", async () => {
  const { files } = memory({
    [OWNER]: "version: 1\nonPush: true\n",
    [REPO]: "$schema: lookover.settings/v1\nversion: 2\n",
  });
  const read = await settingsFiles(files).read(AT);
  expect(read.invalid).toEqual([
    { file: OWNER, problem: "wrong_version", key: "$schema" },
    { file: REPO, problem: "wrong_version", key: "version" },
  ]);
});

test("a file that isn't a YAML mapping is invalid as not YAML, no key named", async () => {
  for (const text of ["- onPush\n", "a: [b\n", ""]) {
    const { files } = memory({ [OWNER]: text });
    const read = await settingsFiles(files).read(AT);
    expect(read.invalid).toEqual([{ file: OWNER, problem: "not_yaml", key: null }]);
  }
});

test("a change to an invalid file is refused with its error and never written; the other layer still changes", async () => {
  const broken = `${HEADER}strictnes: blocking\n`;
  const { files, disk } = memory({ [REPO]: broken });
  const room = settingsFiles(files);
  const refusal: SettingsWrite<RepositorySettings> = {
    ok: false,
    error: { file: REPO, problem: "unknown_key", key: "strictnes" },
  };
  expect(await room.set(AT, "onPush", true)).toEqual(refusal);
  expect(await room.reset(AT, "onPush")).toEqual(refusal);
  expect(await room.setRule(AT, "r1", false)).toEqual(refusal);
  expect(disk.get(REPO)).toBe(broken);
  expect(await room.setDefault(OWNER, "onPush", true)).toMatchObject({ ok: true });
});

test("a write the file access fails is the caller's to answer: the failure comes back as thrown", async () => {
  const { files } = memory();
  const failing: SettingsFiles = {
    ...files,
    write: async () => {
      throw new Error("EACCES");
    },
  };
  await expect(settingsFiles(failing).setDefault(OWNER, "onPush", true)).rejects.toThrow("EACCES");
});

test("the owner's defaults are read and changed with no repository", async () => {
  const { files, disk } = memory();
  const room = settingsFiles(files);
  expect(await room.readDefaults(OWNER)).toMatchObject({
    defaults: { strictness: { value: "recommended", origin: "lookover-default" } },
    invalid: [],
  });
  expect(await room.setDefault(OWNER, "reviewers", "claude")).toMatchObject({
    ok: true,
    now: { defaults: { reviewers: { value: "claude", origin: "owner-default" } }, invalid: [] },
  });
  expect(disk.get(OWNER)).toBe(`${HEADER}reviewers: claude\n`);
  expect(await room.resetDefault(OWNER, "reviewers")).toMatchObject({
    ok: true,
    now: { defaults: { reviewers: { value: "both", origin: "lookover-default" } } },
  });
  expect(disk.has(OWNER)).toBe(false);
});

test("the owner's file that doesn't read is named, and a change to it refused, with no repository", async () => {
  const { files } = memory({ [OWNER]: "a: [b\n" });
  const room = settingsFiles(files);
  const error: SettingsFileError = { file: OWNER, problem: "not_yaml", key: null };
  expect((await room.readDefaults(OWNER)).invalid).toEqual([error]);
  expect(await room.setDefault(OWNER, "onPush", true)).toEqual({ ok: false, error });
});

test("a file that can't be read (a folder by its name, no permission) is an invalid layer, named, and never written", async () => {
  const { files, disk } = memory({ [OWNER]: `${HEADER}depth: deep\n` });
  const unreadable: SettingsFiles = {
    ...files,
    read: (file) =>
      file === REPO
        ? Promise.reject(new Error("EISDIR: illegal operation on a directory"))
        : files.read(file),
  };
  const room = settingsFiles(unreadable);
  const error: SettingsFileError = { file: REPO, problem: "unreadable", key: null };
  const read = await room.read(AT);
  expect(read.invalid).toEqual([error]);
  expect(read.settings.depth).toMatchObject({ value: "deep", origin: "owner-default" });
  expect(await room.set(AT, "depth", "quick")).toEqual({ ok: false, error });
  expect(disk.has(REPO)).toBe(false);
});

test("a change that leaves the layer as it was writes nothing and removes nothing", async () => {
  const kept = `# mine\n${HEADER}strictness: blocking\n`;
  const { files, disk } = memory({ [REPO]: kept });
  const calls: string[] = [];
  const counted: SettingsFiles = {
    read: files.read,
    write: async (file, text) => {
      calls.push(`write ${file}`);
      await files.write(file, text);
    },
    remove: async (file) => {
      calls.push(`remove ${file}`);
      await files.remove(file);
    },
  };
  const room = settingsFiles(counted);
  expect(await room.reset(AT, "onPush")).toMatchObject({ ok: true });
  expect(await room.set(AT, "strictness", "blocking")).toMatchObject({ ok: true });
  expect(await room.setRule(AT, "r1", true)).toMatchObject({ ok: true });
  expect(await room.resetDefault(OWNER, "depth")).toMatchObject({ ok: true });
  expect(calls).toEqual([]);
  expect(disk.get(REPO)).toBe(kept);
});

test("with the owner's file invalid, a repository's value is set over Lookover's default", async () => {
  const { files, disk } = memory({ [OWNER]: `${HEADER}onPush: yes please\n` });
  const room = settingsFiles(files);
  // Lookover's default for onPush is false: true is kept, false is not.
  expect(await room.set(AT, "onPush", true)).toMatchObject({
    ok: true,
    now: {
      settings: {
        onPush: {
          value: true,
          origin: "owner-repository",
          overrode: { value: false, origin: "lookover-default" },
        },
      },
      invalid: [{ file: OWNER, problem: "wrong_type", key: "onPush" }],
    },
  });
  expect(disk.get(REPO)).toBe(`${HEADER}onPush: true\n`);
  await room.set(AT, "onPush", false);
  expect(disk.has(REPO)).toBe(false);
});
