// The sign-in store (ADR 0066, "The sign-in is kept like the key"): the person signed in to the shared App in
// `github/sign-in.json`, their tokens sealed in `github/sign-in.<entry>.key` under a data key the keychain holds, or
// in a user-only file when the keychain can't, as the App's key is. Every test runs on the fake keychain.
import { afterAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SignIn } from "@lookover/contracts";
import {
  appStore,
  boundedKeychain,
  type Keychain,
  memoryKeychain,
  type StoredApp,
  signInStore,
  type Timers,
} from "./index.ts";

const homes: string[] = [];
afterAll(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function folder(parent?: string): string {
  const dir = mkdtempSync(join(parent ?? realpathSync.native(tmpdir()), "lookover-sign-in-"));
  if (parent === undefined) homes.push(dir);
  return dir;
}

const SAM: SignIn = {
  token: "ghu_16C7e42F292c6912E7710c838347Ae178B4a",
  expiresAt: Date.UTC(2026, 9, 30, 18, 0),
  refreshToken: "ghr_1B4a2e77838347a7E420ce178F2E7c6912E1",
  refreshExpiresAt: Date.UTC(2027, 3, 30, 10, 0),
  person: { id: 1234, login: "sasensi" },
};
const OCTOCAT: SignIn = {
  token: "ghu_aaaabbbbccccddddeeeeffff0000111122223",
  expiresAt: Date.UTC(2026, 9, 30, 19, 0),
  refreshToken: "ghr_9999888877776666555544443333222211110",
  refreshExpiresAt: Date.UTC(2027, 3, 30, 11, 0),
  person: { id: 583231, login: "octocat" },
};

/** The user-only step the tests inject: each file must still be empty when it is made user-only. */
const userOnly = async (path: string) => {
  expect(statSync(path).size).toBe(0);
};
const storeOf = (home: string, keychain: Keychain) => signInStore({ home, keychain, userOnly });
const filesIn = (home: string) => readdirSync(join(home, "github")).sort();
/** Every file of `github/` as text, one string. */
const allText = (home: string) =>
  filesIn(home)
    .map((name) => readFileSync(join(home, "github", name), "latin1"))
    .join("\n");

/** Timers on which every wait has passed at once. */
const PASSED: Timers = {
  after: (_ms, fire) => {
    queueMicrotask(fire);
    return () => {};
  },
  now: () => 0,
};
const never = () => new Promise<never>(() => {});
/** A keychain that never answers, like a prompt nobody sees. */
const SILENT: Keychain = { get: never, set: never, delete: never };

test("a sign-in written is read back the same, its tokens sealed: no token is in any file", async () => {
  const home = folder();
  const keychain = memoryKeychain();
  expect(await storeOf(home, keychain).read()).toEqual({ state: "none" });
  expect(await storeOf(home, keychain).write(SAM)).toEqual({ protection: "keychain" });
  expect(await storeOf(home, keychain).read()).toEqual({
    state: "kept",
    signIn: SAM,
    protection: "keychain",
  });
  const [entry] = keychain.names();
  expect(filesIn(home)).toEqual(["sign-in.json", `sign-in.${entry}.key`]);
  expect(JSON.parse(readFileSync(join(home, "github", "sign-in.json"), "utf8"))).toEqual({
    person: { id: 1234, login: "sasensi" },
    key: { kept: "keychain", entry },
  });
  expect(allText(home)).not.toContain(SAM.token);
  expect(allText(home)).not.toContain(SAM.refreshToken);
});

test("the keeper reads the sign-in kept and writes the renewed one; nothing kept reads as none", async () => {
  const home = folder();
  const store = storeOf(home, memoryKeychain());
  expect(await store.keeper.read()).toBeNull();
  await store.write(SAM);
  expect(await store.keeper.read()).toEqual(SAM);
  const renewed = { ...SAM, token: "ghu_renewed", refreshToken: "ghr_renewed", expiresAt: SAM.expiresAt + 1 };
  expect(await store.keeper.write(renewed, SAM)).toBe(true);
  expect(await store.keeper.read()).toEqual(renewed);
});

test("a renewal never replaces a new sign-in kept meanwhile: the keeper writes it only in place of the one it renews", async () => {
  const home = folder();
  const store = storeOf(home, memoryKeychain());
  await store.write(SAM);
  const renewed = { ...SAM, token: "ghu_renewed", refreshToken: "ghr_renewed", expiresAt: SAM.expiresAt + 1 };
  const [, written] = await Promise.all([store.write(OCTOCAT), store.keeper.write(renewed, SAM)]);
  expect(written).toBe(false);
  expect(await store.keeper.read()).toEqual(OCTOCAT);
  expect(await store.keeper.write(renewed, SAM)).toBe(false);
  expect(await storeOf(folder(), memoryKeychain()).keeper.write(renewed, SAM)).toBe(false);
});

test("a new sign-in replaces the last, whoever it names: the old entry and its file go", async () => {
  const home = folder();
  const keychain = memoryKeychain();
  await storeOf(home, keychain).write(SAM);
  const [first] = keychain.names();
  await storeOf(home, keychain).write(OCTOCAT);
  const [second, ...more] = keychain.names();
  expect(more).toEqual([]);
  expect(second).not.toBe(first);
  expect(filesIn(home)).toEqual(["sign-in.json", `sign-in.${second}.key`]);
  expect(await storeOf(home, keychain).read()).toEqual({
    state: "kept",
    signIn: OCTOCAT,
    protection: "keychain",
  });
});

test("a keychain that doesn't answer keeps the sign-in in a user-only file, and says so", async () => {
  const home = folder();
  const store = signInStore({ home, keychain: memoryKeychain({ refuse: true }), userOnly });
  expect(await store.write(SAM)).toEqual({ protection: "user-file" });
  const [file, record, ...more] = filesIn(home);
  expect(more).toEqual([]);
  expect(record).toBe("sign-in.json");
  expect(file).toMatch(/^sign-in\.[0-9a-f]{24}\.token$/);
  expect(await store.read()).toEqual({ state: "kept", signIn: SAM, protection: "user-file" });
  const silent = signInStore({ home: folder(), keychain: boundedKeychain(SILENT, PASSED, 1), userOnly });
  expect(await silent.write(SAM)).toEqual({ protection: "user-file" });
});

test("a fallback token file that isn't the store's reads as lost, naming the person; the keeper then has none", async () => {
  const home = folder();
  const store = signInStore({ home, keychain: memoryKeychain({ refuse: true }), userOnly });
  await store.write(SAM);
  const file = filesIn(home).find((name) => name.endsWith(".token"));
  if (file === undefined) throw new Error("no fallback token file");
  writeFileSync(join(home, "github", file), "{ not json");
  expect(await store.read()).toEqual({
    state: "lost",
    person: { id: 1234, login: "sasensi" },
    why: "unopened",
  });
  expect(await store.keeper.read()).toBeNull();
});

test("a deleted keychain entry reads as lost, naming the person; the keeper then has none", async () => {
  const home = folder();
  const keychain = memoryKeychain();
  await storeOf(home, keychain).write(SAM);
  for (const name of keychain.names()) await keychain.delete(name);
  expect(await storeOf(home, keychain).read()).toEqual({
    state: "lost",
    person: { id: 1234, login: "sasensi" },
    why: "gone",
  });
  expect(await storeOf(home, keychain).keeper.read()).toBeNull();
});

test("the sign-in and the App kept in one folder never remove each other's files", async () => {
  const home = folder();
  const keychain = memoryKeychain();
  const app: StoredApp = {
    id: 4242,
    slug: "lookover-x7k2qa",
    account: { id: 1234, login: "sasensi", type: "User" },
    person: { id: 1234, login: "sasensi" },
  };
  const apps = appStore({ home, keychain, userOnly });
  await apps.write(app, "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\n");
  await storeOf(home, keychain).write(SAM);
  await apps.write(app, "-----BEGIN RSA PRIVATE KEY-----\nMIIF\n-----END RSA PRIVATE KEY-----\n");
  await storeOf(home, keychain).write(OCTOCAT);
  expect(keychain.names()).toHaveLength(2);
  expect((await apps.read()).state).toBe("kept");
  expect(await storeOf(home, keychain).read()).toEqual({
    state: "kept",
    signIn: OCTOCAT,
    protection: "keychain",
  });
});

test("the keychain entry starts lookover-dev- for a data folder under .dev", async () => {
  const keychain = memoryKeychain();
  const parent = folder();
  const dev = join(parent, ".dev");
  mkdirSync(dev);
  await storeOf(folder(dev), keychain).write(SAM);
  await storeOf(folder(), keychain).write(SAM);
  const names = keychain.names();
  expect(names.filter((n) => /^lookover-dev-[0-9a-f]{24}$/.test(n))).toHaveLength(1);
  expect(names.filter((n) => /^lookover-[0-9a-f]{24}$/.test(n))).toHaveLength(1);
});
