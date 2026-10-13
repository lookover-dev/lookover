// The App store (ADR 0053, "Where the App is kept"): the App's record in `github/app.json`, its key encrypted in
// `github/app.<entry>.key` under a data key the keychain holds, or kept in a user-only file when the keychain can't.
// Every test runs on the fake keychain: none touches the OS keychain. One test makes files user-only for real (on
// Windows, `icacls`, slow); the others inject a step that checks each file is still empty when it is called.
import { afterAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, join } from "node:path";
import {
  type AppRead,
  appStore,
  boundedKeychain,
  type Keychain,
  KeychainUnavailable,
  memoryKeychain,
  type StoredApp,
  type Timers,
} from "./index.ts";

const homes: string[] = [];
afterAll(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function folder(): string {
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), "lookover-app-"));
  homes.push(dir);
  return dir;
}

const APP: StoredApp = {
  id: 4242,
  slug: "lookover-x7k2qa",
  account: { id: 77, login: "sasensi", type: "User" },
  person: { id: 77, login: "sasensi" },
};
/** A key's shape, made up: the store keeps text, it never parses it. */
const KEY =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun\n-----END RSA PRIVATE KEY-----\n";

/** Timers on which every wait has passed at once: a keychain call that never answers times out. */
const PASSED: Timers = {
  after: (_ms, fire) => {
    queueMicrotask(fire);
    return () => {};
  },
  now: () => 0,
};
/** A keychain that never answers, like a prompt nobody sees. */
const never = () => new Promise<never>(() => {});
const SILENT: Keychain = { get: never, set: never, delete: never };

/** The user-only step the tests inject: each file must still be empty when it is made user-only. */
const userOnly = async (path: string) => {
  expect(statSync(path).size).toBe(0);
};
/** The store of `home` on `keychain`, with the injected user-only step. */
const storeOf = (home: string, keychain: Keychain) => appStore({ home, keychain, userOnly });

/** The unencrypted key's file, from the data folder: named after a random id of its own. */
const PEM = /^github\/app\.[0-9a-f]{24}\.pem$/;

/** The unencrypted key's file name in `github/`, as a read names it. */
const nameOf = (read: AppRead) => ("fallback" in read ? read.fallback.slice("github/".length) : "");

const filesIn = (home: string) => readdirSync(join(home, "github")).sort();
const sealedFile = (entry: string | undefined) => `app.${entry}.key`;

/** Who may open `file`: on Windows its access list as `icacls` prints it, elsewhere its mode. */
function expectUserOnly(file: string) {
  if (process.platform !== "win32") {
    expect(statSync(file).mode & 0o777).toBe(0o600);
    return;
  }
  const me = userInfo().username.toLowerCase();
  const printed = Bun.spawnSync(["icacls", file]).stdout.toString();
  const entries = (printed.split(/\r?\n\s*\r?\n/)[0] ?? "")
    .slice(file.length)
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line !== "");
  // One entry, not inherited: the user (as `DOMAIN\user`), full control.
  expect(entries).toHaveLength(1);
  expect(entries[0]?.endsWith(`\\${me}:(f)`)).toBe(true);
}

test("an App written is read back the same, its key sealed in a file named after its entry", async () => {
  const home = folder();
  const keychain = memoryKeychain();
  const store = storeOf(home, keychain);
  expect(await store.read()).toEqual({ state: "none" });
  expect(await store.write(APP, KEY)).toEqual({ protection: "keychain" });
  expect(await store.read()).toEqual({
    state: "kept",
    app: APP,
    privateKey: KEY,
    membership: null,
    protection: "keychain",
  });
  const [entry] = keychain.names();
  expect(keychain.names()).toHaveLength(1);
  expect(filesIn(home)).toEqual(["app.json", sealedFile(entry)]);
});

test("an organisation's App keeps its account, with its type, apart from the person it works for", async () => {
  const home = folder();
  const store = storeOf(home, memoryKeychain());
  const acme: StoredApp = {
    id: 4243,
    slug: "lookover-q9w1zz",
    account: { id: 900, login: "acme", type: "Organization" },
    person: { id: 77, login: "sasensi" },
  };
  await store.write(acme, KEY);
  expect(await store.read()).toMatchObject({ state: "kept", app: acme });
  expect(JSON.parse(readFileSync(join(home, "github", "app.json"), "utf8"))).toMatchObject({
    account: { id: 900, login: "acme", type: "Organization" },
    person: { id: 77, login: "sasensi" },
  });
});

test("every file the store writes is user-only: the record, the sealed key and the unencrypted one", async () => {
  const home = folder();
  const keychain = memoryKeychain();
  await appStore({ home, keychain }).write(APP, KEY);
  const [entry] = keychain.names();
  expectUserOnly(join(home, "github", "app.json"));
  expectUserOnly(join(home, "github", sealedFile(entry)));

  const fallback = folder();
  await appStore({ home: fallback, keychain: memoryKeychain({ refuse: true }) }).write(APP, KEY);
  const [pem] = filesIn(fallback).filter((name) => name.endsWith(".pem"));
  expectUserOnly(join(fallback, "github", "app.json"));
  expectUserOnly(join(fallback, "github", `${pem}`));
});

test("another data folder never opens the key, even on the same keychain; a moved folder still does", async () => {
  const keychain = memoryKeychain();
  const [a, b] = [folder(), folder()];
  await storeOf(a, keychain).write(APP, KEY);
  await storeOf(b, keychain).write(APP, "another key\n");
  const [aEntry, bEntry] = keychain.names();
  const [aFile, bFile] = [join(a, "github", sealedFile(aEntry)), join(b, "github", sealedFile(bEntry))];
  const aKey = readFileSync(aFile);
  writeFileSync(aFile, readFileSync(bFile));
  writeFileSync(bFile, aKey);
  for (const home of [a, b])
    expect(await storeOf(home, keychain).read()).toEqual({
      state: "lost",
      membership: null,
      app: APP,
      protection: "keychain",
      why: "unopened",
    });

  const c = folder();
  await storeOf(c, keychain).write(APP, KEY);
  const moved = join(folder(), "moved");
  renameSync(c, moved);
  expect(await storeOf(moved, keychain).read()).toEqual({
    state: "kept",
    membership: null,
    app: APP,
    privateKey: KEY,
    protection: "keychain",
  });
});

test("the key is sealed to the App's id: a record whose id was changed doesn't open it", async () => {
  const home = folder();
  const keychain = memoryKeychain();
  await storeOf(home, keychain).write(APP, KEY);
  const file = join(home, "github", "app.json");
  writeFileSync(file, readFileSync(file, "utf8").replace('"id": 4242', '"id": 4243'));
  expect(await storeOf(home, keychain).read()).toMatchObject({
    state: "lost",
    membership: null,
    app: { id: 4243 },
    why: "unopened",
  });
});

test("a deleted keychain entry, or a removed key file, reads as a lost key", async () => {
  const keychain = memoryKeychain();
  const home = folder();
  await storeOf(home, keychain).write(APP, KEY);
  for (const name of keychain.names()) await keychain.delete(name);
  expect(await storeOf(home, keychain).read()).toEqual({
    state: "lost",
    membership: null,
    app: APP,
    protection: "keychain",
    why: "gone",
  });

  const other = folder();
  await storeOf(other, keychain).write(APP, KEY);
  const [entry] = keychain.names(); // The first folder's entry was deleted above.
  rmSync(join(other, "github", sealedFile(entry)));
  expect(await storeOf(other, keychain).read()).toMatchObject({ state: "lost", why: "gone" });
});

test("a keychain that doesn't answer in time keeps the key in the user-only file, and the store says so", async () => {
  const home = folder();
  const store = storeOf(home, boundedKeychain(SILENT, PASSED));
  expect(await store.write(APP, KEY)).toEqual({ protection: "user-file" });
  const read = await store.read();
  expect(read).toEqual({
    state: "kept",
    membership: null,
    app: APP,
    privateKey: KEY,
    protection: "user-file",
    fallback: expect.stringMatching(PEM),
  });
  expect(readFileSync(join(home, "github", nameOf(read)), "utf8")).toBe(KEY);
  expect(filesIn(home)).toEqual(["app.json", nameOf(read)].sort());
});

test("a keychain that refuses keeps the key in the file too; one that stops answering leaves the sealed key unopened for now", async () => {
  const home = folder();
  expect(await storeOf(home, memoryKeychain({ refuse: true })).write(APP, KEY)).toEqual({
    protection: "user-file",
  });

  const sealed = folder();
  await storeOf(sealed, memoryKeychain()).write(APP, KEY);
  expect(await storeOf(sealed, boundedKeychain(SILENT, PASSED)).read()).toEqual({
    state: "lost",
    membership: null,
    app: APP,
    protection: "keychain",
    why: "keychain",
  });
});

test("a new key for the App replaces the old one: the old entry, its file and the unencrypted file go", async () => {
  const home = folder();
  const keychain = memoryKeychain();
  await storeOf(home, memoryKeychain({ refuse: true })).write(APP, KEY);
  await storeOf(home, keychain).write(APP, KEY);
  const [first] = keychain.names();
  expect(filesIn(home)).toEqual(["app.json", sealedFile(first)]);
  await storeOf(home, keychain).write(APP, "the new key\n");
  const [second] = keychain.names();
  expect(keychain.names()).toHaveLength(1);
  expect(second).not.toBe(first);
  expect(filesIn(home)).toEqual(["app.json", sealedFile(second)]);
  expect(await storeOf(home, keychain).read()).toMatchObject({
    state: "kept",
    membership: null,
    privateKey: "the new key\n",
  });
});

test("a write cut off before its record lands leaves the App before it, its key still opening", async () => {
  const home = folder();
  const held = memoryKeychain();
  await storeOf(home, held).write(APP, KEY);
  const reached = Promise.withResolvers<void>();
  const stuck: Keychain = {
    ...held,
    set: () => {
      reached.resolve();
      return never();
    },
  };
  void storeOf(home, stuck).write({ ...APP, id: 9999 }, "the new key\n");
  await reached.promise;
  expect(filesIn(home).filter((name) => name.endsWith(".key"))).toHaveLength(2);
  expect(await storeOf(home, held).read()).toEqual({
    state: "kept",
    membership: null,
    app: APP,
    privateKey: KEY,
    protection: "keychain",
  });
});

test("a write cut off after its record lands opens the new key; the next write removes what it left", async () => {
  const home = folder();
  const held = memoryKeychain();
  await storeOf(home, held).write(APP, KEY);
  const reached = Promise.withResolvers<void>();
  const stuck: Keychain = {
    ...held,
    delete: () => {
      reached.resolve();
      return never();
    },
  };
  void storeOf(home, stuck).write(APP, "the new key\n");
  await reached.promise;
  expect(await storeOf(home, held).read()).toMatchObject({
    state: "kept",
    membership: null,
    privateKey: "the new key\n",
  });
  expect(held.names()).toHaveLength(2);

  await storeOf(home, held).write(APP, "a third key\n");
  const [left] = held.names();
  expect(held.names()).toHaveLength(1);
  expect(filesIn(home)).toEqual(["app.json", sealedFile(left)]);
});

test("writes to one data folder take turns: one that overlaps a write paused at the keychain loses no key", async () => {
  const home = folder();
  const held = memoryKeychain();
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let paused = false;
  const pausing: Keychain = {
    ...held,
    set: async (name, value) => {
      if (!paused) {
        paused = true;
        reached.resolve();
        await release.promise;
      }
      return held.set(name, value);
    },
  };
  const store = storeOf(home, pausing);
  const first = store.write({ ...APP, id: 9999 }, "the first key\n");
  await reached.promise;
  const second = store.write(APP, KEY);
  await Promise.race([second, Bun.sleep(50)]); // Time for the second to finish, were it not waiting its turn.
  release.resolve();
  await Promise.all([first, second]);
  expect(await store.read()).toEqual({
    state: "kept",
    app: APP,
    privateKey: KEY,
    membership: null,
    protection: "keychain",
  });
  const [entry] = held.names();
  expect(held.names()).toHaveLength(1);
  expect(filesIn(home)).toEqual(["app.json", sealedFile(entry)]);
});

test("a write to the unencrypted file cut off before its record lands leaves the App before it; the next write removes what it left", async () => {
  const home = folder();
  const refusing = memoryKeychain({ refuse: true });
  await storeOf(home, refusing).write(APP, KEY);
  const [before] = filesIn(home).filter((name) => name.endsWith(".pem"));
  const reached = Promise.withResolvers<void>();
  const stopping = appStore({
    home,
    keychain: refusing,
    userOnly: (path) => {
      if (!basename(path).startsWith("app.json.")) return userOnly(path);
      reached.resolve(); // The new key's file is in place; the record never lands.
      return never();
    },
  });
  void stopping.write({ ...APP, id: 9999 }, "the new key\n");
  await reached.promise;
  expect(filesIn(home).filter((name) => name.endsWith(".pem"))).toHaveLength(2);
  expect(await storeOf(home, refusing).read()).toEqual({
    state: "kept",
    membership: null,
    app: APP,
    privateKey: KEY,
    protection: "user-file",
    fallback: `github/${before}`,
  });

  await storeOf(home, refusing).write(APP, "a third key\n");
  const read = await storeOf(home, refusing).read();
  expect(read).toMatchObject({ state: "kept", privateKey: "a third key\n", protection: "user-file" });
  expect(filesIn(home)).toEqual(["app.json", nameOf(read)].sort());
});

test("a write to the unencrypted file cut off after its record lands opens the new key; the next write removes what it left", async () => {
  const home = folder();
  const held = memoryKeychain();
  await storeOf(home, held).write(APP, KEY);
  const reached = Promise.withResolvers<void>();
  const stuck: Keychain = {
    get: held.get,
    set: () => Promise.reject(new KeychainUnavailable("refused")),
    delete: () => {
      reached.resolve(); // The record has landed; the former entry is never removed.
      return never();
    },
  };
  void storeOf(home, stuck).write(APP, "the new key\n");
  await reached.promise;
  expect(await storeOf(home, held).read()).toMatchObject({
    state: "kept",
    membership: null,
    privateKey: "the new key\n",
    protection: "user-file",
  });

  await storeOf(home, held).write(APP, "a third key\n");
  const [left] = held.names();
  expect(held.names()).toHaveLength(1);
  expect(filesIn(home)).toEqual(["app.json", sealedFile(left)]);
});

test("a record that can't be written leaves what was there before: no key file, no keychain entry, no temporary file", async () => {
  const home = folder();
  const held = memoryKeychain();
  const blocking: Keychain = {
    ...held,
    set: (name, value) => {
      mkdirSync(join(home, "github", "app.json")); // The record can't be renamed onto a folder.
      return held.set(name, value);
    },
  };
  await expect(storeOf(home, blocking).write(APP, KEY)).rejects.toThrow();
  expect(filesIn(home)).toEqual(["app.json"]);
  expect(held.names()).toEqual([]);
});

test("a record that can't be read stops the write; one Lookover didn't write is replaced", async () => {
  const home = folder();
  const keychain = memoryKeychain();
  mkdirSync(join(home, "github", "app.json"), { recursive: true });
  await expect(storeOf(home, keychain).write(APP, KEY)).rejects.toMatchObject({ code: "EISDIR" });
  expect(filesIn(home)).toEqual(["app.json"]);
  expect(keychain.names()).toEqual([]);

  const other = folder();
  mkdirSync(join(other, "github"));
  writeFileSync(join(other, "github", "app.json"), "not json");
  await expect(storeOf(other, keychain).read()).rejects.toThrow("is not an App Lookover wrote");
  await storeOf(other, keychain).write(APP, KEY);
  expect(await storeOf(other, keychain).read()).toMatchObject({ state: "kept", privateKey: KEY });
});

test("the keychain entry's name is random, and starts lookover-dev- for a data folder under .dev", async () => {
  const keychain = memoryKeychain();
  const dev = join(folder(), ".dev", "data-live");
  mkdirSync(dev, { recursive: true });
  await storeOf(dev, keychain).write(APP, KEY);
  await storeOf(folder(), keychain).write(APP, KEY);
  const [inDev, elsewhere] = keychain.names();
  expect(inDev).toMatch(/^lookover-dev-[0-9a-f]{24}$/);
  expect(elsewhere).toMatch(/^lookover-[0-9a-f]{24}$/);
  expect(JSON.parse(readFileSync(join(dev, "github", "app.json"), "utf8"))).toEqual({
    ...APP,
    key: { kept: "keychain", entry: inDev },
  });
});

test("on Windows, where a folder's name has no case, .DEV is .dev too", async () => {
  const keychain = memoryKeychain();
  const dev = join(folder(), ".DEV", "data-live");
  mkdirSync(dev, { recursive: true });
  await storeOf(dev, keychain).write(APP, KEY);
  expect(keychain.names()[0]).toMatch(
    process.platform === "win32" ? /^lookover-dev-[0-9a-f]{24}$/ : /^lookover-[0-9a-f]{24}$/,
  );
});
