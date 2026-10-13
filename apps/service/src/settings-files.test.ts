// The settings' files on disk (ADR 0049): where each layer's file is in the data folder, and the port that writes
// them whole or not at all, never outside the folder.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diskSettingsFiles, repositorySettingsFile, SettingsUnwritten } from "./index.ts";

const homes: string[] = [];
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function root(): string {
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), "lookover-settings-"));
  homes.push(dir);
  return dir;
}

test("the owner's file is at the data folder's root, a repository's in its own folder, lowercased", () => {
  expect(repositorySettingsFile({ owner: "Sasensi", name: "Lookover-Sandbox" })).toBe(
    "sasensi/lookover-sandbox/settings.yaml",
  );
  expect(repositorySettingsFile({ owner: "acme", name: "api.v2_x" })).toBe("acme/api.v2_x/settings.yaml");
});

test("a name that could leave the folder or that Windows won't make is never a path: .., a device name, a trailing dot, a slash", () => {
  const refused = [
    { owner: "acme", name: ".." },
    { owner: "..", name: "api" },
    { owner: "acme", name: "." },
    { owner: "acme", name: "con" },
    { owner: "NUL", name: "api" },
    { owner: "acme", name: "lpt1" },
    { owner: "acme", name: "com9.txt" },
    { owner: "acme", name: "api." },
    { owner: "acme", name: "api/../../x" },
    { owner: "acme/x", name: "api" },
    { owner: "acme", name: "a\\b" },
    { owner: "acme", name: "C:" },
    { owner: "", name: "api" },
  ];
  for (const repo of refused) expect(repositorySettingsFile(repo)).toBeNull();
});

test("an owner named as one of the service's own folders at the data folder's root is never a path", () => {
  // The root holds the store and the service's folders (ADR 0053): a repository's settings never mix into them.
  for (const owner of ["session", "rooms", "repos", "runs", "self-tests", "worktrees", "github", "Runs"])
    expect(repositorySettingsFile({ owner, name: "api" })).toBeNull();
  // As a repository's name, the same word is a folder of its owner's: no clash.
  expect(repositorySettingsFile({ owner: "acme", name: "runs" })).toBe("acme/runs/settings.yaml");
});

test("the port never reads, writes or removes outside the data folder", async () => {
  const dir = root();
  const files = diskSettingsFiles(join(dir, "data"));
  for (const file of ["../settings.yaml", "acme/../../x.yaml", join(dir, "x.yaml")]) {
    await expect(files.write(file, "version: 1\n")).rejects.toThrow("outside the data folder");
    await expect(files.read(file)).rejects.toThrow("outside the data folder");
    await expect(files.remove(file)).rejects.toThrow("outside the data folder");
  }
  expect(readdirSync(dir)).toEqual([]);
});

test("a write lands whole, readable by its owner only, its folder made; a missing file reads as none and removes quietly", async () => {
  const dir = root();
  const files = diskSettingsFiles(dir);
  expect(await files.read("acme/api/settings.yaml")).toBeNull();
  await files.write("acme/api/settings.yaml", "depth: deep\n");
  expect(await files.read("acme/api/settings.yaml")).toBe("depth: deep\n");
  expect(readdirSync(join(dir, "acme", "api"))).toEqual(["settings.yaml"]);
  if (process.platform !== "win32")
    expect(statSync(join(dir, "acme", "api", "settings.yaml")).mode & 0o777).toBe(0o600);
  await files.remove("acme/api/settings.yaml");
  await files.remove("acme/api/settings.yaml");
  expect(existsSync(join(dir, "acme", "api", "settings.yaml"))).toBe(false);
});

test("a rename refused (the file held open on Windows) leaves the file as it was and no temporary file, and says so", async () => {
  const dir = root();
  const held = Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
  const files = diskSettingsFiles(dir, {
    rename: () => Promise.reject(held),
    platform: "win32",
  });
  await diskSettingsFiles(dir).write("settings.yaml", "depth: quick\n");
  const refused = files.write("settings.yaml", "depth: deep\n");
  await expect(refused).rejects.toBeInstanceOf(SettingsUnwritten);
  await expect(refused).rejects.toMatchObject({ file: "settings.yaml", why: "held-open" });
  expect(readFileSync(join(dir, "settings.yaml"), "utf8")).toBe("depth: quick\n");
  expect(readdirSync(dir)).toEqual(["settings.yaml"]);
});

test("any other failure is refused with the system's words, and leaves no temporary file", async () => {
  const dir = root();
  const full = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
  const files = diskSettingsFiles(dir, { rename: () => Promise.reject(full), platform: "linux" });
  const refused = files.write("settings.yaml", "depth: deep\n");
  await expect(refused).rejects.toMatchObject({
    file: "settings.yaml",
    why: "other",
    message: "settings.yaml was not written: ENOSPC: no space left on device, write",
  });
  expect(readdirSync(dir)).toEqual([]);
});
